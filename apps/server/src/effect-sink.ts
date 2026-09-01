import { createHash, randomBytes } from "node:crypto";
import { constants, lstatSync, realpathSync, renameSync, type Stats } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type { EffectCapabilityRegistry } from "./effect-capability.js";
import type {
  EffectCapabilityReceipt,
  EffectSinkCommitReceipt,
  EffectSinkPort,
  EffectSinkReceipt,
  EffectSinkWriteRequest,
} from "./types.js";

export const EFFECT_SINK_DEMO_RESULT_PATH = "demo-result.md" as const;
export const EFFECT_SINK_DEMO_RESULT_PAYLOAD =
  "# RunGuard demo result\n\nA controlled local fixture completed a workspace-scoped Run.\n" as const;

const requiredAction = "write_demo_result" as const;
const requiredTargetClass = "workspace" as const;
const defaultTtlMs = 4_000;
const maximumTtlMs = 5_000;
const maximumEntries = 1_024;
const receiptBoundary =
  "Process-local one-use broker with root/destination identity checks and same-filesystem atomic replace; not durable, cross-process, kernel-confined, or proof against a concurrent ancestor-swap TOCTOU";

export type EffectSinkErrorCode =
  | "EFFECT_SINK_INVALID"
  | "EFFECT_SINK_REGISTRY_FULL"
  | "EFFECT_SINK_PARENT_INVALID"
  | "EFFECT_SINK_PARENT_ALREADY_DERIVED"
  | "EFFECT_SINK_SCOPE_MISMATCH"
  | "EFFECT_SINK_EXPIRED"
  | "EFFECT_SINK_UNKNOWN_GRANT"
  | "EFFECT_SINK_CONTEXT_MISMATCH"
  | "EFFECT_SINK_ALREADY_SPENT"
  | "EFFECT_SINK_CLOSED"
  | "EFFECT_SINK_ROOT_CHANGED"
  | "EFFECT_SINK_DESTINATION_UNSAFE"
  | "EFFECT_SINK_EFFECT_FAILED";

export class EffectSinkError extends Error {
  constructor(readonly code: EffectSinkErrorCode) {
    super(code);
    this.name = "EffectSinkError";
  }
}

function fail(code: EffectSinkErrorCode): never {
  throw new EffectSinkError(code);
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function effectSinkPayloadSha256(payload: string | Uint8Array): string {
  return sha256(payload);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  fail("EFFECT_SINK_INVALID");
}

function exactObject(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validSingleChildPath(value: unknown): value is string {
  return typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value) &&
    value !== "." && value !== "..";
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

interface RootIdentity {
  canonicalPath: string;
  device: string;
  inode: string;
}

interface FileIdentity {
  device: number;
  inode: number;
  mode: number;
  size: number;
  modifiedMs: number;
  changedMs: number;
  links: number;
}

function rootIdentity(workspaceRoot: string): RootIdentity {
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) {
    fail("EFFECT_SINK_INVALID");
  }
  let entry: Stats;
  let canonicalPath: string;
  try {
    const requested = path.resolve(workspaceRoot);
    entry = lstatSync(requested);
    canonicalPath = realpathSync(requested);
  } catch {
    fail("EFFECT_SINK_INVALID");
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) fail("EFFECT_SINK_INVALID");
  return Object.freeze({
    canonicalPath,
    device: String(entry.dev),
    inode: String(entry.ino),
  });
}

function regularFileIdentity(entry: Stats): FileIdentity {
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 ||
      (entry.mode & 0o7000) !== 0) {
    fail("EFFECT_SINK_DESTINATION_UNSAFE");
  }
  return {
    device: entry.dev,
    inode: entry.ino,
    mode: entry.mode,
    size: entry.size,
    modifiedMs: entry.mtimeMs,
    changedMs: entry.ctimeMs,
    links: entry.nlink,
  };
}

function sameFileIdentity(expected: FileIdentity, observed: Stats): boolean {
  return observed.isFile() && !observed.isSymbolicLink() &&
    observed.dev === expected.device && observed.ino === expected.inode &&
    observed.mode === expected.mode && observed.size === expected.size &&
    observed.mtimeMs === expected.modifiedMs && observed.ctimeMs === expected.changedMs &&
    observed.nlink === expected.links;
}

