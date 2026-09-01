import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, opendir, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import type { EffectPolicyDecision, RunGuardReceipt } from "./types.js";

interface WorkspaceFile {
  kind: "file" | "symlink";
  digest: string;
  contents: Buffer | null;
  mode: number | null;
}

interface WorkspaceCheckpoint {
  root: string;
  rootKind: "directory" | "symlink";
  digest: string;
  files: Map<string, WorkspaceFile>;
}

export interface RunGuardSession {
  receipt: RunGuardReceipt;
  before: WorkspaceCheckpoint | null;
}

const maxTrackedFiles = 1_000;
const maxTrackedFileBytes = 1_000_000;
const maxCheckpointBytes = 8_000_000;
const maxDescendantDirectories = 256;
const maxDirectoryDepth = 32; // Workspace root is depth zero.
const maxScannedEntries = maxTrackedFiles + maxDescendantDirectories;
const defaultCheckpointReadConcurrency = 4;

interface CheckpointRead {
  filePath: string;
  relativePath: string;
  entry: Stats;
}

function now(): string {
  return new Date().toISOString();
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isProtectedPath(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => {
    const normalized = segment.toLowerCase();
    return (
      normalized === ".env" ||
      normalized.startsWith(".env.") ||
      normalized.includes("secret") ||
      normalized.includes("credential") ||
      normalized === "id_rsa" ||
      normalized.endsWith(".pem") ||
      normalized.endsWith(".key")
    );
  });
}

function sameRegularFile(expected: Stats, observed: Stats): boolean {
  return observed.isFile() && observed.nlink === 1 &&
    observed.dev === expected.dev && observed.ino === expected.ino &&
    observed.mode === expected.mode &&
    observed.size === expected.size && observed.mtimeMs === expected.mtimeMs &&
    observed.ctimeMs === expected.ctimeMs;
}

