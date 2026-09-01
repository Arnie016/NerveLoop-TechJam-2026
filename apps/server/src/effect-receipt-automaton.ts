import {createHash} from "node:crypto";
import type {
  Agent,
  EffectAction,
  EffectDecisionReceipt,
  EffectTargetClass,
  RunGuardEventKind,
  RunGuardReceipt,
} from "./types.js";

const receiptKeys = [
  "afterManifestDigest",
  "agentId",
  "beforeManifestDigest",
  "changedFiles",
  "denialReason",
  "events",
  "grantedScope",
  "recoveredManifestDigest",
  "recovery",
  "runId",
  "sandboxMode",
  "verdict",
  "version",
] as const;

const effectDecisionKeys = [
  "action",
  "policy",
  "protectedBaselineVerifiedUnchanged",
  "reason",
  "targetClass",
  "verdict",
  "version",
  "workerSpawned",
] as const;

const eventKeys = ["at", "detail", "kind"] as const;
const sha256Pattern = /^[a-f0-9]{64}$/;
const effectActions = new Set<EffectAction>([
  "read_asset_metadata",
  "write_demo_result",
  "transform_media",
  "publish_candidate",
  "delete_mock_asset",
]);
const effectTargets = new Set<EffectTargetClass>([
  "scratch",
  "workspace",
  "candidate",
  "protected",
]);
const eventKinds = new Set<RunGuardEventKind>([
  "grant_issued",
  "grant_denied",
  "effect_denied_pre_dispatch",
  "verification_retained",
  "verification_denied",
  "candidate_promoted",
  "rollback_applied",
  "rollback_failed",
  "recovery_required",
]);

export type EffectReceiptTerminalFamily =
  | "safe_retained"
  | "grant_denied"
  | "effect_denied_pre_dispatch"
  | "post_run_rolled_back"
  | "recovery_failed_hold";

export type EffectReceiptAutomatonErrorCode =
  | "RECEIPT_INVALID"
  | "EVENT_INVALID"
  | "EVENT_SEQUENCE_INVALID"
  | "TERMINAL_CONTRADICTION"
  | "RECOVERY_HOLD_REQUIRED"
  | "CHAIN_HEAD_MISMATCH";

export class EffectReceiptAutomatonError extends Error {
  constructor(readonly code: EffectReceiptAutomatonErrorCode) {
    super(code);
    this.name = "EffectReceiptAutomatonError";
  }
}

export interface EffectReceiptValidationOptions {
  /**
   * A previously trusted head. Hashing detects later mutation; it does not make
   * an untrusted or compromised host authoritative.
   */
  trustedChainHead?: string;
  /**
   * RunGuardReceipt does not embed Agent recoveryHold. Failed recovery is valid
   * only when the caller supplies the persisted hold for the same Run.
   */
  recoveryHold?: Agent["recoveryHold"];
}

export interface EffectReceiptValidation {
  family: EffectReceiptTerminalFamily;
  chainHead: string;
  eventCount: number;
  verificationPasses: number;
  workerDispatchProvedAbsent: boolean;
  requiresRecoveryHold: boolean;
}

type ReceiptEvent = RunGuardReceipt["events"][number];

function fail(code: EffectReceiptAutomatonErrorCode): never {
  throw new EffectReceiptAutomatonError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key));
}

function boundedString(value: unknown, maximum = 1_024): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !value.includes("\0") && hasWellFormedUtf16(value);
}

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function digestOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && sha256Pattern.test(value));
}