function samePublishedInode(expected: FileIdentity, observed: Stats): boolean {
  return observed.isFile() && !observed.isSymbolicLink() &&
    observed.dev === expected.device && observed.ino === expected.inode &&
    observed.mode === expected.mode && observed.size === expected.size &&
    observed.nlink === expected.links;
}

function sameStagingInode(expected: FileIdentity, observed: Stats): boolean {
  return observed.isFile() && !observed.isSymbolicLink() &&
    observed.dev === expected.device && observed.ino === expected.inode &&
    observed.mode === expected.mode && observed.nlink === expected.links;
}

function parentDigest(grantId: string): string {
  return sha256(`nerveloop.effect-sink.parent.v1\0${grantId}`);
}

function grantDigest(grant: string): string {
  return sha256(`nerveloop.effect-sink.grant.v1\0${grant}`);
}

interface SinkBinding {
  parentGrantSha256: string;
  runId: string;
  agentId: string;
  action: typeof requiredAction;
  targetClass: typeof requiredTargetClass;
  policy: "effect-firewall-v1";
  policyVersion: 1;
  policyDigest: string;
  workspaceRootIdentitySha256: string;
  relativePath: string;
  payloadSha256: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

interface SinkEntry {
  grant: string;
  binding: SinkBinding;
  root: RootIdentity;
  state: EffectSinkReceipt["state"];
  spentAtMs: number | null;
  committedAtMs: number | null;
  failedAtMs: number | null;
  closedAtMs: number | null;
  closeDisposition: EffectSinkReceipt["closeDisposition"];
  bytesCommitted: number | null;
  errorCode: EffectSinkErrorCode | null;
}

function receipt(entry: SinkEntry): EffectSinkReceipt {
  return Object.freeze({
    version: 1,
    broker: "process-local",
    grantSha256: grantDigest(entry.grant),
    parentGrantSha256: entry.binding.parentGrantSha256,
    state: entry.state,
    runId: entry.binding.runId,
    agentId: entry.binding.agentId,
    action: entry.binding.action,
    targetClass: entry.binding.targetClass,
    policy: entry.binding.policy,
    policyVersion: entry.binding.policyVersion,
    policyDigest: entry.binding.policyDigest,
    workspaceRootIdentitySha256: entry.binding.workspaceRootIdentitySha256,
    relativePath: entry.binding.relativePath,
    payloadSha256: entry.binding.payloadSha256,
    issuedAt: iso(entry.binding.issuedAtMs),
    expiresAt: iso(entry.binding.expiresAtMs),
    spentAt: entry.spentAtMs === null ? null : iso(entry.spentAtMs),
    committedAt: entry.committedAtMs === null ? null : iso(entry.committedAtMs),
    failedAt: entry.failedAtMs === null ? null : iso(entry.failedAtMs),
    closedAt: entry.closedAtMs === null ? null : iso(entry.closedAtMs),
    closeDisposition: entry.closeDisposition,
    bytesCommitted: entry.bytesCommitted,
    errorCode: entry.errorCode,
    boundary: receiptBoundary,
  });
}

class AttachedEffectSinkPort implements EffectSinkPort {
  #redeem: (grant: string, request: EffectSinkWriteRequest) => Promise<EffectSinkCommitReceipt>;

  constructor(redeem: (grant: string, request: EffectSinkWriteRequest) => Promise<EffectSinkCommitReceipt>) {
    this.#redeem = redeem;
  }

  redeem(grant: string, request: EffectSinkWriteRequest): Promise<EffectSinkCommitReceipt> {
    return this.#redeem(grant, request);
  }
}

/**
 * Process-local reference monitor for one exact direct-child file effect.
 *
 * The broker keeps every binding private. A runner receives only an opaque
 * random grant plus the attached redeem-only port. Spending is synchronous and
 * precedes the first await; filesystem identity checks and the atomic replace
 * are a fail-closed user-space mitigation, not a kernel confinement claim.
 */
export class ProcessLocalEffectSinkBroker {
  private readonly entries = new Map<string, SinkEntry>();
  private readonly derivedParents = new Set<string>();
  private readonly attachedPort: EffectSinkPort;

