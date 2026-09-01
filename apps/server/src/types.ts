import type { RunConversation } from "./run-conversation.js";
import type { RunRoutingReceipt } from "./run-router.js";
import type { RunBudgetState } from "./run-budget.js";
import type { WorkspaceResourceState } from "./workspace-resource-governor.js";
import type { WorkspaceLifecycleOperatorActionState } from "./workspace-lifecycle-operator-actions.js";

export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  recoveryHold: {
    runId: string | null;
    reason: "rollback_failed" | "interrupted_run" | "routing_reconciliation";
    since: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export type RunGuardVerdict = "pending" | "retained" | "denied";
export type RunGuardEventKind =
  | "grant_issued"
  | "grant_denied"
  | "effect_denied_pre_dispatch"
  | "verification_retained"
  | "verification_denied"
  | "candidate_promoted"
  | "rollback_applied"
  | "rollback_failed"
  | "recovery_required";

export type RunGuardRecovery = "not_needed" | "rolled_back" | "failed";

export type EffectAction =
  | "read_asset_metadata"
  | "write_demo_result"
  | "transform_media"
  | "publish_candidate"
  | "delete_mock_asset";
export type EffectTargetClass =
  | "scratch"
  | "workspace"
  | "candidate"
  | "protected";

export interface EffectProposal {
  version: 1;
  action: EffectAction;
  targetClass: EffectTargetClass;
}

export interface EffectPolicyDecision {
  version: 1;
  policy: "effect-firewall-v1";
  verdict: "allowed" | "denied";
  action: EffectAction;
  targetClass: EffectTargetClass;
  reason:
    | "least_privilege_allow"
    | "explicit_workspace_allow"
    | "protected_target_denied"
    | "effect_not_allowlisted";
}

export interface EffectCapabilityBinding {
  runId: string;
  agentId: string;
  action: EffectAction;
  targetClass: EffectTargetClass;
  policy: "effect-firewall-v1";
  policyVersion: 1;
  policyDigest: string;
}

/**
 * Process-local causal receipt for the explicit demo-runner path. The single
 * use is spent at claim time; `consumed` means dispatch was then authorized.
 * This is correlation evidence, not a credential or durable capability.
 */
export interface EffectCapabilityReceipt extends EffectCapabilityBinding {
  version: 1;
  registry: "process-local";
  grantId: string;
  state: "issued" | "claimed" | "consumed";
  issuedAt: string;
  expiresAt: string;
  claimedAt: string | null;
  consumedAt: string | null;
  useBudget: 1;
  usesClaimed: 0 | 1;
  boundary: string;
}

export type EffectSinkState = "issued" | "spent" | "committed" | "effect_failed" | "revoked";

/**
 * Sanitized process-local sink evidence. The bearer grant itself is never
 * persisted or returned through the API; only its domain-separated digest is.
 */
export interface EffectSinkReceipt extends EffectCapabilityBinding {
  version: 1;
  broker: "process-local";
  grantSha256: string;
  parentGrantSha256: string;
  state: EffectSinkState;
  workspaceRootIdentitySha256: string;
  relativePath: string;
  payloadSha256: string;
  issuedAt: string;
  expiresAt: string;
  spentAt: string | null;
  committedAt: string | null;
  failedAt: string | null;
  closedAt: string | null;
  closeDisposition: "unredeemed" | "in_flight" | null;
  bytesCommitted: number | null;
  errorCode: string | null;
  boundary: string;
}

export interface EffectSinkWriteRequest {
  runId: string;
  agentId: string;
  action: EffectAction;
  targetClass: EffectTargetClass;
  relativePath: string;
  payload: Uint8Array;
}

export interface EffectSinkCommitReceipt {
  version: 1;
  state: "committed";
  grantSha256: string;
  relativePath: string;
  payloadSha256: string;
  bytesCommitted: number;
  committedAt: string;
}

/** Narrow trusted port attached by AgentService; it exposes no mint/inspect API. */
export interface EffectSinkPort {
  redeem(grant: string, request: EffectSinkWriteRequest): Promise<EffectSinkCommitReceipt>;
}

export interface EffectDecisionReceipt extends EffectPolicyDecision {
  workerSpawned: false;
  protectedBaselineVerifiedUnchanged: boolean;
}

export interface RunGuardReceipt {
  version: 1;
  agentId: string;
  runId: string;
  grantedScope: "agent-workspace-only";
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  verdict: RunGuardVerdict;
  denialReason: string | null;
  beforeManifestDigest: string | null;
  afterManifestDigest: string | null;
  recoveredManifestDigest: string | null;
  recovery: RunGuardRecovery;
  changedFiles: string[];
  // Additive for backward compatibility with version-1 stored receipts. Only
  // a host policy decision may populate this field; legacy receipts omit it.
  effectDecision?: EffectDecisionReceipt;
  events: Array<{
    at: string;
    kind: RunGuardEventKind;
    detail: string;
  }>;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  route: RunRoutingReceipt | null;
  guard: RunGuardReceipt | null;
  // Additive demo-only receipt. Legacy and non-fixture Runs omit it.
  effectCapability?: EffectCapabilityReceipt;
  // Sanitized sink evidence; the opaque bearer grant is never persisted.
  effectSinkReceipt?: EffectSinkReceipt;
  acceptance: TaskAcceptance;
  promotion?: CandidatePromotionCommit | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface CandidatePromotionEvidence {
  version: 1;
  runId: string;
  agentId: string;
  attemptId: string;
  jobId: string;
  datasetId: string;
  path: "src/segment-window.mjs";
  baseSha256: string;
  candidateSha256: string;
  executionSha256: string;
  baselineManifestDigest: string;
}

export interface CandidatePromotionCommit extends CandidatePromotionEvidence {
  promoterId: string;
  finalManifestDigest: string;
  committedAt: string;
}

export interface TaskAcceptance {
  version: 1;
  verifierId: string | null;
  status: "not_requested" | "pending" | "passed" | "rejected" | "error" |
    "cancelled" | "interrupted" | "not_evaluated";
  reason: "verifier_not_configured" | "awaiting_verification" | "task_verified" |
    "task_rejected" | "verifier_error" | "run_cancelled" | "server_restarted" |
    "execution_failed" | "promotion_failed" | "workspace_denied" | "routing_denied";
  checkedAt: string | null;
}

export interface TaskAcceptanceContext {
  agentId: string;
  runId: string;
  workspacePath: string;
  signal: AbortSignal;
}

// Trusted host code only. Never selected or supplied by a prompt or HTTP body.
// Hooks must be bounded, read-only and cooperatively cancellable. The service
// drains them before releasing capacity; this is not an untrusted-code sandbox.
export interface TaskAcceptanceVerifier {
  id: string;
  prepare(context: TaskAcceptanceContext): Promise<unknown>;
  verify(context: TaskAcceptanceContext & {
    checkpoint: unknown;
    run: Readonly<AgentRun>;
  }): Promise<{ accepted: boolean }>;
}

// Trusted host code only. Unlike the acceptance verifier, promote() is the one
// explicit workspace-mutation phase. It receives detached runner data and must
// return only bounded user-facing output; AgentService owns all later checks.
export interface TaskCandidatePromoter {
  id: string;
  prepare(context: TaskAcceptanceContext): Promise<unknown>;
  promote(context: TaskAcceptanceContext & {
    checkpoint: unknown;
    result: Readonly<RunnerResult>;
    baselineManifestDigest: string;
  }): Promise<{ output: string; evidence?: CandidatePromotionEvidence }>;
  // Idempotent authority closure. AgentService calls this before either
  // publication or RunGuard rollback.
  close(context: TaskAcceptanceContext & { checkpoint: unknown }): Promise<void>;
  // Restart-only reconciliation for Runs that the durable store still marks
  // queued/running. A completed database commit is never offered for rollback.
  recover?(context: {
    runs: ReadonlyArray<{
      runId: string;
      agentId: string;
      workspacePath: string;
      beforeManifestDigest: string;
    }>;
  }): Promise<Array<{ runId: string; restored: boolean; recoveredManifestDigest: string | null }>>;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  // Append-only across Agent deletion. Legacy v1 stores are normalized to null
  // on read and conservatively backfilled when enforcement is first enabled.
  runBudget: RunBudgetState | null;
  // Deployment-lifetime logical workspace-byte accounting. Legacy v1 stores
  // are normalized to null; exact state validation remains service-owned.
  workspaceResources: WorkspaceResourceState | null;
  // Bounded, digest-sealed idempotency journal for authenticated lifecycle
  // reconciliation actions. Separate from resource authority so receipt
  // history does not churn the resource ledger digest.
  workspaceLifecycleOperatorActions: WorkspaceLifecycleOperatorActionState | null;
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  runId: string;
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  // Trusted host route only. HTTP bodies, prompts, history, and model output
  // never select this value. Runners validate it before constructing argv.
  model?: string;
  // Trusted service snapshot only; not supplied by an HTTP request or the model.
  history?: RunConversation;
  // Present only for an exact allowed fixture effect. The runner receives no
  // parent capability or broker internals: only an opaque child and redeem port.
  effectSink?: Readonly<{
    grant: string;
    port: EffectSinkPort;
  }>;
}

export interface AgentRunner {
  // Optional trusted planning seam for deterministic local fixtures. It gets
  // no workspace path or execution authority and cannot dispatch an action.
  proposeEffect?(request: Readonly<Pick<RunnerRequest, "prompt">>): EffectProposal | null;
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
