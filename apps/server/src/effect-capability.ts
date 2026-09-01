import { createHash, randomUUID } from "node:crypto";
import {
  EFFECT_ACTION_RISK,
  EFFECT_ACTIONS_BY_RISK,
  EFFECT_FIREWALL_POLICY,
  EFFECT_MAX_AUTHORITY_SCORE,
  EFFECT_TARGET_SENSITIVITY,
  EFFECT_TARGETS_BY_SENSITIVITY,
  decideEffect,
} from "./effect-policy.js";
import type {
  EffectCapabilityBinding,
  EffectCapabilityReceipt,
  EffectPolicyDecision,
} from "./types.js";

const maximumTtlMs = 15_000;
const defaultTtlMs = 5_000;
const capabilityBoundary =
  "Process-local host registry; not authentication, durable authority, provider interception, or kernel isolation";

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  throw new EffectCapabilityError("EFFECT_CAPABILITY_INVALID");
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/**
 * Digest of the complete host policy table, not of prompt text or model output.
 * A rule-table change therefore invalidates an already issued process-local grant
 * even if a caller forgets to change the human-readable policy name.
 */
export const EFFECT_FIREWALL_POLICY_DIGEST = sha256({
  domain: "nerveloop.effect-firewall-policy.v1",
  policy: EFFECT_FIREWALL_POLICY,
  decisionVersion: 1,
  actionOrder: EFFECT_ACTIONS_BY_RISK,
  actionRisk: EFFECT_ACTION_RISK,
  targetOrder: EFFECT_TARGETS_BY_SENSITIVITY,
  targetSensitivity: EFFECT_TARGET_SENSITIVITY,
  maximumAuthorityScore: EFFECT_MAX_AUTHORITY_SCORE,
});

export type EffectCapabilityErrorCode =
  | "EFFECT_CAPABILITY_INVALID"
  | "EFFECT_CAPABILITY_DECISION_DENIED"
  | "EFFECT_CAPABILITY_REGISTRY_FULL"
  | "EFFECT_CAPABILITY_BINDING_MISMATCH"
  | "EFFECT_CAPABILITY_EXPIRED"
  | "EFFECT_CAPABILITY_ALREADY_CLAIMED"
  | "EFFECT_CAPABILITY_NOT_CLAIMED"
  | "EFFECT_CAPABILITY_ALREADY_CONSUMED";

export class EffectCapabilityError extends Error {
  constructor(readonly code: EffectCapabilityErrorCode) {
    super(code);
    this.name = "EffectCapabilityError";
  }
}

interface RegistryEntry {
  grantId: string;
  binding: EffectCapabilityBinding;
  issuedAtMs: number;
  expiresAtMs: number;
  state: EffectCapabilityReceipt["state"];
  claimedAtMs: number | null;
  consumedAtMs: number | null;
  usesClaimed: 0 | 1;
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function requireAllowedDecision(value: EffectPolicyDecision): EffectPolicyDecision & {verdict: "allowed"} {
  let recomputed: EffectPolicyDecision;
  try {
    recomputed = decideEffect({
      version: value?.version,
      action: value?.action,
      targetClass: value?.targetClass,
    });
  } catch {
    throw new EffectCapabilityError("EFFECT_CAPABILITY_INVALID");
  }
  if (stableJson(recomputed) !== stableJson(value)) {
    throw new EffectCapabilityError("EFFECT_CAPABILITY_INVALID");
  }
  if (recomputed.verdict !== "allowed") {
    throw new EffectCapabilityError("EFFECT_CAPABILITY_DECISION_DENIED");
  }
  return recomputed as EffectPolicyDecision & {verdict: "allowed"};
}

function bindingFor(input: {
  runId: string;
  agentId: string;
  decision: EffectPolicyDecision & {verdict: "allowed"};
}): EffectCapabilityBinding {
  if (!boundedId(input.runId) || !boundedId(input.agentId)) {
    throw new EffectCapabilityError("EFFECT_CAPABILITY_INVALID");
  }
  return Object.freeze({
    runId: input.runId,
    agentId: input.agentId,
    action: input.decision.action,
    targetClass: input.decision.targetClass,
    policy: input.decision.policy,
    policyVersion: input.decision.version,
    policyDigest: EFFECT_FIREWALL_POLICY_DIGEST,
  });
}

function requireExpectedBinding(value: EffectCapabilityBinding): EffectCapabilityBinding {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !==
        "action,agentId,policy,policyDigest,policyVersion,runId,targetClass" ||
      !boundedId(value.runId) || !boundedId(value.agentId) ||
      !EFFECT_ACTIONS_BY_RISK.includes(value.action) ||
      !EFFECT_TARGETS_BY_SENSITIVITY.includes(value.targetClass) ||
      typeof value.policy !== "string" || value.policy.length === 0 || value.policy.length > 80 ||
      !Number.isSafeInteger(value.policyVersion) || !isSha256(value.policyDigest)) {
    throw new EffectCapabilityError("EFFECT_CAPABILITY_INVALID");
  }
  return value;
}

function sameBinding(left: EffectCapabilityBinding, right: EffectCapabilityBinding): boolean {
  return stableJson(left) === stableJson(right);
}

function receipt(entry: RegistryEntry): EffectCapabilityReceipt {
  return Object.freeze({
    version: 1,
    registry: "process-local",
    grantId: entry.grantId,
    state: entry.state,
    ...entry.binding,
    issuedAt: iso(entry.issuedAtMs),
    expiresAt: iso(entry.expiresAtMs),
    claimedAt: entry.claimedAtMs === null ? null : iso(entry.claimedAtMs),
    consumedAt: entry.consumedAtMs === null ? null : iso(entry.consumedAtMs),
    useBudget: 1,
    usesClaimed: entry.usesClaimed,
    boundary: capabilityBoundary,
  });
}