  constructor(
    private readonly registry: Pick<EffectCapabilityRegistry, "inspect">,
    private readonly options: {
      now?: () => number;
      grant?: () => string;
      beforeIo?: () => void | Promise<void>;
      maximumEntries?: number;
    } = {},
  ) {
    if (!registry || typeof registry.inspect !== "function" ||
        (options.now && typeof options.now !== "function") ||
        (options.grant && typeof options.grant !== "function") ||
        (options.beforeIo && typeof options.beforeIo !== "function")) {
      fail("EFFECT_SINK_INVALID");
    }
    this.attachedPort = Object.freeze(new AttachedEffectSinkPort(
      (grant, request) => this.redeem(grant, request),
    ));
  }

  get port(): EffectSinkPort {
    return this.attachedPort;
  }

  issue(input: {
    parent: EffectCapabilityReceipt;
    workspaceRoot: string;
    relativePath: string;
    payloadSha256: string;
    ttlMs?: number;
  }): {grant: string; receipt: EffectSinkReceipt} {
    const current = this.registry.inspect(input.parent?.grantId);
    if (!current || current.state !== "consumed" || !exactObject(current, input.parent)) {
      fail("EFFECT_SINK_PARENT_INVALID");
    }
    if (current.action !== requiredAction || current.targetClass !== requiredTargetClass) {
      fail("EFFECT_SINK_SCOPE_MISMATCH");
    }
    const ttlMs = input.ttlMs ?? defaultTtlMs;
    if (!validSingleChildPath(input.relativePath) || !validSha256(input.payloadSha256) ||
        !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > maximumTtlMs) {
      fail("EFFECT_SINK_INVALID");
    }
    if (this.entries.size >= (this.options.maximumEntries ?? maximumEntries)) {
      fail("EFFECT_SINK_REGISTRY_FULL");
    }
    const issuedAtMs = (this.options.now ?? Date.now)();
    const parentExpiresAtMs = Date.parse(current.expiresAt);
    if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0 ||
        !Number.isSafeInteger(parentExpiresAtMs) || issuedAtMs >= parentExpiresAtMs) {
      fail("EFFECT_SINK_EXPIRED");
    }
    const root = rootIdentity(input.workspaceRoot);
    if (this.derivedParents.has(current.grantId)) fail("EFFECT_SINK_PARENT_ALREADY_DERIVED");
    const opaqueGrant = (this.options.grant ?? (() => randomBytes(32).toString("base64url")))();
    if (!validId(opaqueGrant) || this.entries.has(opaqueGrant)) fail("EFFECT_SINK_INVALID");

    // The one-parent-to-one-child reservation is synchronous in this process.
    this.derivedParents.add(current.grantId);
    const expiresAtMs = Math.min(issuedAtMs + ttlMs, parentExpiresAtMs);
    const binding: SinkBinding = Object.freeze({
      parentGrantSha256: parentDigest(current.grantId),
      runId: current.runId,
      agentId: current.agentId,
      action: current.action,
      targetClass: current.targetClass,
      policy: current.policy,
      policyVersion: current.policyVersion,
      policyDigest: current.policyDigest,
      workspaceRootIdentitySha256: sha256(canonicalJson(root)),
      relativePath: input.relativePath,
      payloadSha256: input.payloadSha256,
      issuedAtMs,
      expiresAtMs,
    });
    const entry: SinkEntry = {
      grant: opaqueGrant,
      binding,
      root,
      state: "issued",
      spentAtMs: null,
      committedAtMs: null,
      failedAtMs: null,
      closedAtMs: null,
      closeDisposition: null,
      bytesCommitted: null,
      errorCode: null,
    };
    this.entries.set(opaqueGrant, entry);
    return Object.freeze({grant: opaqueGrant, receipt: receipt(entry)});
  }

  inspect(grant: string): EffectSinkReceipt | null {
    const entry = this.entries.get(grant);
    return entry ? receipt(entry) : null;
  }

