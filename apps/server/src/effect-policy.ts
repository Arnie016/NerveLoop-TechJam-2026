import type {
  EffectAction,
  EffectPolicyDecision,
  EffectProposal,
  EffectTargetClass,
} from "./types.js";

export const EFFECT_FIREWALL_POLICY = "effect-firewall-v1" as const;
export const EFFECT_FIREWALL_DEMO_PROMPT =
  "Run the Effect Firewall delete-asset fixture." as const;

const fixtureProposal: Readonly<EffectProposal> = Object.freeze({
  version: 1,
  action: "delete_mock_asset",
  targetClass: "protected",
});

/**
 * Explicit least-privilege lattice used by the local Effect Firewall.
 *
 * Both axes are ordered from least to most authority. A proposal is allowed
 * only while the sum of its action risk and resource sensitivity remains
 * within the fixed host ceiling. This gives the policy a monotone boundary:
 * moving right or down can never turn a denial into an allow.
 */
export const EFFECT_ACTIONS_BY_RISK = Object.freeze([
  "read_asset_metadata",
  "write_demo_result",
  "transform_media",
  "publish_candidate",
  "delete_mock_asset",
] as const satisfies readonly EffectAction[]);

export const EFFECT_TARGETS_BY_SENSITIVITY = Object.freeze([
  "scratch",
  "workspace",
  "candidate",
  "protected",
] as const satisfies readonly EffectTargetClass[]);

export const EFFECT_ACTION_RISK: Readonly<Record<EffectAction, number>> = Object.freeze({
  read_asset_metadata: 0,
  write_demo_result: 1,
  transform_media: 2,
  publish_candidate: 3,
  delete_mock_asset: 4,
});

export const EFFECT_TARGET_SENSITIVITY: Readonly<Record<EffectTargetClass, number>> = Object.freeze({
  scratch: 0,
  workspace: 1,
  candidate: 2,
  protected: 3,
});

export const EFFECT_MAX_AUTHORITY_SCORE = 2 as const;

/**
 * Exact local-fixture routing, not natural-language or keyword enforcement.
 * Near matches deliberately return null and proceed through the ordinary
 * RunGuard path.
 */
export function proposeDemoEffect(prompt: string): EffectProposal | null {
  return prompt === EFFECT_FIREWALL_DEMO_PROMPT
    ? { ...fixtureProposal }
    : null;
}

function isProposal(value: unknown): value is EffectProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).sort().join(",") === "action,targetClass,version" &&
    candidate.version === 1 &&
    typeof candidate.action === "string" &&
    Object.hasOwn(EFFECT_ACTION_RISK, candidate.action) &&
    typeof candidate.targetClass === "string" &&
    Object.hasOwn(EFFECT_TARGET_SENSITIVITY, candidate.targetClass);
}

/**
 * Host-owned monotone action/resource policy. Prompt text is never evaluated
 * here, and the typed proposal cannot widen the host ceiling.
 */
export function decideEffect(proposal: unknown): EffectPolicyDecision {
  if (!isProposal(proposal)) {
    throw new Error("EFFECT_PROPOSAL_INVALID");
  }
  const authorityScore = EFFECT_ACTION_RISK[proposal.action] +
    EFFECT_TARGET_SENSITIVITY[proposal.targetClass];
  const allowed = authorityScore <= EFFECT_MAX_AUTHORITY_SCORE;
  if (allowed) {
    return {
      version: 1,
      policy: EFFECT_FIREWALL_POLICY,
      verdict: "allowed",
      action: proposal.action,
      targetClass: proposal.targetClass,
      reason: proposal.action === "write_demo_result" && proposal.targetClass === "workspace"
        ? "explicit_workspace_allow"
        : "least_privilege_allow",
    };
  }
  return {
    version: 1,
    policy: EFFECT_FIREWALL_POLICY,
    verdict: "denied",
    action: proposal.action,
    targetClass: proposal.targetClass,
    reason: proposal.targetClass === "protected"
      ? "protected_target_denied"
      : "effect_not_allowlisted",
  };
}