async function readCheckpointFile(filePath: string, expected: Stats): Promise<Buffer> {
  if (!expected.isFile() || expected.nlink !== 1) {
    throw new Error("checkpoint requires a single-link regular file");
  }
  if ((expected.mode & 0o7000) !== 0) {
    throw new Error("special file permission bits are outside the checkpoint contract");
  }
  if (expected.size > maxTrackedFileBytes) {
    throw new Error("workspace file exceeds the RunGuard evidence budget");
  }
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") {
    throw new Error("safe checkpoint open flags are unavailable");
  }
  // A final-component symlink or FIFO swap must not redirect or hang a read.
  // Parent-directory races still require stronger OS-level isolation.
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameRegularFile(expected, await handle.stat())) {
      throw new Error("workspace entry changed before checkpoint read");
    }
    // Never use an unbounded readFile on a mutable inode. One extra byte detects
    // growth beyond the observed size without allocating an attacker-sized buffer.
    const buffer = Buffer.alloc(expected.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== expected.size || !sameRegularFile(expected, await handle.stat()) ||
        !sameRegularFile(expected, await lstat(filePath))) {
      throw new Error("workspace entry changed during checkpoint read");
    }
    return Buffer.from(buffer.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

async function snapshotWorkspace(
  workspacePath: string,
  options: { allowSymbolicLinks?: boolean; allowRootSymlink?: boolean; readConcurrency?: 1 | 4 } = {},
): Promise<WorkspaceCheckpoint> {
  const root = path.resolve(workspacePath);
  const rootEntry = await lstat(root);
  if (rootEntry.isSymbolicLink()) {
    if (!options.allowRootSymlink) {
      throw new Error("workspace root symbolic links are outside the RunGuard contract");
    }
    return {
      root,
      rootKind: "symlink",
      digest: digest("workspace-root-symlink"),
      files: new Map(),
    };
  }
  if (!rootEntry.isDirectory()) {
    throw new Error("workspace root is not a directory");
  }
  const files = new Map<string, WorkspaceFile>();
  let checkpointBytes = 0;
  let trackedFiles = 0;
  let directories = 0;
  let scannedEntries = 0;
  const pendingReads: CheckpointRead[] = [];
  const readConcurrency = options.readConcurrency ?? defaultCheckpointReadConcurrency;

  const flushReads = async (): Promise<void> => {
    const batch = pendingReads.splice(0);
    // Drain every admitted read, including descriptor closure, before propagating
    // a failure. Promise.all would let recovery race unfinished sibling reads.
    const results = await Promise.allSettled(batch.map(async ({ filePath, relativePath, entry }) => {
      const bytes = await readCheckpointFile(filePath, entry);
      const mode = entry.mode & 0o777;
      files.set(relativePath, {
        kind: "file", digest: digest("file\u0000" + mode.toString(8) + "\u0000" + digest(bytes)),
        contents: bytes, mode,
      });
    }));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };

  const visit = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
    // Stream a small batch rather than materializing an unbounded readdir array.
    // Async iteration closes the directory handle on completion or rejection.
    const entries = await opendir(directory, { bufferSize: 32 });
    for await (const entry of entries) {
      if (++scannedEntries > maxScannedEntries) {
        throw new Error("workspace traversal exceeds the RunGuard entry budget");
      }
      const filePath = path.join(directory, entry.name);
      const fileEntry = await lstat(filePath);
      const relativePath = relativeDirectory
        ? path.posix.join(relativeDirectory, entry.name)
        : entry.name;
      if (fileEntry.isDirectory()) {
        if (++directories > maxDescendantDirectories || depth + 1 > maxDirectoryDepth) {
          throw new Error("workspace directory count or depth exceeds the RunGuard traversal budget");
        }
        await visit(filePath, relativePath, depth + 1);
        continue;
      }
      if (++trackedFiles > maxTrackedFiles) {
        throw new Error("workspace entry count exceeds the RunGuard evidence budget");
      }
      if (fileEntry.isSymbolicLink()) {
        if (!options.allowSymbolicLinks) {
          throw new Error("symbolic links are outside the RunGuard workspace contract");
        }
        files.set(relativePath, {
          kind: "symlink",
          digest: digest("symlink\u0000" + relativePath),
          contents: null,
          mode: null,
        });
        continue;
      }
      if (!fileEntry.isFile() || fileEntry.nlink !== 1) {
        throw new Error("special files and hard links are outside the RunGuard workspace contract");
      }
      if (fileEntry.size > maxTrackedFileBytes) {
        throw new Error("workspace file exceeds the RunGuard evidence budget");
      }
      if (checkpointBytes + fileEntry.size > maxCheckpointBytes) {
        throw new Error("workspace checkpoint exceeds the RunGuard recovery budget");
      }
      // Reserve before queuing: completed-map size and post-read accounting are
      // unsafe budgets when several reads can be in flight. A failed read denies
      // the entire snapshot, so its reservation is never reused.
      checkpointBytes += fileEntry.size;
      pendingReads.push({ filePath, relativePath, entry: fileEntry });
      if (pendingReads.length === readConcurrency) await flushReads();
    }
  };

  await visit(root, "", 0);
  await flushReads();
  const material = [...files]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, file]) => relativePath + "\u0000" + file.digest)
    .join("\n");
  return { root, rootKind: "directory", digest: digest(material), files };
}

function changedPaths(before: WorkspaceCheckpoint, after: WorkspaceCheckpoint): string[] {
  const paths = new Set([...before.files.keys(), ...after.files.keys()]);
  return [...paths]
    .filter(
      (relativePath) => before.files.get(relativePath)?.digest !== after.files.get(relativePath)?.digest,
    )
    .sort((left, right) => left.localeCompare(right));
}

function workspaceTarget(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  if (target === root || !target.startsWith(root + path.sep)) {
    throw new Error("workspace recovery path escaped the Agent workspace");
  }
  return target;
}

async function removeEmptyParents(target: string, root: string): Promise<void> {
  let directory = path.dirname(target);
  while (directory !== root) {
    try {
      await rmdir(directory);
    } catch {
      return;
    }
    directory = path.dirname(directory);
  }
}