  /**
   * Host-only synchronous authority closure. The attached runner port exposes
   * no reference to this method. `revoked` wins over any redemption that has
   * yielded at an async boundary, while an already committed effect is kept.
   */
  close(grant: string): EffectSinkReceipt {
    const entry = this.entries.get(grant);
    if (!entry) fail("EFFECT_SINK_UNKNOWN_GRANT");
    if (entry.state === "issued" || entry.state === "spent") {
      const closedAtMs = (this.options.now ?? Date.now)();
      if (!Number.isSafeInteger(closedAtMs) || closedAtMs < entry.binding.issuedAtMs) {
        fail("EFFECT_SINK_INVALID");
      }
      entry.closeDisposition = entry.state === "issued" ? "unredeemed" : "in_flight";
      entry.state = "revoked";
      entry.closedAtMs = closedAtMs;
      entry.errorCode = "EFFECT_SINK_CLOSED";
    }
    return receipt(entry);
  }

  private assertRedemptionOpen(entry: SinkEntry): void {
    if (entry.state === "revoked") fail("EFFECT_SINK_CLOSED");
    if (entry.state !== "spent") fail("EFFECT_SINK_ALREADY_SPENT");
  }

  private redemptionWasClosed(entry: SinkEntry): boolean {
    // Read through a method because close() may mutate this process-local entry
    // across any awaited boundary in redeem().
    return entry.state === "revoked";
  }

  private async assertRootIdentity(root: RootIdentity): Promise<void> {
    let current: Stats;
    let canonical: string;
    try {
      current = await lstat(root.canonicalPath);
      canonical = await realpath(root.canonicalPath);
    } catch {
      fail("EFFECT_SINK_ROOT_CHANGED");
    }
    if (!current.isDirectory() || current.isSymbolicLink() ||
        String(current.dev) !== root.device || String(current.ino) !== root.inode ||
        canonical !== root.canonicalPath) {
      fail("EFFECT_SINK_ROOT_CHANGED");
    }
  }

