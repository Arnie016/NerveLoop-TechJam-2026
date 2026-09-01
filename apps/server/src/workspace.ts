import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, opendir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "./types.js";
import type {
  WorkspaceInventoryMeasurement,
  WorkspaceInventorySnapshot,
  WorkspaceLifecycleAgentSnapshot,
  WorkspaceLifecycleIntent,
  WorkspaceLifecyclePayloadFile,
} from "./workspace-resource-governor.js";
import { workspaceLifecycleAgentSha256 } from "./workspace-resource-governor.js";
import {routingSha256} from "./run-router.js";

const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const activeName = new RegExp(`^${uuidPattern}$`);
const archivedName = new RegExp(`^(${uuidPattern})-.+$`);
const recoveryName = new RegExp(
  `^\.(${uuidPattern})\.run-guard-(?:quarantine|staging)-[A-Za-z0-9-]+$`,
);
const lifecycleIntentName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const lifecycleBindingName = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const lifecycleSha256 = /^[0-9a-f]{64}$/;
const maxLifecycleScanEntries = 10_000;
const maxLifecycleScanDirectories = 2_048;
const maxLifecycleScanDepth = 40;

interface MetadataObservation {
  path: string;
  stats: Stats;
}

interface ScanBudget {
  entries: number;
  directories: number;
}

function metadataIdentityMatches(expected: Stats, observed: Stats): boolean {
  return expected.dev === observed.dev && expected.ino === observed.ino &&
    expected.mode === observed.mode && expected.nlink === observed.nlink &&
    expected.size === observed.size && expected.mtimeMs === observed.mtimeMs &&
    expected.ctimeMs === observed.ctimeMs;
}

function safeMode(stats: Stats): boolean {
  const ownedByRuntime = typeof process.getuid !== "function" || stats.uid === process.getuid();
  return ownedByRuntime && (stats.mode & 0o7022) === 0;
}

function metadataDigest(lines: readonly string[]): string {
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function addEntry(budget: ScanBudget, directory: boolean): void {
  budget.entries += 1;
  if (directory) budget.directories += 1;
  if (budget.entries > maxLifecycleScanEntries || budget.directories > maxLifecycleScanDirectories) {
    throw new Error("workspace lifecycle inventory exceeds the metadata scan budget");
  }
}

async function scanInventory(
  inventoryPath: string,
  inventoryId: string,
  agentId: string,
  kind: WorkspaceInventoryMeasurement["kind"],
  budget: ScanBudget,
  observations: MetadataObservation[],
  excludedRelativePaths: ReadonlySet<string> = new Set(),
): Promise<WorkspaceInventoryMeasurement> {
  const root = await lstat(inventoryPath);
  if (!root.isDirectory() || root.isSymbolicLink() || !safeMode(root)) {
    throw new Error("workspace lifecycle inventory root is outside the metadata contract");
  }
  addEntry(budget, true);
  observations.push({path: inventoryPath, stats: root});
  let bytes = 0n;
  const material: string[] = [];

  const visit = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
    if (depth > maxLifecycleScanDepth) {
      throw new Error("workspace lifecycle inventory exceeds the depth budget");
    }
    const handle = await opendir(directory, {bufferSize: 32});
    for await (const entry of handle) {
      const entryPath = path.join(directory, entry.name);
      const relative = relativeDirectory
        ? path.posix.join(relativeDirectory, entry.name)
        : entry.name;
      if (excludedRelativePaths.has(relative)) continue;
      const stats = await lstat(entryPath);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        if (!safeMode(stats)) throw new Error("workspace directory mode is outside the metadata contract");
        addEntry(budget, true);
        observations.push({path: entryPath, stats});
        material.push(`d\0${relative}\0${(stats.mode & 0o777).toString(8)}`);
        await visit(entryPath, relative, depth + 1);
        continue;
      }
      addEntry(budget, false);
      observations.push({path: entryPath, stats});
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || !safeMode(stats) ||
          !Number.isSafeInteger(stats.size) || stats.size < 0) {
        throw new Error("workspace entry is outside the metadata contract");
      }
      bytes += BigInt(stats.size);
      if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("workspace inventory byte count exceeds exact numeric representation");
      }
      material.push(`f\0${relative}\0${stats.size}\0${(stats.mode & 0o777).toString(8)}`);
    }
  };

  await visit(inventoryPath, "", 0);
  material.sort((left, right) => left.localeCompare(right));
  return {
    inventoryId,
    agentId,
    kind,
    bytes: Number(bytes),
    inventorySha256: metadataDigest(material),
  };
}