async function restoreCheckpoint(
  before: WorkspaceCheckpoint,
  after: WorkspaceCheckpoint,
  changed: string[],
  readConcurrency: 1 | 4,
): Promise<WorkspaceCheckpoint> {
  const recoveryPaths =
    after.rootKind === "symlink" ? [...before.files.keys()] : changed;
  if (after.rootKind === "symlink") {
    const rootEntry = await lstat(before.root);
    if (!rootEntry.isSymbolicLink()) {
      throw new Error("workspace recovery observed a changed root path");
    }
    await rm(before.root);
    await mkdir(before.root, { recursive: false });
  }

  for (const relativePath of recoveryPaths) {
    const target = workspaceTarget(before.root, relativePath);
    const baseline = before.files.get(relativePath);
    if (baseline) {
      const current = after.files.get(relativePath);
      if (current?.kind === "symlink") {
        const entry = await lstat(target);
        if (!entry.isSymbolicLink()) {
          throw new Error("workspace recovery observed a changed symlink path");
        }
        await rm(target);
      }
      await mkdir(path.dirname(target), { recursive: true });
      // Replace the entry, never mutate its inode: a late hard link must not
      // turn recovery into a write outside the workspace.
      const temporary = path.join(path.dirname(target), ".run-guard-restore-" + randomUUID());
      const handle = await open(temporary, "wx", 0o600);
      try {
        try {
          await handle.writeFile(baseline.contents!);
          await handle.chmod(baseline.mode!);
        } finally {
          await handle.close();
        }
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
      continue;
    }

    if (!after.files.has(relativePath)) continue;
    const entry = await lstat(target);
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      throw new Error("workspace recovery encountered a non-file path");
    }
    await rm(target);
    await removeEmptyParents(target, before.root);
  }

  const recovered = await snapshotWorkspace(before.root, { readConcurrency });
  if (recovered.digest !== before.digest) {
    throw new Error("workspace recovery did not restore the checkpoint");
  }
  return recovered;
}