  private async destinationIdentity(destination: string): Promise<FileIdentity | null> {
    try {
      return regularFileIdentity(await lstat(destination));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async assertDestinationUnchanged(
    destination: string,
    expected: FileIdentity | null,
  ): Promise<void> {
    try {
      const current = await lstat(destination);
      if (!expected || !sameFileIdentity(expected, current)) {
        fail("EFFECT_SINK_DESTINATION_UNSAFE");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && expected === null) return;
      throw error;
    }
  }

  private async redeem(
    grant: string,
    request: EffectSinkWriteRequest,
  ): Promise<EffectSinkCommitReceipt> {
    const entry = this.entries.get(grant);
    if (!entry) fail("EFFECT_SINK_UNKNOWN_GRANT");
    if (!request || typeof request !== "object" || Array.isArray(request) ||
        Object.keys(request).sort().join(",") !==
          "action,agentId,payload,relativePath,runId,targetClass" ||
        !(request.payload instanceof Uint8Array)) {
      fail("EFFECT_SINK_INVALID");
    }

    // Snapshot mutable caller bytes before the first await. All checks and I/O
    // below use only this detached copy.
    const immutablePayload = Buffer.from(request.payload);
    const binding = entry.binding;
    if (request.runId !== binding.runId || request.agentId !== binding.agentId ||
        request.action !== binding.action || request.targetClass !== binding.targetClass ||
        request.relativePath !== binding.relativePath ||
        sha256(immutablePayload) !== binding.payloadSha256) {
      fail("EFFECT_SINK_CONTEXT_MISMATCH");
    }
    if (entry.state === "revoked") fail("EFFECT_SINK_CLOSED");
    if (entry.state !== "issued") fail("EFFECT_SINK_ALREADY_SPENT");
    const spentAtMs = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(spentAtMs) || spentAtMs < binding.issuedAtMs ||
        spentAtMs >= binding.expiresAtMs) {
      fail("EFFECT_SINK_EXPIRED");
    }

    // Linearization point: one winner spends the grant before any await.
    entry.state = "spent";
    entry.spentAtMs = spentAtMs;

    const destination = path.resolve(entry.root.canonicalPath, binding.relativePath);
    if (path.dirname(destination) !== entry.root.canonicalPath) {
      entry.state = "effect_failed";
      entry.failedAtMs = spentAtMs;
      entry.errorCode = "EFFECT_SINK_DESTINATION_UNSAFE";
      fail("EFFECT_SINK_DESTINATION_UNSAFE");
    }
    const staging = path.join(
      entry.root.canonicalPath,
      `.nerveloop-sink-${grantDigest(grant).slice(0, 32)}.tmp`,
    );
    let stageHandle: Awaited<ReturnType<typeof open>> | null = null;
    let stageCreationIdentity: FileIdentity | null = null;
    let stageIdentity: FileIdentity | null = null;
    try {
      await this.options.beforeIo?.();
      this.assertRedemptionOpen(entry);
      await this.assertRootIdentity(entry.root);
      this.assertRedemptionOpen(entry);
      const priorDestination = await this.destinationIdentity(destination);
      this.assertRedemptionOpen(entry);
      stageHandle = await open(
        staging,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      this.assertRedemptionOpen(entry);
      stageCreationIdentity = regularFileIdentity(await stageHandle.stat());
      this.assertRedemptionOpen(entry);
      await stageHandle.writeFile(immutablePayload);
      this.assertRedemptionOpen(entry);
      await stageHandle.sync();
      this.assertRedemptionOpen(entry);
      stageIdentity = regularFileIdentity(await stageHandle.stat());
      this.assertRedemptionOpen(entry);
      if (stageIdentity.size !== immutablePayload.length) fail("EFFECT_SINK_EFFECT_FAILED");

      await this.assertRootIdentity(entry.root);
      this.assertRedemptionOpen(entry);
      await this.assertDestinationUnchanged(destination, priorDestination);
      this.assertRedemptionOpen(entry);
      // Synchronous commit point: close() cannot interleave between the final
      // live-state check, atomic replace, identity verification, and terminal
      // committed transition in this process.
      renameSync(staging, destination);
      const published = lstatSync(destination);
      // rename(2) may legitimately advance ctime; inode, device, mode, size and
      // link count are the stable publication identity.
      if (!stageIdentity || !samePublishedInode(stageIdentity, published)) {
        fail("EFFECT_SINK_EFFECT_FAILED");
      }
      const committedAtMs = (this.options.now ?? Date.now)();
      entry.state = "committed";
      entry.committedAtMs = committedAtMs;
      entry.bytesCommitted = immutablePayload.length;
      await stageHandle.close();
      stageHandle = null;
      return Object.freeze({
        version: 1,
        state: "committed",
        grantSha256: grantDigest(grant),
        relativePath: binding.relativePath,
        payloadSha256: binding.payloadSha256,
        bytesCommitted: immutablePayload.length,
        committedAt: iso(committedAtMs),
      });
    } catch (error) {
      try {
        if (stageHandle) await stageHandle.close();
      } catch {
        // Preserve the primary fail-closed result.
      }
      // Remove only the exact staging inode we created, and only while the
      // original root identity still holds. Never touch a replacement root.
      if (stageCreationIdentity) {
        try {
          await this.assertRootIdentity(entry.root);
          const staged = await lstat(staging);
          if (sameStagingInode(stageCreationIdentity, staged)) await unlink(staging);
        } catch {
          // A leaked private staging file is safer than unlinking through a
          // changed ancestor; RunGuard remains the outer recovery backstop.
        }
      }
      const code = error instanceof EffectSinkError
        ? error.code
        : "EFFECT_SINK_EFFECT_FAILED";
      // Host close is already terminal and must not be rewritten as an I/O
      // failure by the delayed redemption it defeated.
      if (this.redemptionWasClosed(entry)) {
        if (error instanceof EffectSinkError) throw error;
        fail("EFFECT_SINK_CLOSED");
      }
      entry.state = "effect_failed";
      entry.failedAtMs = (this.options.now ?? Date.now)();
      entry.errorCode = code;
      if (error instanceof EffectSinkError) throw error;
      fail("EFFECT_SINK_EFFECT_FAILED");
    }
  }
}