function parseEffectDecision(value: unknown): EffectDecisionReceipt {
  if (!isRecord(value) || !hasExactKeys(value, effectDecisionKeys)) {
    fail("RECEIPT_INVALID");
  }
  if (value.version !== 1 || value.policy !== "effect-firewall-v1" ||
      value.verdict !== "denied" || value.workerSpawned !== false ||
      value.protectedBaselineVerifiedUnchanged !== true ||
      typeof value.action !== "string" || !effectActions.has(value.action as EffectAction) ||
      typeof value.targetClass !== "string" || !effectTargets.has(value.targetClass as EffectTargetClass) ||
      (value.reason !== "protected_target_denied" && value.reason !== "effect_not_allowlisted")) {
    fail("TERMINAL_CONTRADICTION");
  }
  if ((value.targetClass === "protected") !== (value.reason === "protected_target_denied")) {
    fail("TERMINAL_CONTRADICTION");
  }
  return {
    version: 1,
    policy: "effect-firewall-v1",
    verdict: "denied",
    action: value.action as EffectAction,
    targetClass: value.targetClass as EffectTargetClass,
    reason: value.reason,
    workerSpawned: false,
    protectedBaselineVerifiedUnchanged: true,
  };
}

function parseEvent(value: unknown): ReceiptEvent {
  if (!isRecord(value) || !hasExactKeys(value, eventKeys) ||
      !boundedString(value.at, 64) || !boundedString(value.detail, 4_096) ||
      typeof value.kind !== "string" || !eventKinds.has(value.kind as RunGuardEventKind)) {
    fail("EVENT_INVALID");
  }
  const milliseconds = Date.parse(value.at);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value.at) {
    fail("EVENT_INVALID");
  }
  return {
    at: value.at,
    detail: value.detail,
    kind: value.kind as RunGuardEventKind,
  };
}