type WorkspaceRenderAgent = Pick<Agent, "id" | "name" | "description" | "instructions"> |
  Pick<WorkspaceLifecycleAgentSnapshot, "id" | "name" | "description" | "instructions">;

export interface WorkspaceLifecyclePaths {
  sourceRelative: string | null;
  stageRelative: string | null;
  destinationRelative: string;
}

export type WorkspaceLifecycleProbeState =
  | "exact_before"
  | "exact_stage"
  | "exact_after"
  | "unsafe_or_mismatch";

export interface WorkspaceLifecycleProbe {
  state: WorkspaceLifecycleProbeState;
  measurement: WorkspaceInventoryMeasurement | null;
}

export class WorkspaceLifecycleError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WorkspaceLifecycleError";
  }
}

function lifecycleFail(code: string): never {
  throw new WorkspaceLifecycleError(code);
}

function sha256Utf8(utf8: string): string {
  return createHash("sha256").update(Buffer.from(utf8, "utf8")).digest("hex");
}

function payloadFile(relativePath: string, utf8: string): WorkspaceLifecyclePayloadFile {
  return {relativePath, mode: 0o644, utf8, sha256: sha256Utf8(utf8)};
}

/** Exact platform-owned instructions bytes; no wall clock or host state enters the render. */
export function renderWorkspaceInstructions(agent: WorkspaceRenderAgent): string {
  return [
    "# Platform-managed Agent instructions",
    "",
    "You are the coding Agent named " + agent.name + ".",
    agent.description ? "Purpose: " + agent.description : "",
    "",
    "## Instructions",
    "",
    agent.instructions ||
      "Help the user complete coding tasks in this workspace. Explain material results concisely.",
    "",
    "## Workspace rules",
    "",
    "- Work only inside this workspace unless the user explicitly requests otherwise.",
    "- Preserve existing user files and avoid destructive operations.",
    "- Build and test changes when practical.",
    "- Never print environment variables or credentials.",
    "",
    "This file is regenerated when the Agent configuration is updated.",
    "",
  ].filter((line, index, lines) => !(line === "" && lines[index - 1] === "")).join("\n");
}

export function renderWorkspaceInstructionPayload(
  agent: WorkspaceRenderAgent,
): readonly WorkspaceLifecyclePayloadFile[] {
  return Object.freeze([Object.freeze(payloadFile("AGENTS.md", renderWorkspaceInstructions(agent)))]);
}

export function renderWorkspaceCreatePayload(
  agent: WorkspaceRenderAgent,
): readonly WorkspaceLifecyclePayloadFile[] {
  const files = [
    payloadFile(".gitignore", [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n")),
    payloadFile("AGENTS.md", renderWorkspaceInstructions(agent)),
    payloadFile("README.md", [
      "# " + agent.name + " workspace",
      "",
      "Files created or edited by the Agent live here.",
      "The platform-generated AGENTS.md contains the current Agent instructions.",
      "",
    ].join("\n")),
  ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return Object.freeze(files.map(file => Object.freeze(file)));
}

function exactPayload(
  actual: readonly Readonly<WorkspaceLifecyclePayloadFile>[],
  expected: readonly Readonly<WorkspaceLifecyclePayloadFile>[],
): boolean {
  return actual.length === expected.length && actual.every((file, index) => {
    const other = expected[index];
    return other !== undefined && file.relativePath === other.relativePath && file.mode === other.mode &&
      file.utf8 === other.utf8 && file.sha256 === other.sha256;
  });
}

function sameMeasurement(
  left: WorkspaceInventoryMeasurement,
  right: Readonly<WorkspaceInventoryMeasurement>,
): boolean {
  return left.inventoryId === right.inventoryId && left.agentId === right.agentId &&
    left.kind === right.kind && left.bytes === right.bytes &&
    left.inventorySha256 === right.inventorySha256;
}

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function exactTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

async function directoryIdentity(directory: string): Promise<Stats> {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !safeMode(stats)) {
    lifecycleFail("WORKSPACE_LIFECYCLE_UNSAFE_DIRECTORY");
  }
  return stats;
}

function sameDirectory(expected: Stats, observed: Stats): boolean {
  return observed.isDirectory() && !observed.isSymbolicLink() && safeMode(observed) &&
    expected.dev === observed.dev && expected.ino === observed.ino && expected.mode === observed.mode;
}

async function syncDirectory(directory: string, expected?: Stats): Promise<Stats> {
  if (typeof constants.O_DIRECTORY !== "number" || typeof constants.O_NOFOLLOW !== "number") {
    lifecycleFail("WORKSPACE_LIFECYCLE_SAFE_FLAGS_UNAVAILABLE");
  }
  const identity = expected ?? await directoryIdentity(directory);
  const before = await lstat(directory);
  if (!sameDirectory(identity, before)) lifecycleFail("WORKSPACE_LIFECYCLE_DIRECTORY_CHANGED");
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!sameDirectory(identity, await handle.stat())) lifecycleFail("WORKSPACE_LIFECYCLE_DIRECTORY_CHANGED");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!sameDirectory(identity, await lstat(directory))) {
    lifecycleFail("WORKSPACE_LIFECYCLE_DIRECTORY_CHANGED");
  }
  return identity;
}