function requireMatchingReceipt(value: EffectCapabilityReceipt, entry: RegistryEntry): void {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      stableJson(value) !== stableJson(receipt(entry))) {
    throw new EffectCapabilityError("EFFECT_CAPABILITY_INVALID");
  }
}

/**
 * In-memory authority registry for the explicit no-model fixture path.
 * JavaScript's run-to-completion semantics make claim() an atomic state change
 * within this process. Nothing here survives restart or authenticates a caller.
 */
export class EffectCapabilityRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  constructor(private readonly options: {
    now?: () => number;
    grantId?: () => string;
    maximumEntries?: number;
  } = {}) {}

  issue(input: {
    runId: string;
    agentId: string;
    decision: EffectPolicyDecision;
    ttlMs?: number;
  }): EffectCapabilityReceipt {
    const decision = requireAllowedDecision(input.decision);
    const ttlMs = input.ttlMs ?? defaultTtlMs;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > maximumTtlMs) {
      throw new EffectCapabilityError("EFFECT_CAPABILITY_INVALID");
    }
    if (this.entries.size >= (this.options.maximumEntries ?? 1_024)) {
      throw new EffectCapabilityError("EFFECT_CAPABILITY_REGISTRY_FULL");
    }
    const grantId = (this.options.grantId ?? randomUUID)();
    if (!boundedId(grantId) || this.entries.has(grantId)) {
      throw new EffectCapabilityError("EFFECT_CAPABILITY_INVALID");
    }
    const issuedAtMs = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0) {
      throw new EffectCapabilityError("EFFECT_CAPABILITY_INVALID");
    }
    const entry: RegistryEntry = {
      grantId,
      binding: bindingFor({runId: input.runId, agentId: input.agentId, decision}),
      issuedAtMs,
      expiresAtMs: issuedAtMs + ttlMs,
      state: "issued",
      claimedAtMs: null,
      consumedAtMs: null,
      usesClaimed: 0,
    };
    this.entries.set(grantId, entry);
    return receipt(entry);
  }

  claim(
    grant: EffectCapabilityReceipt,
    expectedBinding: EffectCapabilityBinding,
  ): EffectCapabilityReceipt {
    const entry = this.entries.get(grant?.grantId);
    if (!entry) throw new EffectCapabilityError("EFFECT_CAPABILITY_INVALID");
    requireMatchingReceipt(grant, entry);
    const expected = requireExpectedBinding(expectedBinding);
    if (!sameBinding(entry.binding, expected)) {
      throw new EffectCapabilityError("EFFECT_CAPABILITY_BINDING_MISMATCH");
    }
    if (entry.state !== "issued" || entry.usesClaimed !== 0) {
      throw new EffectCapabilityError("EFFECT_CAPABILITY_ALREADY_CLAIMED");
    }
    const claimedAtMs = (this.options.now ?? Date.now)();
    if (claimedAtMs < entry.issuedAtMs || claimedAtMs >= entry.expiresAtMs) {
      throw new EffectCapabilityError("EFFECT_CAPABILITY_EXPIRED");
    }
    entry.state = "claimed";
    entry.claimedAtMs = claimedAtMs;
    entry.usesClaimed = 1;
    return receipt(entry);
  }

  consume(
    claim: EffectCapabilityReceipt,
    expectedBinding: EffectCapabilityBinding,
  ): EffectCapabilityReceipt {
    const entry = this.entries.get(claim?.grantId);
    if (!entry) throw new EffectCapabilityError("EFFECT_CAPABILITY_INVALID");
    requireMatchingReceipt(claim, entry);
    const expected = requireExpectedBinding(expectedBinding);
    if (!sameBinding(entry.binding, expected)) {
      throw new EffectCapabilityError("EFFECT_CAPABILITY_BINDING_MISMATCH");
    }
    if (entry.state === "consumed") {
      throw new EffectCapabilityError("EFFECT_CAPABILITY_ALREADY_CONSUMED");
    }
    if (entry.state !== "claimed" || entry.usesClaimed !== 1 || entry.claimedAtMs === null) {
      throw new EffectCapabilityError("EFFECT_CAPABILITY_NOT_CLAIMED");
    }
    const consumedAtMs = (this.options.now ?? Date.now)();
    if (consumedAtMs < entry.claimedAtMs || consumedAtMs >= entry.expiresAtMs) {
      throw new EffectCapabilityError("EFFECT_CAPABILITY_EXPIRED");
    }
    entry.state = "consumed";
    entry.consumedAtMs = consumedAtMs;
    return receipt(entry);
  }

  inspect(grantId: string): EffectCapabilityReceipt | null {
    const entry = this.entries.get(grantId);
    return entry ? receipt(entry) : null;
  }

  get size(): number {
    return this.entries.size;
  }
}

export function bindingFromCapability(
  capability: Pick<EffectCapabilityReceipt,
    "runId" | "agentId" | "action" | "targetClass" | "policy" | "policyVersion" | "policyDigest">,
): EffectCapabilityBinding {
  return {
    runId: capability.runId,
    agentId: capability.agentId,
    action: capability.action,
    targetClass: capability.targetClass,
    policy: capability.policy,
    policyVersion: capability.policyVersion,
    policyDigest: capability.policyDigest,
  };
}