function parseReceipt(value: unknown): RunGuardReceipt {
  if (!isRecord(value) || !hasExactKeys(value, receiptKeys, ["effectDecision"]) ||
      value.version !== 1 || !boundedString(value.agentId, 256) ||
      !boundedString(value.runId, 256) || value.grantedScope !== "agent-workspace-only" ||
      (value.sandboxMode !== "read-only" && value.sandboxMode !== "workspace-write" &&
        value.sandboxMode !== "danger-full-access") ||
      (value.verdict !== "pending" && value.verdict !== "retained" && value.verdict !== "denied") ||
      (value.denialReason !== null && !boundedString(value.denialReason, 4_096)) ||
      !digestOrNull(value.beforeManifestDigest) || !digestOrNull(value.afterManifestDigest) ||
      !digestOrNull(value.recoveredManifestDigest) ||
      (value.recovery !== "not_needed" && value.recovery !== "rolled_back" && value.recovery !== "failed") ||
      !Array.isArray(value.changedFiles) || value.changedFiles.length > 1_256 ||
      !value.changedFiles.every((item) => boundedString(item, 1_024)) ||
      !Array.isArray(value.events) || value.events.length === 0 || value.events.length > 16) {
    fail("RECEIPT_INVALID");
  }

  const events = value.events.map(parseEvent);
  let previousTime = Number.NEGATIVE_INFINITY;
  const exactEvents = new Set<string>();
  for (const event of events) {
    const time = Date.parse(event.at);
    if (time < previousTime) fail("EVENT_SEQUENCE_INVALID");
    previousTime = time;
    const fingerprint = stableJson(event);
    if (exactEvents.has(fingerprint)) fail("EVENT_SEQUENCE_INVALID");
    exactEvents.add(fingerprint);
  }

  const effectDecision = Object.hasOwn(value, "effectDecision")
    ? parseEffectDecision(value.effectDecision)
    : undefined;
  return {
    version: 1,
    agentId: value.agentId,
    runId: value.runId,
    grantedScope: "agent-workspace-only",
    sandboxMode: value.sandboxMode,
    verdict: value.verdict,
    denialReason: value.denialReason,
    beforeManifestDigest: value.beforeManifestDigest,
    afterManifestDigest: value.afterManifestDigest,
    recoveredManifestDigest: value.recoveredManifestDigest,
    recovery: value.recovery,
    changedFiles: [...value.changedFiles] as string[],
    ...(effectDecision ? {effectDecision} : {}),
    events,
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("RECEIPT_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  fail("RECEIPT_INVALID");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Compute a deterministic chain over receipt identity, ordered events and the
 * terminal seal. Call validateEffectReceiptHistory for untrusted input first.
 */
export function computeEffectReceiptChainHead(receipt: RunGuardReceipt): string {
  let head = sha256(stableJson({
    domain: "nerveloop.effect-receipt-chain.v1",
    identity: {
      version: receipt.version,
      agentId: receipt.agentId,
      runId: receipt.runId,
      grantedScope: receipt.grantedScope,
      sandboxMode: receipt.sandboxMode,
      beforeManifestDigest: receipt.beforeManifestDigest,
    },
  }));
  receipt.events.forEach((event, index) => {
    head = sha256(stableJson({domain: "event", index, previous: head, event}));
  });
  return sha256(stableJson({
    domain: "terminal",
    previous: head,
    terminal: {
      verdict: receipt.verdict,
      denialReason: receipt.denialReason,
      afterManifestDigest: receipt.afterManifestDigest,
      recoveredManifestDigest: receipt.recoveredManifestDigest,
      recovery: receipt.recovery,
      changedFiles: receipt.changedFiles,
      effectDecision: receipt.effectDecision ?? null,
    },
  }));
}

type AutomatonState =
  | "start"
  | "active"
  | "verified"
  | "promoted"
  | "verification_denied"
  | "rollback_failed"
  | "grant_denied"
  | "effect_denied"
  | "rolled_back"
  | "hold_required";

interface SequenceResult {
  state: AutomatonState;
  verificationPasses: number;
}

function validateSequence(events: readonly ReceiptEvent[]): SequenceResult {
  let state: AutomatonState = "start";
  let verificationPasses = 0;
  let promotionCount = 0;
  for (const event of events) {
    switch (event.kind) {
      case "grant_issued":
        if (state !== "start") fail("EVENT_SEQUENCE_INVALID");
        state = "active";
        break;
      case "grant_denied":
        if (state !== "active" || events[1] !== event) fail("EVENT_SEQUENCE_INVALID");
        state = "grant_denied";
        break;
      case "verification_retained":
        if (state !== "active" && state !== "verified" && state !== "promoted") {
          fail("EVENT_SEQUENCE_INVALID");
        }
        verificationPasses++;
        if (verificationPasses > 3) fail("EVENT_SEQUENCE_INVALID");
        state = "verified";
        break;
      case "candidate_promoted":
        if (state !== "verified" || ++promotionCount > 1) fail("EVENT_SEQUENCE_INVALID");
        state = "promoted";
        break;
      case "verification_denied":
        if (state !== "active" && state !== "verified" && state !== "promoted") {
          fail("EVENT_SEQUENCE_INVALID");
        }
        state = "verification_denied";
        break;
      case "rollback_applied":
        if (state !== "verification_denied") fail("EVENT_SEQUENCE_INVALID");
        state = "rolled_back";
        break;
      case "rollback_failed":
        if (state !== "verification_denied") fail("EVENT_SEQUENCE_INVALID");
        state = "rollback_failed";
        break;
      case "recovery_required":
        if (state !== "rollback_failed") fail("EVENT_SEQUENCE_INVALID");
        state = "hold_required";
        break;
      case "effect_denied_pre_dispatch":
        if (state !== "verified" || promotionCount !== 0 || verificationPasses !== 1) {
          fail("EVENT_SEQUENCE_INVALID");
        }
        state = "effect_denied";
        break;
    }
    if ((state === "grant_denied" || state === "effect_denied" ||
         state === "rolled_back" || state === "hold_required") &&
        events[events.length - 1] !== event) {
      fail("EVENT_SEQUENCE_INVALID");
    }
  }
  return {state, verificationPasses};
}

function requireDeniedBase(receipt: RunGuardReceipt): void {
  if (receipt.verdict !== "denied" || receipt.denialReason === null) {
    fail("TERMINAL_CONTRADICTION");
  }
}

function classifyTerminal(
  receipt: RunGuardReceipt,
  state: AutomatonState,
  recoveryHold: Agent["recoveryHold"] | undefined,
): {family: EffectReceiptTerminalFamily; requiresRecoveryHold: boolean} {
  if (state !== "grant_denied" && receipt.sandboxMode !== "workspace-write") {
    fail("TERMINAL_CONTRADICTION");
  }
  if (state === "verified") {
    if (receipt.verdict !== "retained" || receipt.denialReason !== null ||
        receipt.beforeManifestDigest === null || receipt.afterManifestDigest === null ||
        receipt.recoveredManifestDigest !== null || receipt.recovery !== "not_needed" ||
        receipt.effectDecision !== undefined || recoveryHold) {
      fail("TERMINAL_CONTRADICTION");
    }
    return {family: "safe_retained", requiresRecoveryHold: false};
  }

  if (state === "grant_denied") {
    requireDeniedBase(receipt);
    if (receipt.beforeManifestDigest !== null || receipt.afterManifestDigest !== null ||
        receipt.recoveredManifestDigest !== null || receipt.recovery !== "not_needed" ||
        receipt.changedFiles.length !== 0 || receipt.effectDecision !== undefined || recoveryHold) {
      fail("TERMINAL_CONTRADICTION");
    }
    return {family: "grant_denied", requiresRecoveryHold: false};
  }

  if (state === "effect_denied") {
    requireDeniedBase(receipt);
    if (receipt.beforeManifestDigest === null ||
        receipt.afterManifestDigest !== receipt.beforeManifestDigest ||
        receipt.recoveredManifestDigest !== null || receipt.recovery !== "not_needed" ||
        receipt.changedFiles.length !== 0 || !receipt.effectDecision ||
        receipt.effectDecision.workerSpawned !== false ||
        !receipt.effectDecision.protectedBaselineVerifiedUnchanged || recoveryHold) {
      fail("TERMINAL_CONTRADICTION");
    }
    return {
      family: "effect_denied_pre_dispatch",
      requiresRecoveryHold: false,
    };
  }

  if (state === "rolled_back") {
    requireDeniedBase(receipt);
    if (receipt.beforeManifestDigest === null || receipt.recovery !== "rolled_back" ||
        receipt.recoveredManifestDigest !== receipt.beforeManifestDigest ||
        receipt.effectDecision !== undefined || recoveryHold) {
      fail("TERMINAL_CONTRADICTION");
    }
    return {family: "post_run_rolled_back", requiresRecoveryHold: false};
  }

  if (state === "rollback_failed" || state === "hold_required") {
    requireDeniedBase(receipt);
    if (receipt.beforeManifestDigest === null || receipt.recovery !== "failed" ||
        receipt.recoveredManifestDigest !== null || receipt.effectDecision !== undefined) {
      fail("TERMINAL_CONTRADICTION");
    }
    if (!recoveryHold || recoveryHold.runId !== receipt.runId ||
        recoveryHold.reason !== "rollback_failed") {
      fail("RECOVERY_HOLD_REQUIRED");
    }
    return {family: "recovery_failed_hold", requiresRecoveryHold: true};
  }

  fail("EVENT_SEQUENCE_INVALID");
}

/**
 * Fail-closed validation for complete terminal RunGuard/Effect Firewall
 * receipts. This module is pure and is not yet an AgentService enforcement
 * point: callers must decide when a trusted head is captured and persisted.
 */
export function validateEffectReceiptHistory(
  value: unknown,
  options: EffectReceiptValidationOptions = {},
): EffectReceiptValidation {
  if (options.trustedChainHead !== undefined && !sha256Pattern.test(options.trustedChainHead)) {
    fail("CHAIN_HEAD_MISMATCH");
  }
  const receipt = parseReceipt(value);
  const sequence = validateSequence(receipt.events);
  const terminal = classifyTerminal(receipt, sequence.state, options.recoveryHold);
  const chainHead = computeEffectReceiptChainHead(receipt);
  if (options.trustedChainHead !== undefined && options.trustedChainHead !== chainHead) {
    fail("CHAIN_HEAD_MISMATCH");
  }
  return {
    family: terminal.family,
    chainHead,
    eventCount: receipt.events.length,
    verificationPasses: sequence.verificationPasses,
    workerDispatchProvedAbsent: terminal.family === "effect_denied_pre_dispatch",
    requiresRecoveryHold: terminal.requiresRecoveryHold,
  };
}