async function replaceWorkspaceWithCheckpoint(
  before: WorkspaceCheckpoint,
  readConcurrency: 1 | 4,
): Promise<WorkspaceCheckpoint> {
  const parent = path.dirname(before.root);
  const workspaceName = path.basename(before.root);
  const suffix = randomUUID();
  const staging = path.join(parent, `.${workspaceName}.run-guard-staging-${suffix}`);
  const quarantine = path.join(parent, `.${workspaceName}.run-guard-quarantine-${suffix}`);
  let quarantined = false;

  try {
    await mkdir(staging, { recursive: false, mode: 0o700 });
    for (const [relativePath, file] of before.files) {
      const target = workspaceTarget(staging, relativePath);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const handle = await open(target, "wx", 0o600);
      try {
        await handle.writeFile(file.contents!);
        await handle.chmod(file.mode!);
      } finally {
        await handle.close();
      }
    }

    try {
      await rename(before.root, quarantine);
      quarantined = true;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    await rename(staging, before.root);
    const recovered = await snapshotWorkspace(before.root, { readConcurrency });
    if (recovered.digest !== before.digest) {
      throw new Error("workspace quarantine recovery did not restore the checkpoint");
    }
    return recovered;
  } catch (error) {
    if (quarantined) {
      try {
        await rename(quarantine, before.root);
      } catch {
        // Preserve the quarantined workspace for manual inspection if restoration also fails.
      }
    }
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export class RunGuard {
  private readonly readConcurrency: 1 | 4;

  constructor(
    private readonly sandboxMode: AppConfig["codexSandboxMode"],
    // Internal serial control for tests/benchmarks; not an HTTP/user setting.
    options: { checkpointReadConcurrency?: 1 | 4 } = {},
  ) {
    this.readConcurrency = options.checkpointReadConcurrency ?? defaultCheckpointReadConcurrency;
    if (this.readConcurrency !== 1 && this.readConcurrency !== 4) {
      throw new Error("checkpoint read concurrency must be 1 or 4");
    }
  }

  // Restart recovery may restore one journal-owned file, but only this fresh
  // full RunGuard scan can release the Agent against the persisted checkpoint.
  async inspectManifestDigest(workspacePath: string): Promise<string | null> {
    try {
      return (await snapshotWorkspace(workspacePath, { readConcurrency: this.readConcurrency })).digest;
    } catch {
      return null;
    }
  }

  async prepare(input: {
    agentId: string;
    runId: string;
    workspacePath: string;
  }): Promise<RunGuardSession> {
    const receipt: RunGuardReceipt = {
      version: 1,
      agentId: input.agentId,
      runId: input.runId,
      grantedScope: "agent-workspace-only",
      sandboxMode: this.sandboxMode,
      verdict: "pending",
      denialReason: null,
      beforeManifestDigest: null,
      afterManifestDigest: null,
      recoveredManifestDigest: null,
      recovery: "not_needed",
      changedFiles: [],
      events: [{ at: now(), kind: "grant_issued", detail: "workspace-only run grant issued" }],
    };

    if (this.sandboxMode !== "workspace-write") {
      receipt.verdict = "denied";
      receipt.denialReason = "RunGuard requires workspace-write sandbox mode";
      receipt.events.push({
        at: now(),
        kind: "grant_denied",
        detail: "sandbox mode cannot satisfy the workspace-only grant",
      });
      return { receipt, before: null };
    }

    try {
      const before = await snapshotWorkspace(input.workspacePath, { readConcurrency: this.readConcurrency });
      receipt.beforeManifestDigest = before.digest;
      return { receipt, before };
    } catch {
      receipt.verdict = "denied";
      receipt.denialReason = "RunGuard could not establish a safe workspace baseline";
      receipt.events.push({
        at: now(),
        kind: "grant_denied",
        detail: "workspace baseline could not be established; filesystem details were not retained",
      });
      return { receipt, before: null };
    }
  }

  async verify(session: RunGuardSession, workspacePath: string): Promise<RunGuardReceipt> {
    if (session.receipt.verdict === "denied" || !session.before) return session.receipt;
    try {
      const after = await snapshotWorkspace(workspacePath, {
        allowSymbolicLinks: true,
        allowRootSymlink: true,
        readConcurrency: this.readConcurrency,
      });
      const changed = changedPaths(session.before, after);
      const protectedChanges = changed.filter(isProtectedPath);
      const unsafeChanges = changed.filter(
        (relativePath) => after.files.get(relativePath)?.kind === "symlink",
      );
      const unsafeRoot = after.rootKind === "symlink";
      session.receipt.afterManifestDigest = after.digest;
      session.receipt.changedFiles = unsafeRoot
        ? ["[redacted unsafe workspace root]"]
        : changed.map((relativePath) =>
            isProtectedPath(relativePath)
              ? "[redacted protected path]"
              : after.files.get(relativePath)?.kind === "symlink"
                ? "[redacted unsafe symlink path]"
                : relativePath,
          );

      if (protectedChanges.length > 0 || unsafeChanges.length > 0 || unsafeRoot) {
        session.receipt.verdict = "denied";
        session.receipt.denialReason =
          protectedChanges.length > 0
            ? "RunGuard blocked a protected workspace-path mutation"
            : unsafeRoot
              ? "RunGuard blocked an unsafe symbolic-link workspace-root mutation"
              : "RunGuard blocked an unsafe symbolic-link workspace mutation";
        session.receipt.events.push({
          at: now(),
          kind: "verification_denied",
          detail:
            protectedChanges.length > 0
              ? "protected path mutation detected without recording its name or contents"
              : unsafeRoot
                ? "workspace-root symbolic-link mutation detected without following or recording its target"
                : "symbolic-link mutation detected without following or recording its target",
        });
        try {
          const recovered =
            unsafeChanges.length > 0 || unsafeRoot
              ? await replaceWorkspaceWithCheckpoint(session.before, this.readConcurrency)
              : await restoreCheckpoint(session.before, after, changed, this.readConcurrency);
          session.receipt.recovery = "rolled_back";
          session.receipt.recoveredManifestDigest = recovered.digest;
          session.receipt.events.push({
            at: now(),
            kind: "rollback_applied",
            detail: "bounded in-memory workspace checkpoint restored after denied Run",
          });
        } catch {
          session.receipt.recovery = "failed";
          session.receipt.events.push({
            at: now(),
            kind: "rollback_failed",
            detail: "bounded checkpoint recovery could not complete; filesystem details were not retained",
          });
        }
      } else {
        session.receipt.verdict = "retained";
        session.receipt.events.push({
          at: now(),
          kind: "verification_retained",
          detail: "workspace manifest verified after the Run",
        });
      }
    } catch (error) {
      session.receipt.verdict = "denied";
      session.receipt.denialReason = "RunGuard could not verify the workspace after the Run";
      session.receipt.changedFiles = ["[redacted unverifiable workspace]"];
      session.receipt.events.push({
        at: now(),
        kind: "verification_denied",
        detail: "workspace verification could not complete; no filesystem details were retained",
      });
      try {
        const recovered = await replaceWorkspaceWithCheckpoint(session.before, this.readConcurrency);
        session.receipt.recovery = "rolled_back";
        session.receipt.recoveredManifestDigest = recovered.digest;
        session.receipt.events.push({
          at: now(),
          kind: "rollback_applied",
          detail: "bounded checkpoint restored after an unverifiable Run",
        });
      } catch {
        session.receipt.recovery = "failed";
        session.receipt.events.push({
          at: now(),
          kind: "rollback_failed",
          detail: "bounded checkpoint recovery could not complete",
        });
      }
    }
    return session.receipt;
  }

  /**
   * Seal a host policy denial before runner dispatch. The second snapshot is
   * what makes `workerSpawned: false` independently useful: the receipt also
   * proves whether the protected baseline remained byte-identical.
   */
  async denyEffectBeforeDispatch(
    session: RunGuardSession,
    workspacePath: string,
    decision: EffectPolicyDecision,
  ): Promise<RunGuardReceipt> {
    if (decision.verdict !== "denied") {
      throw new Error("RunGuard requires a denied Effect Firewall decision");
    }
    let receipt = await this.verify(session, workspacePath);
    const baselineUnchanged = receipt.verdict === "retained" &&
      receipt.beforeManifestDigest !== null &&
      receipt.afterManifestDigest === receipt.beforeManifestDigest &&
      receipt.changedFiles.length === 0;

    if (receipt.verdict === "retained" && !baselineUnchanged) {
      // No worker was dispatched, so any concurrent workspace delta is outside
      // this action contract and must not be silently retained.
      receipt = await this.rejectTask(session);
    }
    receipt.effectDecision = {
      ...decision,
      workerSpawned: false,
      protectedBaselineVerifiedUnchanged: baselineUnchanged,
    };
    receipt.events.push({
      at: now(),
      kind: "effect_denied_pre_dispatch",
      detail: baselineUnchanged
        ? "typed protected effect denied before worker dispatch; baseline verified unchanged"
        : "typed protected effect denied before worker dispatch; baseline could not be verified unchanged",
    });
    if (baselineUnchanged) {
      receipt.verdict = "denied";
      receipt.denialReason = "Effect Firewall denied a protected action before worker dispatch";
      receipt.recovery = "not_needed";
      receipt.recoveredManifestDigest = null;
    }
    return receipt;
  }

  recordCandidatePromotion(session: RunGuardSession): void {
    if (session.receipt.verdict === "denied" || !session.before) {
      throw new Error("RunGuard cannot record promotion without an active checkpoint");
    }
    session.receipt.events.push({
      at: now(),
      kind: "candidate_promoted",
      detail: "trusted host promotion phase applied a candidate pending independent acceptance",
    });
  }

  // A clean filesystem scan does not establish task correctness. A trusted
  // acceptance failure restores the same bounded checkpoint before publication.
  async rejectTask(session: RunGuardSession): Promise<RunGuardReceipt> {
    if (session.receipt.verdict === "denied" || !session.before) return session.receipt;
    session.receipt.verdict = "denied";
    session.receipt.denialReason = "RunGuard withheld changes because task acceptance was not established";
    session.receipt.events.push({ at: now(), kind: "verification_denied",
      detail: "task acceptance was not established; model output is not proof of completion" });
    try {
      const recovered = await replaceWorkspaceWithCheckpoint(session.before, this.readConcurrency);
      session.receipt.recovery = "rolled_back";
      session.receipt.recoveredManifestDigest = recovered.digest;
      session.receipt.events.push({ at: now(), kind: "rollback_applied",
        detail: "bounded checkpoint restored after task acceptance failure" });
    } catch {
      session.receipt.recovery = "failed";
      session.receipt.recoveredManifestDigest = null;
      session.receipt.events.push({ at: now(), kind: "rollback_failed",
        detail: "task acceptance checkpoint recovery could not complete" });
    }
    return session.receipt;
  }
}