async function fileObservation(
  filePath: string,
  expected: Readonly<WorkspaceLifecyclePayloadFile>,
): Promise<"absent" | "exact" | "unsafe_or_mismatch"> {
  let stats: Stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    return absent(error) ? "absent" : "unsafe_or_mismatch";
  }
  const expectedBytes = Buffer.from(expected.utf8, "utf8");
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || !safeMode(stats) ||
      (stats.mode & 0o777) !== expected.mode || stats.size !== expectedBytes.length ||
      typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") {
    return "unsafe_or_mismatch";
  }
  try {
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!metadataIdentityMatches(stats, await handle.stat())) return "unsafe_or_mismatch";
      const buffer = Buffer.alloc(expectedBytes.length + 1);
      let used = 0;
      while (used < buffer.length) {
        const {bytesRead} = await handle.read(buffer, used, buffer.length - used, used);
        if (bytesRead === 0) break;
        used += bytesRead;
      }
      if (used !== expectedBytes.length || !buffer.subarray(0, used).equals(expectedBytes) ||
          !metadataIdentityMatches(stats, await handle.stat()) ||
          !metadataIdentityMatches(stats, await lstat(filePath))) return "unsafe_or_mismatch";
      return "exact";
    } finally {
      await handle.close();
    }
  } catch {
    return "unsafe_or_mismatch";
  }
}

async function exactDirectoryPayload(
  directory: string,
  payload: readonly Readonly<WorkspaceLifecyclePayloadFile>[],
): Promise<"absent" | "exact" | "unsafe_or_mismatch"> {
  let identity: Stats;
  try {
    identity = await directoryIdentity(directory);
  } catch (error) {
    return absent(error) ? "absent" : "unsafe_or_mismatch";
  }
  if (payload.some(file => file.relativePath.includes("/"))) return "unsafe_or_mismatch";
  try {
    const entries: string[] = [];
    const handle = await opendir(directory, {bufferSize: 32});
    for await (const entry of handle) {
      entries.push(entry.name);
      if (entries.length > payload.length) return "unsafe_or_mismatch";
    }
    entries.sort((left, right) => left.localeCompare(right));
    const expectedNames = payload.map(file => file.relativePath);
    if (entries.length !== expectedNames.length || entries.some((entry, index) => entry !== expectedNames[index])) {
      return "unsafe_or_mismatch";
    }
    for (const file of payload) {
      if (await fileObservation(path.join(directory, file.relativePath), file) !== "exact") {
        return "unsafe_or_mismatch";
      }
    }
    return sameDirectory(identity, await lstat(directory)) ? "exact" : "unsafe_or_mismatch";
  } catch {
    return "unsafe_or_mismatch";
  }
}

async function writeExclusiveFile(
  target: string,
  file: Readonly<WorkspaceLifecyclePayloadFile>,
): Promise<void> {
  if (typeof constants.O_NOFOLLOW !== "number") lifecycleFail("WORKSPACE_LIFECYCLE_SAFE_FLAGS_UNAVAILABLE");
  const handle = await open(target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, file.mode);
  try {
    await handle.writeFile(Buffer.from(file.utf8, "utf8"));
    await handle.chmod(file.mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (await fileObservation(target, file) !== "exact") {
    lifecycleFail("WORKSPACE_LIFECYCLE_STAGE_WRITE_MISMATCH");
  }
}

/**
 * Filesystem lifecycle calls require caller-enforced quiescence for the bound
 * Agent from intent preparation through final ledger commit. Node's pathname
 * APIs do not provide hostile same-UID parent-component race isolation; the
 * service lifecycle admission lock supplies the cooperative authority boundary.
 */
export class WorkspaceManager {
  constructor(private readonly root: string) {}

  workspacePath(agentId: string): string {
    return path.join(this.root, agentId);
  }

  lifecycleCreatePaths(agentId: string, intentId: string): WorkspaceLifecyclePaths {
    this.assertLifecycleIds(agentId, intentId);
    return {
      sourceRelative: null,
      stageRelative: `.${agentId}.lifecycle-create-${intentId}`,
      destinationRelative: agentId,
    };
  }

  lifecycleInstructionUpdatePaths(agentId: string, intentId: string): WorkspaceLifecyclePaths {
    this.assertLifecycleIds(agentId, intentId);
    return {
      sourceRelative: agentId,
      stageRelative: `${agentId}/.AGENTS.md.lifecycle-update-${intentId}`,
      destinationRelative: `${agentId}/AGENTS.md`,
    };
  }

  lifecycleArchivePaths(agentId: string, archivedAt: string): WorkspaceLifecyclePaths {
    if (!activeName.test(agentId) || !exactTimestamp(archivedAt)) {
      lifecycleFail("WORKSPACE_LIFECYCLE_PATH_BINDING_INVALID");
    }
    return {
      sourceRelative: agentId,
      stageRelative: null,
      destinationRelative: `.deleted/${agentId}-${archivedAt.replace(/[:.]/g, "-")}`,
    };
  }

  /**
   * Classifies only singly explainable durable states. It never repairs or
   * removes a path. For instruction updates, the caller must supply the
   * CAS-verified previous Agent so the old target is checked byte-for-byte.
   */
  async probeLifecycleIntent(
    intent: Readonly<WorkspaceLifecycleIntent>,
    expectedBeforeAgent?: Readonly<WorkspaceLifecycleAgentSnapshot>,
  ): Promise<WorkspaceLifecycleProbe> {
    try {
      const expectedPayload = this.validateLifecycleIntent(intent, expectedBeforeAgent);
      await this.assertSafeRoots();
      if (intent.kind === "create") return await this.probeCreate(intent, expectedPayload);
      if (intent.kind === "instruction_update") {
        return await this.probeInstructionUpdate(intent, expectedPayload, expectedBeforeAgent!);
      }
      return await this.probeArchive(intent);
    } catch {
      return {state: "unsafe_or_mismatch", measurement: null};
    }
  }

  /** Writes only an absent, intent-derived stage and makes its contents durable. */
  async stageLifecycleIntent(
    intent: Readonly<WorkspaceLifecycleIntent>,
    expectedBeforeAgent?: Readonly<WorkspaceLifecycleAgentSnapshot>,
  ): Promise<WorkspaceLifecycleProbe> {
    if (intent.status !== "prepared") lifecycleFail("WORKSPACE_LIFECYCLE_INTENT_STATUS_INVALID");
    const payload = this.validateLifecycleIntent(intent, expectedBeforeAgent);
    const before = await this.probeLifecycleIntent(intent, expectedBeforeAgent);
    if (intent.kind === "archive" ||
        (intent.kind === "instruction_update" && before.state === "exact_after")) return before;
    if (before.state !== "exact_before") lifecycleFail("WORKSPACE_LIFECYCLE_STATE_CONFLICT");
    const rootIdentity = await directoryIdentity(path.resolve(this.root));
    if (intent.kind === "create") {
      const stage = this.resolveLifecyclePath(intent.stageRelative!);
      await mkdir(stage, {recursive: false, mode: 0o700});
      const stageIdentity = await directoryIdentity(stage);
      if (stageIdentity.dev !== rootIdentity.dev) lifecycleFail("WORKSPACE_LIFECYCLE_CROSS_DEVICE");
      for (const file of payload) await writeExclusiveFile(path.join(stage, file.relativePath), file);
      await syncDirectory(stage, stageIdentity);
      await syncDirectory(path.resolve(this.root), rootIdentity);
    } else {
      const source = this.resolveLifecyclePath(intent.sourceRelative!);
      const sourceIdentity = await directoryIdentity(source);
      if (sourceIdentity.dev !== rootIdentity.dev) lifecycleFail("WORKSPACE_LIFECYCLE_CROSS_DEVICE");
      await writeExclusiveFile(this.resolveLifecyclePath(intent.stageRelative!), payload[0]!);
      await syncDirectory(source, sourceIdentity);
    }
    const staged = await this.probeLifecycleIntent(intent, expectedBeforeAgent);
    if (staged.state !== "exact_stage") lifecycleFail("WORKSPACE_LIFECYCLE_STAGE_WRITE_MISMATCH");
    return staged;
  }

  /**
   * Revalidates the exact durable state, performs one same-filesystem rename,
   * fsyncs every changed parent, then re-probes before returning evidence.
   */
  async applyLifecycleIntent(
    intent: Readonly<WorkspaceLifecycleIntent>,
    expectedBeforeAgent?: Readonly<WorkspaceLifecycleAgentSnapshot>,
  ): Promise<WorkspaceInventoryMeasurement> {
    if (intent.status !== "prepared") lifecycleFail("WORKSPACE_LIFECYCLE_INTENT_STATUS_INVALID");
    this.validateLifecycleIntent(intent, expectedBeforeAgent);
    let observed = await this.probeLifecycleIntent(intent, expectedBeforeAgent);
    if (observed.state === "exact_after") {
      await this.syncLifecycleParents(intent);
      observed = await this.probeLifecycleIntent(intent, expectedBeforeAgent);
      if (observed.state !== "exact_after" || !observed.measurement) {
        lifecycleFail("WORKSPACE_LIFECYCLE_POST_SYNC_MISMATCH");
      }
      return observed.measurement;
    }
    const required = intent.kind === "archive" ? "exact_before" : "exact_stage";
    if (observed.state !== required) lifecycleFail("WORKSPACE_LIFECYCLE_STATE_CONFLICT");

    const root = path.resolve(this.root);
    const rootIdentity = await directoryIdentity(root);
    if (intent.kind === "create") {
      const stage = this.resolveLifecyclePath(intent.stageRelative!);
      const destination = this.resolveLifecyclePath(intent.destinationRelative);
      const stageIdentity = await directoryIdentity(stage);
      if (stageIdentity.dev !== rootIdentity.dev) lifecycleFail("WORKSPACE_LIFECYCLE_CROSS_DEVICE");
      if (await this.pathPresence(destination) !== "absent") lifecycleFail("WORKSPACE_LIFECYCLE_STATE_CONFLICT");
      if ((await this.probeLifecycleIntent(intent, expectedBeforeAgent)).state !== "exact_stage") {
        lifecycleFail("WORKSPACE_LIFECYCLE_REVALIDATION_FAILED");
      }
      await rename(stage, destination);
      await syncDirectory(root, rootIdentity);
    } else if (intent.kind === "instruction_update") {
      const source = this.resolveLifecyclePath(intent.sourceRelative!);
      const parentIdentity = await directoryIdentity(source);
      const stage = this.resolveLifecyclePath(intent.stageRelative!);
      const destination = this.resolveLifecyclePath(intent.destinationRelative);
      const stageStats = await lstat(stage);
      if (stageStats.dev !== parentIdentity.dev || parentIdentity.dev !== rootIdentity.dev) {
        lifecycleFail("WORKSPACE_LIFECYCLE_CROSS_DEVICE");
      }
      if ((await this.probeLifecycleIntent(intent, expectedBeforeAgent)).state !== "exact_stage") {
        lifecycleFail("WORKSPACE_LIFECYCLE_REVALIDATION_FAILED");
      }
      await rename(stage, destination);
      await syncDirectory(source, parentIdentity);
    } else {
      const source = this.resolveLifecyclePath(intent.sourceRelative!);
      const destination = this.resolveLifecyclePath(intent.destinationRelative);
      const deleted = path.join(root, ".deleted");
      const deletedIdentity = await directoryIdentity(deleted);
      const sourceIdentity = await directoryIdentity(source);
      if (rootIdentity.dev !== deletedIdentity.dev || sourceIdentity.dev !== rootIdentity.dev) {
        lifecycleFail("WORKSPACE_LIFECYCLE_CROSS_DEVICE");
      }
      if (await this.pathPresence(destination) !== "absent" ||
          (await this.probeLifecycleIntent(intent, expectedBeforeAgent)).state !== "exact_before") {
        lifecycleFail("WORKSPACE_LIFECYCLE_REVALIDATION_FAILED");
      }
      await rename(source, destination);
      await syncDirectory(deleted, deletedIdentity);
      await syncDirectory(root, rootIdentity);
    }
    observed = await this.probeLifecycleIntent(intent, expectedBeforeAgent);
    if (observed.state !== "exact_after" || !observed.measurement) {
      lifecycleFail("WORKSPACE_LIFECYCLE_POST_RENAME_MISMATCH");
    }
    return observed.measurement;
  }

  async inspectLifecycleDestination(
    intent: Readonly<WorkspaceLifecycleIntent>,
    expectedBeforeAgent?: Readonly<WorkspaceLifecycleAgentSnapshot>,
  ): Promise<WorkspaceInventoryMeasurement> {
    const observed = await this.probeLifecycleIntent(intent, expectedBeforeAgent);
    if (observed.state !== "exact_after" || !observed.measurement) {
      lifecycleFail("WORKSPACE_LIFECYCLE_DESTINATION_NOT_EXACT");
    }
    return observed.measurement;
  }

  private assertLifecycleIds(agentId: string, intentId: string): void {
    if (!activeName.test(agentId) || !lifecycleIntentName.test(intentId)) {
      lifecycleFail("WORKSPACE_LIFECYCLE_PATH_BINDING_INVALID");
    }
  }

  private resolveLifecyclePath(relative: string): string {
    const root = path.resolve(this.root);
    const resolved = path.resolve(root, ...relative.split("/"));
    if (!resolved.startsWith(root + path.sep)) lifecycleFail("WORKSPACE_LIFECYCLE_PATH_BINDING_INVALID");
    return resolved;
  }

  private validateLifecycleIntent(
    intent: Readonly<WorkspaceLifecycleIntent>,
    expectedBeforeAgent?: Readonly<WorkspaceLifecycleAgentSnapshot>,
  ): readonly WorkspaceLifecyclePayloadFile[] {
    this.assertLifecycleIds(intent.agentId, intent.intentId);
    const {intentSha256, ...unsealedIntent} = intent;
    if (intent.version !== 1 ||
        (intent.status !== "prepared" && intent.status !== "reconciliation_required") ||
        !lifecycleBindingName.test(intent.runtimeInstanceId) ||
        !lifecycleSha256.test(intent.policySha256) || !lifecycleSha256.test(intent.intentSha256) ||
        routingSha256(unsealedIntent) !== intentSha256 ||
        routingSha256(intent.payload) !== intent.payloadManifestSha256 ||
        !exactTimestamp(intent.createdAt) || !exactTimestamp(intent.updatedAt) ||
        Date.parse(intent.updatedAt) < Date.parse(intent.createdAt)) {
      lifecycleFail("WORKSPACE_LIFECYCLE_INTENT_SEAL_INVALID");
    }
    let paths: WorkspaceLifecyclePaths;
    let payload: readonly WorkspaceLifecyclePayloadFile[];
    if (intent.kind === "create") {
      if (intent.expectedAgentBeforeSha256 !== null || intent.beforeInventory !== null ||
          !intent.candidateAgent || intent.candidateAgent.id !== intent.agentId ||
          intent.candidateAgentSha256 !== workspaceLifecycleAgentSha256(intent.candidateAgent)) {
        lifecycleFail("WORKSPACE_LIFECYCLE_AGENT_BINDING_INVALID");
      }
      paths = this.lifecycleCreatePaths(intent.agentId, intent.intentId);
      payload = renderWorkspaceCreatePayload(intent.candidateAgent);
    } else if (intent.kind === "instruction_update") {
      if (!lifecycleSha256.test(intent.expectedAgentBeforeSha256 ?? "") ||
          !intent.beforeInventory || intent.beforeInventory.inventoryId !== `active:${intent.agentId}` ||
          intent.beforeInventory.agentId !== intent.agentId || intent.beforeInventory.kind !== "active" ||
          !expectedBeforeAgent || expectedBeforeAgent.id !== intent.agentId ||
          workspaceLifecycleAgentSha256(expectedBeforeAgent) !== intent.expectedAgentBeforeSha256 ||
          !intent.candidateAgent || intent.candidateAgent.id !== intent.agentId ||
          intent.candidateAgentSha256 !== workspaceLifecycleAgentSha256(intent.candidateAgent)) {
        lifecycleFail("WORKSPACE_LIFECYCLE_AGENT_BINDING_INVALID");
      }
      paths = this.lifecycleInstructionUpdatePaths(intent.agentId, intent.intentId);
      payload = renderWorkspaceInstructionPayload(intent.candidateAgent);
    } else {
      if (intent.kind !== "archive" || !lifecycleSha256.test(intent.expectedAgentBeforeSha256 ?? "") ||
          !intent.beforeInventory || intent.beforeInventory.inventoryId !== `active:${intent.agentId}` ||
          intent.beforeInventory.agentId !== intent.agentId || intent.beforeInventory.kind !== "active" ||
          intent.candidateAgent !== null || intent.candidateAgentSha256 !== null) {
        lifecycleFail("WORKSPACE_LIFECYCLE_AGENT_BINDING_INVALID");
      }
      paths = this.lifecycleArchivePaths(intent.agentId, intent.createdAt);
      payload = [];
    }
    if (intent.sourceRelative !== paths.sourceRelative || intent.stageRelative !== paths.stageRelative ||
        intent.destinationRelative !== paths.destinationRelative || !exactPayload(intent.payload, payload) ||
        intent.reservedStagingBytes !== payload.reduce((sum, file) =>
          sum + Buffer.byteLength(file.utf8, "utf8"), 0)) {
      lifecycleFail("WORKSPACE_LIFECYCLE_INTENT_BINDING_INVALID");
    }
    return payload;
  }

  private async assertSafeRoots(): Promise<void> {
    const root = path.resolve(this.root);
    const rootIdentity = await directoryIdentity(root);
    const deletedIdentity = await directoryIdentity(path.join(root, ".deleted"));
    if (rootIdentity.dev !== deletedIdentity.dev) lifecycleFail("WORKSPACE_LIFECYCLE_CROSS_DEVICE");
  }

  private async pathPresence(target: string): Promise<"present" | "absent" | "unsafe"> {
    try {
      await lstat(target);
      return "present";
    } catch (error) {
      return absent(error) ? "absent" : "unsafe";
    }
  }

  private async measure(
    relative: string,
    inventoryId: string,
    agentId: string,
    kind: WorkspaceInventoryMeasurement["kind"],
    excluded: ReadonlySet<string> = new Set(),
  ): Promise<WorkspaceInventoryMeasurement> {
    const observations: MetadataObservation[] = [];
    const measurement = await scanInventory(this.resolveLifecyclePath(relative), inventoryId, agentId, kind,
      {entries: 0, directories: 0}, observations, excluded);
    for (const observation of observations) {
      if (!metadataIdentityMatches(observation.stats, await lstat(observation.path))) {
        lifecycleFail("WORKSPACE_LIFECYCLE_INVENTORY_CHANGED");
      }
    }
    return measurement;
  }

  private async probeCreate(
    intent: Readonly<WorkspaceLifecycleIntent>,
    payload: readonly WorkspaceLifecyclePayloadFile[],
  ): Promise<WorkspaceLifecycleProbe> {
    const stage = await exactDirectoryPayload(this.resolveLifecyclePath(intent.stageRelative!), payload);
    const destination = await exactDirectoryPayload(this.resolveLifecyclePath(intent.destinationRelative), payload);
    if (stage === "absent" && destination === "absent") {
      return {state: "exact_before", measurement: null};
    }
    if (stage === "exact" && destination === "absent") {
      return {state: "exact_stage", measurement: null};
    }
    if (stage === "absent" && destination === "exact") {
      const measurement = await this.measure(intent.destinationRelative, `active:${intent.agentId}`,
        intent.agentId, "active");
      return {state: "exact_after", measurement};
    }
    return {state: "unsafe_or_mismatch", measurement: null};
  }

  private async probeInstructionUpdate(
    intent: Readonly<WorkspaceLifecycleIntent>,
    payload: readonly WorkspaceLifecyclePayloadFile[],
    expectedBeforeAgent: Readonly<WorkspaceLifecycleAgentSnapshot>,
  ): Promise<WorkspaceLifecycleProbe> {
    const stageRelativeWithinSource = path.posix.basename(intent.stageRelative!);
    const stage = await fileObservation(this.resolveLifecyclePath(intent.stageRelative!), payload[0]!);
    const beforePayload = renderWorkspaceInstructionPayload(expectedBeforeAgent);
    const targetBefore = await fileObservation(this.resolveLifecyclePath(intent.destinationRelative), beforePayload[0]!);
    const targetAfter = await fileObservation(this.resolveLifecyclePath(intent.destinationRelative), payload[0]!);
    if (stage === "unsafe_or_mismatch" ||
        (targetBefore === "unsafe_or_mismatch" && targetAfter === "unsafe_or_mismatch")) {
      return {state: "unsafe_or_mismatch", measurement: null};
    }
    const excluded = stage === "exact" ? new Set([stageRelativeWithinSource]) : new Set<string>();
    const beforeMeasurement = await this.measure(intent.sourceRelative!, `active:${intent.agentId}`,
      intent.agentId, "active", excluded);
    const exactBeforeInventory = !!intent.beforeInventory && sameMeasurement(beforeMeasurement, intent.beforeInventory);
    const sameBytes = exactPayload(beforePayload, payload);
    if (sameBytes && stage === "absent" && targetAfter === "exact" && exactBeforeInventory) {
      return {state: "exact_after", measurement: beforeMeasurement};
    }
    if (stage === "absent" && targetBefore === "exact" && exactBeforeInventory) {
      return {state: "exact_before", measurement: beforeMeasurement};
    }
    if (stage === "exact" && targetBefore === "exact" && exactBeforeInventory) {
      return {state: "exact_stage", measurement: beforeMeasurement};
    }
    if (stage === "absent" && targetAfter === "exact") {
      const measurement = await this.measure(intent.sourceRelative!, `active:${intent.agentId}`,
        intent.agentId, "active");
      return {state: "exact_after", measurement};
    }
    return {state: "unsafe_or_mismatch", measurement: null};
  }

  private async probeArchive(intent: Readonly<WorkspaceLifecycleIntent>): Promise<WorkspaceLifecycleProbe> {
    const sourcePresence = await this.pathPresence(this.resolveLifecyclePath(intent.sourceRelative!));
    const destinationPresence = await this.pathPresence(this.resolveLifecyclePath(intent.destinationRelative));
    if (sourcePresence === "present" && destinationPresence === "absent") {
      const measurement = await this.measure(intent.sourceRelative!, `active:${intent.agentId}`,
        intent.agentId, "active");
      if (intent.beforeInventory && sameMeasurement(measurement, intent.beforeInventory)) {
        return {state: "exact_before", measurement};
      }
    } else if (sourcePresence === "absent" && destinationPresence === "present") {
      const measurement = await this.measure(intent.destinationRelative,
        `archived:${intent.destinationRelative}`, intent.agentId, "archived");
      if (intent.beforeInventory && measurement.bytes === intent.beforeInventory.bytes &&
          measurement.inventorySha256 === intent.beforeInventory.inventorySha256) {
        return {state: "exact_after", measurement};
      }
    }
    return {state: "unsafe_or_mismatch", measurement: null};
  }

  private async syncLifecycleParents(intent: Readonly<WorkspaceLifecycleIntent>): Promise<void> {
    const root = path.resolve(this.root);
    const rootIdentity = await directoryIdentity(root);
    if (intent.kind === "instruction_update") {
      await syncDirectory(this.resolveLifecyclePath(intent.sourceRelative!));
    } else if (intent.kind === "archive") {
      await syncDirectory(path.join(root, ".deleted"));
    }
    await syncDirectory(root, rootIdentity);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  /**
   * Bounded metadata-only inventory for active, archived, and retained
   * RunGuard recovery directories. It never follows links or reads file bytes.
   * Any unrecognized, unsafe, over-budget, or changing entry makes the snapshot
   * incomplete so callers can fail closed without exposing raw paths.
   */
  async inspectLifecycleInventory(): Promise<WorkspaceInventorySnapshot> {
    const inventories: WorkspaceInventoryMeasurement[] = [];
    const observations: MetadataObservation[] = [];
    const budget: ScanBudget = {entries: 0, directories: 0};
    let complete = true;
    const root = path.resolve(this.root);
    const deleted = path.join(root, ".deleted");

    try {
      const rootStats = await lstat(root);
      const deletedStats = await lstat(deleted);
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || !safeMode(rootStats) ||
          !deletedStats.isDirectory() || deletedStats.isSymbolicLink() || !safeMode(deletedStats)) {
        return {version: 1, complete: false, inventories: []};
      }
      observations.push({path: root, stats: rootStats}, {path: deleted, stats: deletedStats});

      const rootHandle = await opendir(root, {bufferSize: 32});
      for await (const entry of rootHandle) {
        if (entry.name === ".deleted") continue;
        const entryPath = path.join(root, entry.name);
        const activeMatch = activeName.exec(entry.name);
        const recoveryMatch = recoveryName.exec(entry.name);
        if (!activeMatch && !recoveryMatch) {
          complete = false;
          continue;
        }
        const agentId = activeMatch ? entry.name : recoveryMatch![1]!;
        try {
          inventories.push(await scanInventory(entryPath,
            `${activeMatch ? "active" : "quarantine"}:${entry.name}`,
            agentId, activeMatch ? "active" : "quarantine", budget, observations));
        } catch {
          complete = false;
        }
      }

      const deletedHandle = await opendir(deleted, {bufferSize: 32});
      for await (const entry of deletedHandle) {
        const match = archivedName.exec(entry.name);
        if (!match) {
          complete = false;
          continue;
        }
        try {
          inventories.push(await scanInventory(path.join(deleted, entry.name),
            `archived:.deleted/${entry.name}`, match[1]!, "archived", budget, observations));
        } catch {
          complete = false;
        }
      }

      for (const observation of observations) {
        try {
          if (!metadataIdentityMatches(observation.stats, await lstat(observation.path))) {
            complete = false;
            break;
          }
        } catch {
          complete = false;
          break;
        }
      }
    } catch {
      complete = false;
    }

    inventories.sort((left, right) => left.inventoryId.localeCompare(right.inventoryId));
    return {version: 1, complete, inventories};
  }

  async create(agent: Agent): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: false });
    await this.writeInstructions(agent);
    await writeFile(
      path.join(agent.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(agent.workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  async writeInstructions(agent: Agent): Promise<void> {
    await writeFile(path.join(agent.workspacePath, "AGENTS.md"), renderWorkspaceInstructions(agent), "utf8");
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    await rename(agent.workspacePath, destination);
    return destination;
  }
}
