import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import {
  EffectCapabilityRegistry,
  bindingFromCapability,
} from "./effect-capability.js";
import {
  EFFECT_SINK_DEMO_RESULT_PATH,
  EFFECT_SINK_DEMO_RESULT_PAYLOAD,
  ProcessLocalEffectSinkBroker,
  effectSinkPayloadSha256,
} from "./effect-sink.js";
import { decideEffect } from "./effect-policy.js";
import { RunGuard } from "./run-guard.js";
import {
  markRouteDispatched,
  parseRunRoutingReceipt,
  planRunRouteOrDeny,
  routingSha256,
  settleRunRoute,
  validateRunRoutingReceipt,
  type RunRoutingReceipt,
} from "./run-router.js";
import {
  backfillRunBudget,
  createRunBudgetState,
  parseRunBudgetPolicy,
  parseRunBudgetState,
  reserveRunBudget,
  RunBudgetError,
  settleRunBudget,
  type RunBudgetPolicy,
} from "./run-budget.js";
import { buildRunConversation, type RunConversation } from "./run-conversation.js";
import { JsonStore } from "./store.js";
import { taskAcceptance, TaskAcceptanceError } from "./task-acceptance.js";
import {
  admitWorkspace,
  archiveWorkspace,
  cancelWorkspaceGrowth,
  completeWorkspaceLifecycleArchive,
  completeWorkspaceLifecycleCreate,
  completeWorkspaceLifecycleUpdate,
  createWorkspaceResourceState,
  dispatchWorkspaceGrowth,
  markWorkspaceLifecycleIntentReconciliation,
  parseWorkspaceResourcePolicy,
  parseWorkspaceResourceState,
  prepareWorkspaceLifecycleIntent,
  reconcileWorkspaceInventory,
  recoverWorkspaceReservations,
  reserveWorkspaceGrowth,
  settleWorkspaceGrowth,
  updateWorkspaceInventory,
  workspaceLifecycleAgentSha256,
  workspaceLifecycleAgentSnapshot,
  WorkspaceResourceError,
  type WorkspaceInventoryMeasurement,
  type WorkspaceInventorySnapshot,
  type WorkspaceLifecycleAgentSnapshot,
  type WorkspaceLifecycleIntent,
  type WorkspaceLifecyclePayloadFile,
  type WorkspaceResourcePolicy,
} from "./workspace-resource-governor.js";
import {
  acceptWorkspaceLifecycleOperatorAction,
  findWorkspaceLifecycleOperatorAction,
  parseWorkspaceLifecycleOperatorActionState,
  pendingWorkspaceLifecycleOperatorActionForIntent,
  terminalizeWorkspaceLifecycleOperatorAction,
  workspaceLifecycleOperatorRequestSha256,
  type WorkspaceLifecycleOperatorActionReceipt,
  type WorkspaceLifecycleOperatorRequest,
} from "./workspace-lifecycle-operator-actions.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CandidatePromotionEvidence,
  CreateAgentInput,
  Database,
  EffectCapabilityReceipt,
  EffectPolicyDecision,
  EffectSinkPort,
  EffectSinkReceipt,
  Message,
  RunnerResult,
  TaskAcceptance,
  TaskCandidatePromoter,
  TaskAcceptanceVerifier,
  UpdateAgentInput,
} from "./types.js";
import {
  renderWorkspaceCreatePayload,
  renderWorkspaceInstructionPayload,
  type WorkspaceLifecycleProbeState,
  WorkspaceManager,
} from "./workspace.js";

const now = () => new Date().toISOString();
const sha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const boundedId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const recoveryRequired =
  "Agent state requires manual recovery review. Archive this Agent and create a fresh one to continue.";
const workspaceResourceBoundary =
  "Deployment-local logical-byte admission accounting; not a filesystem quota, inode/block limit, tenant boundary, or production capacity proof";

class EffectSinkNotCommittedError extends Error {
  constructor() {
    super("Declared cooperative effect did not commit through Effect Sink");
    this.name = "EffectSinkNotCommittedError";
  }
}

export interface WorkspaceLifecycleReconciliationItem {
  intentId: string;
  agentId: string;
  kind: WorkspaceLifecycleIntent["kind"];
  status: WorkspaceLifecycleIntent["status"];
  intentSha256: string;
  expectedAgentBeforeSha256: string | null;
  candidateAgentSha256: string | null;
  payloadManifestSha256: string;
  reservedStagingBytes: string;
  createdAt: string;
  updatedAt: string;
  probeState: WorkspaceLifecycleProbeState;
  observedBytes: string | null;
  observedInventorySha256: string | null;
  evidenceSha256: string;
  retryAvailable: boolean;
  cancelAvailable: boolean;
  recommendedAction: "wait" | "retry" | "retry_or_cancel" | "manual_review";
}

export interface WorkspaceLifecycleReconciliationReport {
  configured: boolean;
  mutationsEnabled: boolean;
  reconciliationRequired: boolean;
  ledgerSha256: string | null;
  intents: WorkspaceLifecycleReconciliationItem[];
  recentActions: WorkspaceLifecycleOperatorActionReceipt[];
  boundary: string;
}

export interface WorkspaceLifecycleOperatorResult {
  action: WorkspaceLifecycleOperatorActionReceipt;
  replayed: boolean;
  outcome: "accepted" | "completed" | "cancelled" | "unresolved";
  reconciliation: WorkspaceLifecycleReconciliationReport;
}

interface WorkspaceLifecycleOperatorSelection {
  actionId: string;
  intentId: string;
  agentId: string;
  intentSha256: string;
  ledgerSha256: string;
  evidenceSha256: string;
}

function requireVerifiedWorkspace(agent: Agent): void {
  if (agent.recoveryHold) throw new HttpError(409, recoveryRequired);
}

function lifecycleOperatorEvidenceSha256(input: {
  stateSha256: string;
  policySha256: string;
  runtimeInstanceId: string;
  intent: Readonly<WorkspaceLifecycleIntent>;
  currentAgentSha256: string | null;
  probeState: WorkspaceLifecycleProbeState;
  measurement: WorkspaceInventoryMeasurement | null;
}): string {
  return routingSha256({
    version: 1,
    stateSha256: input.stateSha256,
    policySha256: input.policySha256,
    runtimeInstanceId: input.runtimeInstanceId,
    intentId: input.intent.intentId,
    agentId: input.intent.agentId,
    kind: input.intent.kind,
    intentSha256: input.intent.intentSha256,
    expectedAgentBeforeSha256: input.intent.expectedAgentBeforeSha256,
    currentAgentSha256: input.currentAgentSha256,
    probeState: input.probeState,
    measurement: input.measurement,
  });
}

function requirePromotionEvidence(value: unknown, expected: {
  runId: string; agentId: string; baselineManifestDigest: string;
}): CandidatePromotionEvidence {
  const keys = ["agentId", "attemptId", "baseSha256", "baselineManifestDigest", "candidateSha256",
    "datasetId", "executionSha256", "jobId", "path", "runId", "version"];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== keys.join(",")) {
    throw new Error("Candidate promoter returned invalid recovery evidence");
  }
  const evidence = value as CandidatePromotionEvidence;
  if (evidence.version !== 1 || evidence.runId !== expected.runId || evidence.agentId !== expected.agentId ||
      evidence.baselineManifestDigest !== expected.baselineManifestDigest ||
      !boundedId(evidence.attemptId) || !boundedId(evidence.jobId) || !boundedId(evidence.datasetId) ||
      evidence.path !== "src/segment-window.mjs" || !sha256(evidence.baseSha256) ||
      !sha256(evidence.candidateSha256) || !sha256(evidence.executionSha256)) {
    throw new Error("Candidate promoter returned invalid recovery evidence");
  }
  return structuredClone(evidence);
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  // Reserve synchronously before admission's first await; activeExecutions alone
  // misses requests still waiting for their initial persistence operation.
  private readonly runReservations = new Set<string>();
  private readonly cancellationRequests = new Set<string>();
  private readonly acceptanceControllers = new Map<string, AbortController>();
  private readonly verifierId: string | null;
  // Short lifecycle operations are fail-fast per Agent. This closes the async
  // gaps around cancellation and archive without blocking independent Agents.
  private readonly lifecycleTransitions = new Set<string>();
  // Serializes every full-root workspace scan plus the store mutation that
  // consumes it against create/update/archive filesystem windows. Independent
  // Agents remain concurrent during model execution; only authority-changing
  // boundaries are globally ordered inside this service process.
  private workspaceAuthorityTail: Promise<void> = Promise.resolve();
  private readonly runGuard: RunGuard;
  // Intentionally process-local: a restart invalidates every outstanding demo
  // effect grant instead of reconstructing authority from a stored receipt.
  private readonly effectCapabilities = new EffectCapabilityRegistry();
  private readonly effectSinkBroker: ProcessLocalEffectSinkBroker;
  private readonly beforeInitialEffectSinkReceiptPersist: (() => void | Promise<void>) | undefined;
  private readonly onEffectSinkIssued: ((authority: Readonly<{
    grant: string;
    port: EffectSinkPort;
  }>) => void) | undefined;
  private readonly onEffectSinkClosed: ((receipt: Readonly<EffectSinkReceipt>) => void) | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly taskVerifier: TaskAcceptanceVerifier | null = null,
    private readonly candidatePromoter: TaskCandidatePromoter | null = null,
    // Internal deterministic test seam. Production never supplies this hook.
    effectSinkOptions: {
      beforeIo?: () => void | Promise<void>;
      beforeInitialReceiptPersist?: () => void | Promise<void>;
      onIssued?: (authority: Readonly<{grant: string; port: EffectSinkPort}>) => void;
      onClosed?: (receipt: Readonly<EffectSinkReceipt>) => void;
    } = {},
  ) {
    this.runGuard = new RunGuard(config.codexSandboxMode);
    this.effectSinkBroker = new ProcessLocalEffectSinkBroker(this.effectCapabilities, {
      ...(effectSinkOptions.beforeIo ? {beforeIo: effectSinkOptions.beforeIo} : {}),
    });
    this.beforeInitialEffectSinkReceiptPersist = effectSinkOptions.beforeInitialReceiptPersist;
    this.onEffectSinkIssued = effectSinkOptions.onIssued;
    this.onEffectSinkClosed = effectSinkOptions.onClosed;
    if (taskVerifier && (typeof taskVerifier.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(taskVerifier.id))) {
      throw new Error("Task verifier requires a bounded host-defined identifier");
    }
    if (candidatePromoter && !taskVerifier) {
      throw new Error("Candidate promoter requires an independent task verifier");
    }
    if (candidatePromoter && (typeof candidatePromoter.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(candidatePromoter.id))) {
      throw new Error("Candidate promoter requires a bounded host-defined identifier");
    }
    this.verifierId = taskVerifier?.id ?? null;
  }

  private workspaceResourcePolicy(): WorkspaceResourcePolicy | null {
    if (this.config.workspaceResourceMode === "off") return null;
    if (this.config.workspaceResourceMaxRetainedBytes === null ||
        this.config.workspaceResourceMaxGrowthPerRunBytes === null) {
      throw new Error("WORKSPACE_RESOURCE_CONFIGURATION_INCOMPLETE");
    }
    return parseWorkspaceResourcePolicy({
      version: 1,
      policyId: `deployment:${this.config.runtimeInstanceId}:workspace-logical-bytes-v1`,
      runtimeInstanceId: this.config.runtimeInstanceId,
      maxRetainedBytes: this.config.workspaceResourceMaxRetainedBytes,
      maxGrowthPerRunBytes: this.config.workspaceResourceMaxGrowthPerRunBytes,
    });
  }

  private alignWorkspaceSnapshot(
    snapshot: WorkspaceInventorySnapshot,
    agents: readonly Agent[],
  ): WorkspaceInventorySnapshot {
    const active = snapshot.inventories.filter(item => item.kind === "active");
    const expected = new Set(agents.map(agent => agent.id));
    const observed = new Set(active.map(item => item.agentId));
    const pathsMatch = agents.every(agent =>
      agent.workspacePath === this.workspaces.workspacePath(agent.id));
    const idsMatch = expected.size === observed.size &&
      [...expected].every(agentId => observed.has(agentId));
    return {
      version: 1,
      complete: snapshot.complete && pathsMatch && idsMatch,
      inventories: snapshot.inventories,
    };
  }

  private workspaceMeasurement(
    snapshot: WorkspaceInventorySnapshot,
    agentId: string,
    kind: WorkspaceInventoryMeasurement["kind"] = "active",
  ): WorkspaceInventoryMeasurement {
    const matches = snapshot.inventories.filter(item => item.agentId === agentId && item.kind === kind);
    if (matches.length !== 1) throw new WorkspaceResourceError("WORKSPACE_RESOURCE_INVENTORY_MISSING");
    return matches[0]!;
  }

  private workspaceAdmissionError(error: unknown): never {
    if (error instanceof WorkspaceResourceError && [
      "WORKSPACE_RESOURCE_INSUFFICIENT_AVAILABLE",
      "WORKSPACE_RESOURCE_RECONCILIATION_REQUIRED",
      "WORKSPACE_RESOURCE_SETTLEMENT_INCOMPLETE",
    ].includes(error.code)) {
      throw new HttpError(429,
        "Workspace lifecycle capacity cannot admit this Run; no runner dispatch occurred");
    }
    throw error;
  }

  private async captureWorkspaceSnapshot(): Promise<WorkspaceInventorySnapshot | null> {
    if (!this.workspaceResourcePolicy()) return null;
    const observed = await this.workspaces.inspectLifecycleInventory();
    return this.alignWorkspaceSnapshot(observed, this.store.snapshot().agents);
  }

  private finalizeWorkspaceReservation(
    database: Database,
    runId: string,
    agentId: string,
    snapshot: WorkspaceInventorySnapshot | null,
    at: string,
    strictSettlement: boolean,
  ): void {
    if (!this.workspaceResourcePolicy()) return;
    if (!database.workspaceResources) throw new Error("WORKSPACE_RESOURCE_STATE_MISSING");
    const state = parseWorkspaceResourceState(database.workspaceResources);
    const reservation = state.reservations.find(item => item.runId === runId);
    if (!reservation || reservation.agentId !== agentId) {
      throw new Error("WORKSPACE_RESOURCE_RESERVATION_MISSING");
    }
    if (reservation.status === "reserved") {
      database.workspaceResources = cancelWorkspaceGrowth(state, {runId, agentId}, at);
      return;
    }
    if (reservation.status === "cancelled" || reservation.status === "settled" ||
        reservation.status === "reconciliation_required") return;
    try {
      if (!snapshot) throw new WorkspaceResourceError("WORKSPACE_RESOURCE_SETTLEMENT_INCOMPLETE");
      // A complete root scan may observe another Agent while its own reserved
      // Run is still in flight. Adopt only this reservation's bound active
      // inventory and newly retained same-Agent quarantine; each other Agent's
      // reservation remains the sole authority for its eventual settlement.
      const observedActive = this.workspaceMeasurement(snapshot, agentId);
      const knownIds = new Set(state.inventories.map(item => item.inventoryId));
      const projected: WorkspaceInventorySnapshot = {
        version: 1,
        complete: snapshot.complete,
        inventories: [
          ...state.inventories.map(item =>
            item.inventoryId === reservation.inventoryId ? observedActive : item),
          ...snapshot.inventories.filter(item => item.agentId === agentId &&
            item.kind === "quarantine" && !knownIds.has(item.inventoryId)),
        ],
      };
      database.workspaceResources = settleWorkspaceGrowth(state,
        {runId, agentId, snapshot: projected}, at);
    } catch (error) {
      database.workspaceResources = reconcileWorkspaceInventory(state,
        {version: 1, complete: false, inventories: []}, at);
      if (strictSettlement) throw error;
    }
  }

  private agentFromLifecycleSnapshot(snapshot: Readonly<WorkspaceLifecycleAgentSnapshot>): Agent {
    return {
      id: snapshot.id,
      name: snapshot.name,
      description: snapshot.description,
      instructions: snapshot.instructions,
      status: snapshot.status,
      workspacePath: this.workspaces.workspacePath(snapshot.id),
      codexThreadId: snapshot.codexThreadId,
      lastError: snapshot.lastError,
      recoveryHold: snapshot.recoveryHold ? structuredClone(snapshot.recoveryHold) : null,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    };
  }

  private boundLifecycleIntent(
    stateLike: unknown,
    expected: Pick<WorkspaceLifecycleIntent, "intentId" | "agentId" | "intentSha256">,
  ): WorkspaceLifecycleIntent {
    const state = parseWorkspaceResourceState(stateLike);
    const intent = state.lifecycleIntents.find(item => item.intentId === expected.intentId);
    if (!intent || intent.agentId !== expected.agentId ||
        intent.intentSha256 !== expected.intentSha256) {
      throw new Error("WORKSPACE_LIFECYCLE_INTENT_CHANGED");
    }
    return intent;
  }

  private lifecycleBeforeAgent(
    intent: Readonly<WorkspaceLifecycleIntent>,
    agents: readonly Agent[],
  ): WorkspaceLifecycleAgentSnapshot | undefined {
    const agent = agents.find(item => item.id === intent.agentId);
    if (intent.kind === "create") {
      if (agent) throw new Error("WORKSPACE_LIFECYCLE_AGENT_ALREADY_EXISTS");
      return undefined;
    }
    if (!agent || workspaceLifecycleAgentSha256(agent) !== intent.expectedAgentBeforeSha256) {
      throw new Error("WORKSPACE_LIFECYCLE_AGENT_CAS_MISMATCH");
    }
    return workspaceLifecycleAgentSnapshot(agent);
  }

  private async markLifecycleIntentForReconciliation(
    expected: Pick<WorkspaceLifecycleIntent, "intentId" | "agentId" | "intentSha256">,
  ): Promise<void> {
    await this.store.mutate(database => {
      if (!database.workspaceResources) throw new Error("WORKSPACE_RESOURCE_STATE_MISSING");
      const resources = parseWorkspaceResourceState(database.workspaceResources);
      const current = this.boundLifecycleIntent(resources, expected);
      const pending = pendingWorkspaceLifecycleOperatorActionForIntent(
        database.workspaceLifecycleOperatorActions, resources.policy, current);
      const marked = markWorkspaceLifecycleIntentReconciliation(
        database.workspaceResources,
        {intentId: expected.intentId, agentId: expected.agentId},
        now(),
      );
      database.workspaceResources = marked;
      if (pending) {
        if (!database.workspaceLifecycleOperatorActions) {
          throw new Error("WORKSPACE_OPERATOR_ACTION_STATE_MISSING");
        }
        database.workspaceLifecycleOperatorActions = terminalizeWorkspaceLifecycleOperatorAction(
          database.workspaceLifecycleOperatorActions, marked.policy,
          {actionId: pending.actionId, requestSha256: pending.requestSha256,
            outcome: "unresolved", resultLedgerSha256: marked.sha256}, marked.updatedAt);
      }
    });
  }

  /**
   * Completes one exact durable filesystem/metadata lifecycle transaction.
   * Any ambiguous path, payload, Agent CAS, or inventory state is retained and
   * converted to a fail-closed reconciliation hold; no unknown path is deleted.
   */
  private async recoverWorkspaceLifecycleIntent(
    expected: Readonly<WorkspaceLifecycleIntent>,
    deferReconciliation = false,
  ): Promise<"completed" | "unresolved"> {
    const unresolved = async (intent: Readonly<WorkspaceLifecycleIntent>) => {
      if (!deferReconciliation) await this.markLifecycleIntentForReconciliation(intent);
      return "unresolved" as const;
    };
    let beforeAgent: WorkspaceLifecycleAgentSnapshot | undefined;
    try {
      const snapshot = this.store.snapshot();
      if (!snapshot.workspaceResources) throw new Error("WORKSPACE_RESOURCE_STATE_MISSING");
      const intent = this.boundLifecycleIntent(snapshot.workspaceResources, expected);
      if (intent.status !== "prepared") return "unresolved";
      beforeAgent = this.lifecycleBeforeAgent(intent, snapshot.agents);
      let probe = await this.workspaces.probeLifecycleIntent(intent, beforeAgent);
      if (probe.state === "unsafe_or_mismatch") {
        return await unresolved(intent);
      }
      if (probe.state === "exact_before" && intent.kind !== "archive") {
        probe = await this.workspaces.stageLifecycleIntent(intent, beforeAgent);
      }
      if (probe.state !== "exact_stage" && probe.state !== "exact_after" &&
          !(intent.kind === "archive" && probe.state === "exact_before")) {
        return await unresolved(intent);
      }
      const measurement = await this.workspaces.applyLifecycleIntent(intent, beforeAgent);
      await this.store.mutate(database => {
        if (!database.workspaceResources) throw new Error("WORKSPACE_RESOURCE_STATE_MISSING");
        const currentIntent = this.boundLifecycleIntent(database.workspaceResources, intent);
        this.lifecycleBeforeAgent(currentIntent, database.agents);
        const beforeResources = parseWorkspaceResourceState(database.workspaceResources);
        const pendingAction = pendingWorkspaceLifecycleOperatorActionForIntent(
          database.workspaceLifecycleOperatorActions, beforeResources.policy, currentIntent);
        const completedAt = now();
        if (currentIntent.kind === "create") {
          if (!currentIntent.candidateAgent) throw new Error("WORKSPACE_LIFECYCLE_CANDIDATE_MISSING");
          database.workspaceResources = completeWorkspaceLifecycleCreate(
            database.workspaceResources,
            {intentId: currentIntent.intentId, agentId: currentIntent.agentId, measurement},
            completedAt,
          );
          database.agents.push(this.agentFromLifecycleSnapshot(currentIntent.candidateAgent));
        } else if (currentIntent.kind === "instruction_update") {
          if (!currentIntent.candidateAgent) throw new Error("WORKSPACE_LIFECYCLE_CANDIDATE_MISSING");
          database.workspaceResources = completeWorkspaceLifecycleUpdate(
            database.workspaceResources,
            {intentId: currentIntent.intentId, agentId: currentIntent.agentId, measurement},
            completedAt,
          );
          const index = database.agents.findIndex(item => item.id === currentIntent.agentId);
          if (index < 0) throw new Error("WORKSPACE_LIFECYCLE_AGENT_CAS_MISMATCH");
          database.agents[index] = this.agentFromLifecycleSnapshot(currentIntent.candidateAgent);
        } else {
          database.workspaceResources = completeWorkspaceLifecycleArchive(
            database.workspaceResources,
            {intentId: currentIntent.intentId, agentId: currentIntent.agentId, measurement},
            completedAt,
          );
          database.agents = database.agents.filter(item => item.id !== currentIntent.agentId);
          database.messages = database.messages.filter(item => item.agentId !== currentIntent.agentId);
          database.runs = database.runs.filter(item => item.agentId !== currentIntent.agentId);
        }
        if (pendingAction) {
          if (!database.workspaceLifecycleOperatorActions) {
            throw new Error("WORKSPACE_OPERATOR_ACTION_STATE_MISSING");
          }
          const completedResources = parseWorkspaceResourceState(database.workspaceResources);
          database.workspaceLifecycleOperatorActions = terminalizeWorkspaceLifecycleOperatorAction(
            database.workspaceLifecycleOperatorActions, completedResources.policy,
            {actionId: pendingAction.actionId, requestSha256: pendingAction.requestSha256,
              outcome: "completed", resultLedgerSha256: completedResources.sha256}, completedAt);
        }
      });
      return "completed";
    } catch (error) {
      // A JsonStore failure may mean the process-local store is deliberately
      // poisoned after an uncertain commit. Let that hard failure escape; a
      // fresh process can classify the exact old-or-new durable tuple.
      try {
        const snapshot = this.store.snapshot();
        if (!snapshot.workspaceResources) throw error;
        const current = parseWorkspaceResourceState(snapshot.workspaceResources)
          .lifecycleIntents.find(item => item.intentId === expected.intentId);
        if (!current || current.intentSha256 !== expected.intentSha256) return "completed";
        if (current.status === "reconciliation_required") return "unresolved";
        return await unresolved(current);
      } catch {
        throw error;
      }
    }
  }

  private async recoverWorkspaceLifecycleIntents(): Promise<void> {
    const snapshot = this.store.snapshot();
    if (!snapshot.workspaceResources) return;
    const state = parseWorkspaceResourceState(snapshot.workspaceResources);
    const unresolved: WorkspaceLifecycleIntent[] = [];
    // First recover every singly explainable intent while the global ledger is
    // still open. Only after that pass do ambiguous intents publish the global
    // reconciliation hold, so UUID ordering cannot strand an unrelated exact
    // transaction after its filesystem rename but before its metadata commit.
    for (const intent of state.lifecycleIntents) {
      if (intent.status !== "prepared") continue;
      if (await this.recoverWorkspaceLifecycleIntent(intent, true) === "unresolved") {
        const current = this.store.snapshot().workspaceResources;
        if (!current) throw new Error("WORKSPACE_RESOURCE_STATE_MISSING");
        const retained = parseWorkspaceResourceState(current).lifecycleIntents
          .find(item => item.intentId === intent.intentId);
        if (retained?.status === "prepared") unresolved.push(retained);
      }
    }
    for (const intent of unresolved) {
      await this.markLifecycleIntentForReconciliation(intent);
    }
  }

  private async withWorkspaceAuthority<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.workspaceAuthorityTail;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    this.workspaceAuthorityTail = predecessor.then(() => gate);
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    const initialWorkspacePolicy = this.workspaceResourcePolicy();
    const initialWorkspaceState = this.store.snapshot().workspaceResources;
    if (initialWorkspacePolicy && initialWorkspaceState) {
      const parsed = parseWorkspaceResourceState(initialWorkspaceState);
      if (parsed.policy.policySha256 !== initialWorkspacePolicy.policySha256) {
        throw new Error("WORKSPACE_RESOURCE_POLICY_MISMATCH");
      }
      const initialActions = this.store.snapshot().workspaceLifecycleOperatorActions;
      if (initialActions) parseWorkspaceLifecycleOperatorActionState(initialActions, parsed.policy);
      // Intent-owned stage names are intentionally unknown to the general
      // scanner. Resolve exact intents before the scanner can classify them as
      // unexplained drift and close admission globally.
      await this.recoverWorkspaceLifecycleIntents();
    } else if (this.store.snapshot().workspaceLifecycleOperatorActions !== null) {
      throw new Error("WORKSPACE_OPERATOR_ACTION_RESOURCE_STATE_MISSING");
    }
    const persisted = this.store.snapshot();
    const recoverable = persisted.runs.flatMap((run) => {
      const agent = persisted.agents.find((item) => item.id === run.agentId);
      return (run.status === "queued" || run.status === "running") && agent &&
        sha256(run.guard?.beforeManifestDigest)
        ? [{ runId: run.id, agentId: run.agentId, workspacePath: agent.workspacePath,
            beforeManifestDigest: run.guard.beforeManifestDigest }]
        : [];
    });
    const recoveredRuns = new Map<string, string>();
    if (this.candidatePromoter?.recover && recoverable.length > 0) {
      try {
        const outcomes = await this.candidatePromoter.recover({ runs: structuredClone(recoverable) });
        if (!Array.isArray(outcomes) || outcomes.length > recoverable.length) {
          throw new Error("Candidate recovery returned an invalid result");
        }
        const seen = new Set<string>();
        for (const outcome of outcomes) {
          if (!outcome || typeof outcome !== "object" || Array.isArray(outcome) ||
              Object.keys(outcome).sort().join(",") !== "recoveredManifestDigest,restored,runId" ||
              !boundedId(outcome.runId) || typeof outcome.restored !== "boolean" ||
              (outcome.recoveredManifestDigest !== null && !sha256(outcome.recoveredManifestDigest)) ||
              seen.has(outcome.runId)) {
            throw new Error("Candidate recovery returned an invalid result");
          }
          seen.add(outcome.runId);
          const expected = recoverable.find((item) => item.runId === outcome.runId);
          if (!expected) throw new Error("Candidate recovery returned an unknown Run");
          if (!outcome.restored) continue;
          const observed = await this.runGuard.inspectManifestDigest(expected.workspacePath);
          if (observed === expected.beforeManifestDigest && outcome.recoveredManifestDigest === observed) {
            recoveredRuns.set(outcome.runId, observed);
          }
        }
      } catch {
        // A malformed, incomplete, or failed recovery remains on the existing
        // conservative hold path below. No hook result is trusted by itself.
        recoveredRuns.clear();
      }
    }
    const configuredWorkspacePolicy = initialWorkspacePolicy;
    const observedWorkspaceSnapshot = configuredWorkspacePolicy
      ? await this.workspaces.inspectLifecycleInventory() : null;
    await this.store.mutate((database) => {
      const timestamp = now();
      if (configuredWorkspacePolicy) {
        const aligned = this.alignWorkspaceSnapshot(observedWorkspaceSnapshot!, database.agents);
        if (database.workspaceResources === null) {
          database.workspaceResources = createWorkspaceResourceState(
            configuredWorkspacePolicy, aligned, timestamp);
        } else {
          let state = parseWorkspaceResourceState(database.workspaceResources);
          if (state.policy.policySha256 !== configuredWorkspacePolicy.policySha256) {
            throw new Error("WORKSPACE_RESOURCE_POLICY_MISMATCH");
          }
          state = recoverWorkspaceReservations(state, timestamp);
          database.workspaceResources = reconcileWorkspaceInventory(state, aligned, timestamp);
        }
      } else if (database.workspaceResources !== null) {
        // Removing a persistent cap must not make retained or uncertain bytes
        // disappear from the authority ledger.
        throw new Error("WORKSPACE_RESOURCE_CONFIGURATION_REMOVED");
      }
      if (database.workspaceLifecycleOperatorActions !== null) {
        if (!database.workspaceResources) throw new Error("WORKSPACE_OPERATOR_ACTION_RESOURCE_STATE_MISSING");
        parseWorkspaceLifecycleOperatorActionState(database.workspaceLifecycleOperatorActions,
          parseWorkspaceResourceState(database.workspaceResources).policy);
      }
      const configuredBudget = this.runBudgetPolicy();
      if (configuredBudget) {
        if (database.runBudget === null) {
          database.runBudget = createRunBudgetState(configuredBudget, timestamp);
        } else {
          const storedBudget = parseRunBudgetState(database.runBudget);
          if (storedBudget.policy.policySha256 !== configuredBudget.policySha256) {
            throw new Error("RUN_BUDGET_POLICY_MISMATCH");
          }
          database.runBudget = storedBudget;
        }
      } else if (database.runBudget !== null) {
        // Removing the environment cap must not silently launder retained work.
        throw new Error("RUN_BUDGET_CONFIGURATION_REMOVED");
      }
      // Version-1 stores may predate persistent recovery holds.
      for (const agent of database.agents) agent.recoveryHold ??= null;
      for (const run of database.runs) {
        // Existing Runs are never retroactively claimed as task-verified.
        run.acceptance ??= taskAcceptance(null);
        run.promotion ??= null;
        run.route ??= null;
        let routeInvalid = false;
        if (run.route) {
          try {
            const parsed = parseRunRoutingReceipt(run.route);
            if (parsed.binding.runId !== run.id || parsed.binding.agentId !== run.agentId ||
                (parsed.status !== "denied" && parsed.selection.provider !== "volcengine_ark")) {
              throw new Error("RUN_ROUTE_BINDING_INVALID");
            }
            run.route = parsed.status === "dispatched" ? settleRunRoute(parsed, null, timestamp) : parsed;
            if (database.runBudget) {
              database.runBudget = backfillRunBudget(database.runBudget, run.route, timestamp);
            }
          } catch {
            if (database.runBudget) throw new Error("RUN_BUDGET_RECONCILIATION_REQUIRED");
            routeInvalid = true;
            if (run.status === "queued" || run.status === "running") run.status = "cancelled";
            run.error = "Routing receipt requires manual reconciliation";
            run.completedAt ??= timestamp;
            run.output = null;
            if (run.acceptance.status !== "not_requested") {
              run.acceptance = taskAcceptance(run.acceptance.verifierId, "interrupted", "server_restarted");
            }
            const agent = database.agents.find((item) => item.id === run.agentId);
            if (agent && !agent.recoveryHold) {
              agent.recoveryHold = {runId: run.id, reason: "routing_reconciliation", since: timestamp};
            }
          }
        }
        if (routeInvalid) continue;
        if (run.status === "queued" || run.status === "running") {
          const recoveredDigest = recoveredRuns.get(run.id);
          run.status = "cancelled";
          run.error = recoveredDigest
            ? "Server restarted while this run was active; the exact pre-Run workspace was restored"
            : "Server restarted while this run was active; workspace recovery is unverified";
          run.completedAt = timestamp;
          run.output = null;
          run.usage = null;
          if (run.acceptance.status !== "not_requested") {
            run.acceptance = taskAcceptance(run.acceptance.verifierId, "interrupted", "server_restarted");
          }
          if (run.guard) {
            run.guard.verdict = "denied";
            run.guard.recovery = recoveredDigest ? "rolled_back" : "failed";
            run.guard.recoveredManifestDigest = recoveredDigest ?? null;
            run.guard.denialReason = recoveredDigest
              ? "Run interrupted before publication; durable promotion recovery restored the RunGuard baseline"
              : "RunGuard checkpoint is unavailable after server restart";
            run.guard.events.push({
              at: timestamp,
              kind: recoveredDigest ? "rollback_applied" : "recovery_required",
              detail: recoveredDigest
                ? "journaled candidate promotion restored and independently matched the pre-Run manifest"
                : "interrupted Run has no surviving in-memory checkpoint; workspace remains on hold",
            });
          }
          const agent = database.agents.find((item) => item.id === run.agentId);
          if (agent && recoveredDigest) {
            agent.recoveryHold = null;
            if (agent.status !== "stopped") agent.status = "ready";
            agent.codexThreadId = null;
            agent.lastError = null;
            agent.updatedAt = timestamp;
          } else if (agent && !agent.recoveryHold) {
            agent.recoveryHold = { runId: run.id, reason: "interrupted_run", since: timestamp };
          }
        } else if (run.guard?.recovery === "failed") {
          // A legacy failed rollback is not made safe by accepting a newer baseline.
          const agent = database.agents.find((item) => item.id === run.agentId);
          if (agent && !agent.recoveryHold) {
            agent.recoveryHold = { runId: run.id, reason: "rollback_failed", since: timestamp };
          }
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy" && !agent.recoveryHold) {
          agent.recoveryHold = { runId: null, reason: "interrupted_run", since: timestamp };
        }
        if (agent.recoveryHold) {
          if (agent.status !== "stopped") agent.status = "error";
          agent.codexThreadId = null;
          agent.lastError = recoveryRequired;
        }
      }
      if (database.runBudget) {
        const budget = parseRunBudgetState(database.runBudget);
        for (const entry of budget.entries) {
          const run = database.runs.find(item => item.id === entry.runId);
          if (!run) {
            if (entry.status === "reserved" || entry.status === "dispatched") {
              throw new Error("RUN_BUDGET_ORPHAN_ACTIVE_ENTRY");
            }
            continue;
          }
          if (!run.route || run.agentId !== entry.agentId ||
              run.route.receiptSha256 !== entry.currentReceipt.receiptSha256) {
            throw new Error("RUN_BUDGET_RUN_BINDING_INVALID");
          }
        }
        database.runBudget = budget;
      }
    });
  }

  private operatorLifecycleIntent(
    input: WorkspaceLifecycleOperatorSelection,
  ): WorkspaceLifecycleIntent {
    const rawState = this.store.snapshot().workspaceResources;
    if (!rawState) throw new HttpError(409, "Workspace lifecycle accounting is not configured");
    const state = parseWorkspaceResourceState(rawState);
    if (state.sha256 !== input.ledgerSha256) {
      throw new HttpError(409, "Workspace reconciliation ledger changed; refresh before acting");
    }
    const intent = state.lifecycleIntents.find(item => item.intentId === input.intentId);
    if (!intent || intent.agentId !== input.agentId || intent.intentSha256 !== input.intentSha256) {
      throw new HttpError(409, "Lifecycle reconciliation evidence changed; refresh before acting");
    }
    if (intent.status !== "reconciliation_required") {
      throw new HttpError(409, "Lifecycle intent is not awaiting operator reconciliation");
    }
    return intent;
  }

  private operatorLifecycleBeforeAgent(
    intent: Readonly<WorkspaceLifecycleIntent>,
  ): WorkspaceLifecycleAgentSnapshot | undefined {
    try {
      return this.lifecycleBeforeAgent(intent, this.store.snapshot().agents);
    } catch {
      throw new HttpError(409, "Lifecycle Agent evidence changed; no operator action was applied");
    }
  }

  private async inspectWorkspaceLifecycleReconciliationUnlocked():
  Promise<WorkspaceLifecycleReconciliationReport> {
    const rawState = this.store.snapshot().workspaceResources;
    if (!rawState) {
      return {
        configured: false,
        mutationsEnabled: this.config.authToken.length > 0,
        reconciliationRequired: false,
        ledgerSha256: null,
        intents: [],
        recentActions: [],
        boundary: "No workspace lifecycle accounting policy is configured",
      };
    }
    const state = parseWorkspaceResourceState(rawState);
    const intents: WorkspaceLifecycleReconciliationItem[] = [];
    for (const intent of state.lifecycleIntents) {
      let probeState: WorkspaceLifecycleProbeState = "unsafe_or_mismatch";
      let measurement: WorkspaceInventoryMeasurement | null = null;
      let currentAgentSha256: string | null = null;
      try {
        const beforeAgent = this.lifecycleBeforeAgent(intent, this.store.snapshot().agents);
        currentAgentSha256 = beforeAgent ? workspaceLifecycleAgentSha256(beforeAgent) : null;
        const probe = await this.workspaces.probeLifecycleIntent(intent, beforeAgent);
        probeState = probe.state;
        measurement = probe.measurement;
      } catch {
        // Agent-CAS and path/payload mismatches remain a visible fail-closed
        // classification. Do not expose raw filesystem errors or file bytes.
      }
      const actionable = intent.status === "reconciliation_required" &&
        probeState !== "unsafe_or_mismatch";
      const cancelAvailable = actionable && probeState === "exact_before";
      intents.push({
        intentId: intent.intentId,
        agentId: intent.agentId,
        kind: intent.kind,
        status: intent.status,
        intentSha256: intent.intentSha256,
        expectedAgentBeforeSha256: intent.expectedAgentBeforeSha256,
        candidateAgentSha256: intent.candidateAgentSha256,
        payloadManifestSha256: intent.payloadManifestSha256,
        reservedStagingBytes: String(intent.reservedStagingBytes),
        createdAt: intent.createdAt,
        updatedAt: intent.updatedAt,
        probeState,
        observedBytes: measurement ? String(measurement.bytes) : null,
        observedInventorySha256: measurement?.inventorySha256 ?? null,
        evidenceSha256: lifecycleOperatorEvidenceSha256({
          stateSha256: state.sha256,
          policySha256: state.policy.policySha256,
          runtimeInstanceId: state.policy.runtimeInstanceId,
          intent,
          currentAgentSha256,
          probeState,
          measurement,
        }),
        retryAvailable: actionable,
        cancelAvailable,
        recommendedAction: intent.status === "prepared"
          ? "wait"
          : probeState === "unsafe_or_mismatch"
            ? "manual_review"
            : cancelAvailable
              ? "retry_or_cancel"
              : "retry",
      });
    }
    const actionState = this.store.snapshot().workspaceLifecycleOperatorActions;
    const recentActions = actionState
      ? parseWorkspaceLifecycleOperatorActionState(actionState, state.policy).receipts.slice(-10)
      : [];
    return {
      configured: true,
      mutationsEnabled: this.config.authToken.length > 0,
      reconciliationRequired: state.reconciliationRequired,
      ledgerSha256: state.sha256,
      intents,
      recentActions,
      boundary: "Authenticated digest-CAS retry/cancel with a bounded durable replay journal; no arbitrary acceptance, cleanup, unknown-byte deletion, operator-identity claim, or unbounded audit history",
    };
  }

  private async refreshWorkspaceReconciliationHold(): Promise<void> {
    const observed = await this.workspaces.inspectLifecycleInventory();
    await this.store.mutate(database => {
      if (!database.workspaceResources) throw new Error("WORKSPACE_RESOURCE_STATE_MISSING");
      const aligned = this.alignWorkspaceSnapshot(observed, database.agents);
      database.workspaceResources = reconcileWorkspaceInventory(
        database.workspaceResources, aligned, now());
    });
  }

  async inspectWorkspaceLifecycleReconciliation():
  Promise<WorkspaceLifecycleReconciliationReport> {
    return this.withWorkspaceAuthority(() =>
      this.inspectWorkspaceLifecycleReconciliationUnlocked());
  }

  private existingWorkspaceLifecycleOperatorAction(
    request: WorkspaceLifecycleOperatorRequest,
  ): WorkspaceLifecycleOperatorActionReceipt | null {
    const snapshot = this.store.snapshot();
    if (!snapshot.workspaceResources) {
      throw new HttpError(409, "Workspace lifecycle accounting is not configured");
    }
    const resources = parseWorkspaceResourceState(snapshot.workspaceResources);
    const receipt = findWorkspaceLifecycleOperatorAction(
      snapshot.workspaceLifecycleOperatorActions, resources.policy, request.actionId);
    if (!receipt) return null;
    if (receipt.requestSha256 !== workspaceLifecycleOperatorRequestSha256(request)) {
      throw new HttpError(409, "Operator action ID was already used with different evidence");
    }
    return receipt;
  }

  private async workspaceLifecycleOperatorResult(
    action: WorkspaceLifecycleOperatorActionReceipt,
    replayed: boolean,
  ): Promise<WorkspaceLifecycleOperatorResult> {
    return {
      action,
      replayed,
      outcome: action.outcome ?? "accepted",
      reconciliation: await this.inspectWorkspaceLifecycleReconciliationUnlocked(),
    };
  }

  async getWorkspaceLifecycleOperatorAction(actionId: string):
  Promise<WorkspaceLifecycleOperatorResult> {
    return this.withWorkspaceAuthority(async () => {
      const snapshot = this.store.snapshot();
      if (!snapshot.workspaceResources) {
        throw new HttpError(409, "Workspace lifecycle accounting is not configured");
      }
      const resources = parseWorkspaceResourceState(snapshot.workspaceResources);
      const action = findWorkspaceLifecycleOperatorAction(
        snapshot.workspaceLifecycleOperatorActions, resources.policy, actionId);
      if (!action) throw new HttpError(404, "Operator action receipt was not found or was pruned");
      return this.workspaceLifecycleOperatorResult(action, true);
    });
  }

  async retryWorkspaceLifecycleIntent(input: {
    actionId: string; intentId: string; agentId: string; intentSha256: string;
    ledgerSha256: string; evidenceSha256: string;
  }): Promise<WorkspaceLifecycleOperatorResult> {
    return this.withLifecycleTransitionKey(input.agentId, () => this.withWorkspaceAuthority(async () => {
      const request: WorkspaceLifecycleOperatorRequest = {action: "retry", ...input};
      const replay = this.existingWorkspaceLifecycleOperatorAction(request);
      if (replay) return this.workspaceLifecycleOperatorResult(replay, true);
      const selected = this.operatorLifecycleIntent(input);
      const beforeAgent = this.operatorLifecycleBeforeAgent(selected);
      const probe = await this.workspaces.probeLifecycleIntent(selected, beforeAgent);
      const state = parseWorkspaceResourceState(this.store.snapshot().workspaceResources);
      const evidenceSha256 = lifecycleOperatorEvidenceSha256({
        stateSha256: state.sha256,
        policySha256: state.policy.policySha256,
        runtimeInstanceId: state.policy.runtimeInstanceId,
        intent: selected,
        currentAgentSha256: beforeAgent ? workspaceLifecycleAgentSha256(beforeAgent) : null,
        probeState: probe.state,
        measurement: probe.measurement,
      });
      if (evidenceSha256 !== input.evidenceSha256) {
        throw new HttpError(409, "Lifecycle reconciliation evidence changed; refresh before acting");
      }
      if (probe.state === "unsafe_or_mismatch") {
        throw new HttpError(409,
          "Lifecycle evidence is ambiguous or mismatched; retry is denied and all paths are preserved");
      }

      const accepted = await this.store.mutate(database => {
        if (!database.workspaceResources) throw new Error("WORKSPACE_RESOURCE_STATE_MISSING");
        const current = this.boundLifecycleIntent(database.workspaceResources, input);
        this.lifecycleBeforeAgent(current, database.agents);
        const transition = acceptWorkspaceLifecycleOperatorAction(
          database.workspaceResources, database.workspaceLifecycleOperatorActions, request, now());
        database.workspaceResources = transition.workspaceResources;
        database.workspaceLifecycleOperatorActions = transition.operatorActions;
        return transition.receipt;
      });
      const reopenedState = parseWorkspaceResourceState(this.store.snapshot().workspaceResources);
      const reopened = reopenedState.lifecycleIntents.find(item => item.intentId === input.intentId);
      if (!reopened || reopened.status !== "prepared" ||
          reopened.intentSha256 !== accepted.afterIntentSha256) {
        throw new Error("WORKSPACE_LIFECYCLE_REOPEN_FAILED");
      }
      const outcome = await this.recoverWorkspaceLifecycleIntent(reopened);
      if (outcome === "completed") await this.refreshWorkspaceReconciliationHold();
      const final = this.existingWorkspaceLifecycleOperatorAction(request);
      if (!final || final.status !== "terminal" || final.outcome !== outcome) {
        throw new Error("WORKSPACE_OPERATOR_ACTION_TERMINAL_RECEIPT_MISSING");
      }
      return this.workspaceLifecycleOperatorResult(final, false);
    }));
  }

  async cancelWorkspaceLifecycleIntent(input: {
    actionId: string; intentId: string; agentId: string; intentSha256: string;
    ledgerSha256: string; evidenceSha256: string;
  }): Promise<WorkspaceLifecycleOperatorResult> {
    return this.withLifecycleTransitionKey(input.agentId, () => this.withWorkspaceAuthority(async () => {
      const request: WorkspaceLifecycleOperatorRequest = {action: "cancel", ...input};
      const replay = this.existingWorkspaceLifecycleOperatorAction(request);
      if (replay) return this.workspaceLifecycleOperatorResult(replay, true);
      const selected = this.operatorLifecycleIntent(input);
      const beforeAgent = this.operatorLifecycleBeforeAgent(selected);
      const probe = await this.workspaces.probeLifecycleIntent(selected, beforeAgent);
      const state = parseWorkspaceResourceState(this.store.snapshot().workspaceResources);
      const evidenceSha256 = lifecycleOperatorEvidenceSha256({
        stateSha256: state.sha256,
        policySha256: state.policy.policySha256,
        runtimeInstanceId: state.policy.runtimeInstanceId,
        intent: selected,
        currentAgentSha256: beforeAgent ? workspaceLifecycleAgentSha256(beforeAgent) : null,
        probeState: probe.state,
        measurement: probe.measurement,
      });
      if (evidenceSha256 !== input.evidenceSha256) {
        throw new HttpError(409, "Lifecycle reconciliation evidence changed; refresh before acting");
      }
      if (probe.state !== "exact_before") {
        throw new HttpError(409,
          "Only an untouched exact-before lifecycle intent can be cancelled; all paths are preserved");
      }
      const receipt = await this.store.mutate(database => {
        if (!database.workspaceResources) throw new Error("WORKSPACE_RESOURCE_STATE_MISSING");
        const current = this.boundLifecycleIntent(database.workspaceResources, input);
        this.lifecycleBeforeAgent(current, database.agents);
        const transition = acceptWorkspaceLifecycleOperatorAction(
          database.workspaceResources, database.workspaceLifecycleOperatorActions, request, now());
        database.workspaceResources = transition.workspaceResources;
        database.workspaceLifecycleOperatorActions = transition.operatorActions;
        return transition.receipt;
      });
      await this.refreshWorkspaceReconciliationHold();
      return this.workspaceLifecycleOperatorResult(receipt, false);
    }));
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      recoveryHold: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (!this.workspaceResourcePolicy()) {
      await this.workspaces.create(agent);
      await this.store.mutate((database) => database.agents.push(agent));
      return agent;
    }
    return this.withWorkspaceAuthority(async () => {
      const intentId = randomUUID();
      const candidateAgent = workspaceLifecycleAgentSnapshot(agent);
      const payload = renderWorkspaceCreatePayload(candidateAgent);
      const paths = this.workspaces.lifecycleCreatePaths(id, intentId);
      try {
        await this.store.mutate((database) => {
        if (!database.workspaceResources) throw new Error("WORKSPACE_RESOURCE_STATE_MISSING");
        if (database.agents.some(item => item.id === id)) {
          throw new Error("WORKSPACE_LIFECYCLE_AGENT_ALREADY_EXISTS");
        }
        database.workspaceResources = prepareWorkspaceLifecycleIntent(
          database.workspaceResources,
          {
            intentId,
            kind: "create",
            agentId: id,
            expectedAgentBeforeSha256: null,
            candidateAgent,
            ...paths,
            beforeInventory: null,
            reservedStagingBytes: payload.reduce((sum, file) =>
              sum + Buffer.byteLength(file.utf8, "utf8"), 0),
            payload,
          },
          timestamp,
        );
        });
      } catch (error) {
        this.workspaceAdmissionError(error);
      }
      const prepared = parseWorkspaceResourceState(this.store.snapshot().workspaceResources)
        .lifecycleIntents.find(item => item.intentId === intentId);
      if (!prepared) throw new Error("WORKSPACE_LIFECYCLE_INTENT_MISSING");
      await this.recoverWorkspaceLifecycleIntent(prepared);
      const created = this.store.snapshot().agents.find(item => item.id === id);
      if (!created) {
        throw new HttpError(409, "Workspace creation requires lifecycle reconciliation");
      }
      return created;
    });
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    return this.withLifecycleTransition(id, async () => {
      const current = this.getAgent(id);
      requireVerifiedWorkspace(current);
      if (current.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      const candidate = structuredClone(current);
      if (input.name !== undefined) candidate.name = input.name.trim();
      if (input.description !== undefined) candidate.description = input.description.trim();
      if (input.instructions !== undefined) candidate.instructions = input.instructions.trim();
      candidate.lastError = null;
      candidate.updatedAt = now();
      if (!this.workspaceResourcePolicy()) {
        const updated = await this.store.mutate((database) => {
          const agent = database.agents.find((item) => item.id === id);
          if (!agent) throw new HttpError(404, "Agent not found");
          requireVerifiedWorkspace(agent);
          if (agent.status === "busy") {
            throw new HttpError(409, "Stop the active run before editing this Agent");
          }
          Object.assign(agent, candidate);
          return structuredClone(agent);
        });
        await this.workspaces.writeInstructions(updated);
        return updated;
      }
      return this.withWorkspaceAuthority(async () => {
        const intentId = randomUUID();
        const candidateAgent = workspaceLifecycleAgentSnapshot(candidate);
        const payload = renderWorkspaceInstructionPayload(candidateAgent);
        const paths = this.workspaces.lifecycleInstructionUpdatePaths(id, intentId);
        try {
          await this.store.mutate((database) => {
          const agent = database.agents.find((item) => item.id === id);
          if (!agent) throw new HttpError(404, "Agent not found");
          requireVerifiedWorkspace(agent);
          if (agent.status === "busy" ||
              workspaceLifecycleAgentSha256(agent) !== workspaceLifecycleAgentSha256(current)) {
            throw new HttpError(409, "Agent changed while its workspace update was being measured");
          }
          if (!database.workspaceResources) throw new Error("WORKSPACE_RESOURCE_STATE_MISSING");
          const state = parseWorkspaceResourceState(database.workspaceResources);
          const beforeInventory = state.inventories.find(item =>
            item.kind === "active" && item.agentId === id);
          if (!beforeInventory) throw new Error("WORKSPACE_RESOURCE_ACTIVE_INVENTORY_MISSING");
          database.workspaceResources = prepareWorkspaceLifecycleIntent(
            state,
            {
              intentId,
              kind: "instruction_update",
              agentId: id,
              expectedAgentBeforeSha256: workspaceLifecycleAgentSha256(agent),
              candidateAgent,
              ...paths,
              beforeInventory,
              reservedStagingBytes: payload.reduce((sum, file) =>
                sum + Buffer.byteLength(file.utf8, "utf8"), 0),
              payload,
            },
            now(),
          );
          });
        } catch (error) {
          this.workspaceAdmissionError(error);
        }
        const prepared = parseWorkspaceResourceState(this.store.snapshot().workspaceResources)
          .lifecycleIntents.find(item => item.intentId === intentId);
        if (!prepared) throw new Error("WORKSPACE_LIFECYCLE_INTENT_MISSING");
        await this.recoverWorkspaceLifecycleIntent(prepared);
        const updated = this.store.snapshot().agents.find(item => item.id === id);
        if (!updated || workspaceLifecycleAgentSha256(updated) !==
            workspaceLifecycleAgentSha256(candidateAgent)) {
          throw new HttpError(409, "Workspace update requires lifecycle reconciliation");
        }
        return updated;
      });
    });
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    return this.withLifecycleTransition(id, async () => {
      const agent = this.getAgent(id);
      await this.cancelExecution(id);
      const currentBudget = this.store.snapshot().runBudget;
      if (currentBudget) {
        const budget = parseRunBudgetState(currentBudget);
        if (budget.entries.some(entry => entry.agentId === id &&
            (entry.status === "reserved" || entry.status === "dispatched"))) {
          throw new HttpError(409, "Agent still has an unresolved synthetic budget reservation");
        }
      }
      const resourceState = this.store.snapshot().workspaceResources;
      if (resourceState) {
        const parsed = parseWorkspaceResourceState(resourceState);
        if (parsed.reservations.some(entry => entry.agentId === id &&
            (entry.status === "reserved" || entry.status === "dispatched" ||
              entry.status === "reconciliation_required"))) {
          throw new HttpError(409, "Agent still has an unresolved workspace growth reservation");
        }
      }
      if (!this.workspaceResourcePolicy()) {
        const archivedWorkspace = await this.workspaces.archive(agent);
        await this.store.mutate((database) => {
          database.agents = database.agents.filter((item) => item.id !== id);
          database.messages = database.messages.filter((item) => item.agentId !== id);
          database.runs = database.runs.filter((item) => item.agentId !== id);
        });
        return {archivedWorkspace};
      }
      return this.withWorkspaceAuthority(async () => {
        const intentId = randomUUID();
        const preparedAt = now();
        const paths = this.workspaces.lifecycleArchivePaths(id, preparedAt);
        try {
          await this.store.mutate(database => {
          const storedAgent = database.agents.find(item => item.id === id);
          if (!storedAgent || workspaceLifecycleAgentSha256(storedAgent) !==
              workspaceLifecycleAgentSha256(agent)) {
            throw new HttpError(409, "Agent changed while archive was being prepared");
          }
          if (!database.workspaceResources) throw new Error("WORKSPACE_RESOURCE_STATE_MISSING");
          const state = parseWorkspaceResourceState(database.workspaceResources);
          const beforeInventory = state.inventories.find(item =>
            item.kind === "active" && item.agentId === id);
          if (!beforeInventory) throw new Error("WORKSPACE_RESOURCE_ACTIVE_INVENTORY_MISSING");
          database.workspaceResources = prepareWorkspaceLifecycleIntent(
            state,
            {
              intentId,
              kind: "archive",
              agentId: id,
              expectedAgentBeforeSha256: workspaceLifecycleAgentSha256(storedAgent),
              candidateAgent: null,
              ...paths,
              beforeInventory,
              reservedStagingBytes: 0,
              payload: [],
            },
            preparedAt,
          );
          });
        } catch (error) {
          this.workspaceAdmissionError(error);
        }
        const prepared = parseWorkspaceResourceState(this.store.snapshot().workspaceResources)
          .lifecycleIntents.find(item => item.intentId === intentId);
        if (!prepared) throw new Error("WORKSPACE_LIFECYCLE_INTENT_MISSING");
        await this.recoverWorkspaceLifecycleIntent(prepared);
        if (this.store.snapshot().agents.some(item => item.id === id)) {
          throw new HttpError(409, "Workspace archive requires lifecycle reconciliation");
        }
        const archivedWorkspace = path.join(
          path.dirname(agent.workspacePath),
          ...prepared.destinationRelative.split("/"),
        );
        return {archivedWorkspace};
      });
    });
  }

  async startAgent(id: string): Promise<Agent> {
    return this.withLifecycleTransition(id, () => this.setStatus(id, "ready"));
  }

  async stopAgent(id: string): Promise<Agent> {
    return this.withLifecycleTransition(id, async () => {
      await this.cancelExecution(id);
      return this.setStatus(id, "stopped");
    });
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    return this.withLifecycleTransition(agentId, () => this.admitMessage(agentId, prompt));
  }

  private async admitMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!this.config.demoRunner && !isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const current = this.getAgent(agentId);
    requireVerifiedWorkspace(current);
    if (current.status === "stopped") throw new HttpError(409, "Start the Agent before sending a message");
    if (current.status === "busy" || this.runReservations.has(agentId)) {
      throw new HttpError(409, "This Agent is already running or finishing a Run");
    }
    if (this.runReservations.size >= this.config.maxConcurrentRuns) {
      throw new HttpError(429, "Run capacity is full. Wait for an active Run to finish, then retry.");
    }
    this.runReservations.add(agentId);
    try {
      return await this.persistAndStartMessage(agentId, prompt);
    } catch (error) {
      this.runReservations.delete(agentId);
      throw error;
    }
  }

  private async persistAndStartMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    const timestamp = now();
    const runId = randomUUID();
    const route = this.planRoute(runId, agentId, timestamp);
    const run: AgentRun = {
      id: runId,
      agentId,
      status: route?.status === "denied" ? "failed" : "queued",
      prompt,
      output: null,
      error: route?.status === "denied" ? "Run routing denied: " + route.errorCode : null,
      usage: null,
      route,
      guard: null,
      acceptance: route?.status === "denied"
        ? taskAcceptance(this.verifierId, "not_evaluated", "routing_denied")
        : taskAcceptance(this.verifierId),
      promotion: null,
      startedAt: null,
      completedAt: route?.status === "denied" ? timestamp : null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const persistAdmission = async () => {
      const observedWorkspaceSnapshot = this.workspaceResourcePolicy() && route?.status !== "denied"
        ? await this.workspaces.inspectLifecycleInventory() : null;
      return await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      requireVerifiedWorkspace(storedAgent);
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      // Capture before inserting this Run, from the same serialized admission
      // snapshot. Do not rebuild history later or use presentation messages.
      const history = this.config.codexRunHomeMode === "run-scoped" && !this.config.demoRunner
        ? buildRunConversation(database.runs, agentId, runId) : undefined;
      if (observedWorkspaceSnapshot) {
        if (!database.workspaceResources) throw new Error("WORKSPACE_RESOURCE_STATE_MISSING");
        try {
          const aligned = this.alignWorkspaceSnapshot(observedWorkspaceSnapshot, database.agents);
          let state = reconcileWorkspaceInventory(database.workspaceResources, aligned, now());
          if (state.reconciliationRequired) {
            // Persist the fail-closed observation without creating a Run,
            // Message, or provider-budget reservation. Throwing inside this
            // callback would discard the reconciliation evidence.
            database.workspaceResources = state;
            return {agent: null, history: undefined, workspaceDenied: true as const};
          }
          state = reserveWorkspaceGrowth(state, {
            runId,
            agentId,
            maxGrowthBytes: state.policy.maxGrowthPerRunBytes,
          }, now());
          database.workspaceResources = state;
        } catch (error) {
          this.workspaceAdmissionError(error);
        }
      } else if (this.workspaceResourcePolicy() && route?.status !== "denied") {
        throw new Error("WORKSPACE_RESOURCE_STATE_MISSING");
      }
      if (database.runBudget) {
        if (!route) throw new Error("RUN_BUDGET_ROUTE_MISSING");
        const budgetAt = now();
        try {
          database.runBudget = route.status === "denied"
            ? settleRunBudget(database.runBudget, route, budgetAt)
            : reserveRunBudget(database.runBudget, route, budgetAt);
        } catch (error) {
          if (error instanceof RunBudgetError && ["RUN_BUDGET_INSUFFICIENT_AVAILABLE",
            "RUN_BUDGET_POLICY_EXPIRED", "RUN_BUDGET_POLICY_NOT_YET_VALID"].includes(error.code)) {
            throw new HttpError(429,
              "Global synthetic routing budget cannot admit this Run; no runner dispatch occurred");
          }
          throw error;
        }
      } else if (this.runBudgetPolicy()) {
        throw new Error("RUN_BUDGET_STATE_MISSING");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      if (route?.status === "denied") return {agent: snapshot, history, workspaceDenied: false as const};
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return {agent: snapshot, history, workspaceDenied: false as const};
      });
    };
    const admitted = this.workspaceResourcePolicy() && route?.status !== "denied"
      ? await this.withWorkspaceAuthority(persistAdmission)
      : await persistAdmission();
    if (admitted.workspaceDenied) {
      throw new HttpError(429,
        "Workspace lifecycle capacity requires reconciliation; no runner dispatch occurred");
    }
    if (route?.status === "denied") {
      this.runReservations.delete(agentId);
      return {run, message};
    }
    const execution = this.executeRun(admitted.agent, run, admitted.history);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
          // Includes baseline, runner, post-scan/recovery, and final persistence.
          this.runReservations.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    const stored = this.store.snapshot();
    const storedBudget = stored.runBudget;
    const budget = storedBudget ? parseRunBudgetState(storedBudget) : null;
    const workspaceResources = stored.workspaceResources
      ? parseWorkspaceResourceState(stored.workspaceResources) : null;
    let activeReserved = 0n;
    for (const entry of budget?.entries ?? []) {
      if (entry.status === "reserved" || entry.status === "dispatched") {
        activeReserved += BigInt(entry.retainedMinimumMicrounits);
      }
    }
    const reconciliationEntries = budget?.entries.filter(entry =>
      entry.status === "reconciliation_required" || entry.status === "dispatched").length ?? 0;
    return {
      arkConfigured: isArkConfigured(this.config),
      demoRunner: this.config.demoRunner,
      runCapacity: this.runCapacity(),
      taskVerifier: this.verifierId,
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      modelRouting: {
        mode: this.config.modelRoutingMode,
        catalogConfigured: this.config.modelRoutingCatalogJson.length > 0,
        minQualityScore: this.config.modelRoutingMinQualityScore,
        maxInputTokens: this.config.modelRoutingMaxInputTokens,
        maxOutputTokens: this.config.modelRoutingMaxOutputTokens,
        maxCostMicroUnits: this.config.modelRoutingMaxCostMicroUnits,
        globalBudget: budget ? {
          configured: true,
          policyId: budget.policy.policyId,
          expiresAt: budget.policy.expiresAt,
          limitMicrounits: String(budget.policy.maxReservedAggregateMicrounits),
          retainedMinimumMicrounits: budget.totals.retainedMinimumMicrounits,
          activeReservedMicrounits: activeReserved.toString(),
          availableForNewReservationsMicrounits: budget.totals.availableForNewReservationsMicrounits,
          overageMicrounits: budget.totals.overageMicrounits,
          overLimit: BigInt(budget.totals.overageMicrounits) > 0n,
          reconciliationEntries,
          expired: Date.now() >= Date.parse(budget.policy.expiresAt),
          boundary: "Deployment-local synthetic admission accounting; not provider billing, quota, money, or model-quality proof",
        } : {configured: false,
          boundary: "No deployment-local synthetic routing budget is configured"},
        boundary: "Host estimate only; not provider billing, quota, or model-quality proof",
      },
      workspaceResources: workspaceResources ? {
        configured: true,
        mode: this.config.workspaceResourceMode,
        policyId: workspaceResources.policy.policyId,
        maxRetainedBytes: String(workspaceResources.policy.maxRetainedBytes),
        maxGrowthPerRunBytes: String(workspaceResources.policy.maxGrowthPerRunBytes),
        retainedBytes: workspaceResources.totals.retainedBytes,
        reservedGrowthBytes: workspaceResources.totals.reservedGrowthBytes,
        lifecycleReservedBytes: workspaceResources.totals.lifecycleReservedBytes,
        availableForNewReservationsBytes: workspaceResources.reconciliationRequired
          ? "0" : workspaceResources.totals.availableBytes,
        overageBytes: workspaceResources.totals.overageBytes,
        activeInventories: workspaceResources.inventories.filter(item => item.kind === "active").length,
        archivedInventories: workspaceResources.inventories.filter(item => item.kind === "archived").length,
        quarantineInventories: workspaceResources.inventories.filter(item => item.kind === "quarantine").length,
        reconciliationRequired: workspaceResources.reconciliationRequired,
        reconciliationReservations: workspaceResources.reservations.filter(item =>
          item.status === "reconciliation_required" || item.status === "dispatched").length,
        preparedLifecycleIntents: workspaceResources.lifecycleIntents.filter(item =>
          item.status === "prepared").length,
        reconciliationLifecycleIntents: workspaceResources.lifecycleIntents.filter(item =>
          item.status === "reconciliation_required").length,
        boundary: workspaceResourceBoundary,
      } : {
        configured: false,
        mode: "off",
        boundary: workspaceResourceBoundary,
      },
      codexAvailable: this.config.demoRunner ? true : await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.demoRunner
          ? "RunGuard controlled fixture"
          : this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  runCapacity(): { limit: number; inUse: number; available: number } {
    return {
      limit: this.config.maxConcurrentRuns,
      inUse: this.runReservations.size,
      available: Math.max(0, this.config.maxConcurrentRuns - this.runReservations.size),
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun, history?: RunConversation): Promise<void> {
    let guardSession: Awaited<ReturnType<RunGuard["prepare"]>>;
    try {
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        if (storedRun) {
          storedRun.status = "running";
          storedRun.startedAt = now();
        }
      });
      guardSession = await this.runGuard.prepare({
        agentId: agentAtStart.id,
        runId: run.id,
        workspacePath: agentAtStart.workspacePath,
      });
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        if (storedRun) storedRun.guard = guardSession.receipt;
      });
    } catch (error) {
      await this.finishPreExecutionFailure(agentAtStart.id, run.id, error);
      return;
    }
    if (guardSession.receipt.verdict === "denied") {
      await this.finishGuardDenial(agentAtStart.id, run.id, guardSession.receipt);
      return;
    }
    let allowedEffectDecision: EffectPolicyDecision | null = null;
    if (this.config.demoRunner) {
      const proposal = this.runner.proposeEffect?.({prompt: run.prompt}) ?? null;
      if (proposal) {
        const decision = decideEffect(proposal);
        if (decision.verdict === "denied") {
          const receipt = await this.runGuard.denyEffectBeforeDispatch(
            guardSession,
            agentAtStart.workspacePath,
            decision,
          );
          await this.finishGuardDenial(agentAtStart.id, run.id, receipt);
          return;
        }
        allowedEffectDecision = decision;
      }
    }
    const controller = new AbortController();
    // A failed runner cancellation keeps the existing no-verifier behavior:
    // execution may still finish. Only an opted-in hook has a durable abort signal.
    if (this.taskVerifier) this.acceptanceControllers.set(agentAtStart.id, controller);
    const context = { agentId: agentAtStart.id, runId: run.id,
      workspacePath: agentAtStart.workspacePath, signal: controller.signal };
    const throwIfCancelled = () => {
      if (this.cancellationRequests.has(agentAtStart.id) || controller.signal.aborted) {
        controller.abort();
        throw new RunCancelledError();
      }
    };
    let acceptance = run.acceptance;
    let verifierPhase = false;
    let promotionPhase = false;
    let promotionCheckpoint: unknown;
    let promotionPrepared = false;
    let promotionClosed = false;
    let promotionEvidence: CandidatePromotionEvidence | null = null;
    let routeReceipt: RunRoutingReceipt | null = run.route;
    const closePromotion = async () => {
      if (!this.candidatePromoter || !promotionPrepared || promotionClosed) return;
      promotionPhase = true;
      await this.candidatePromoter.close({ ...context, checkpoint: promotionCheckpoint });
      promotionClosed = true;
      promotionPhase = false;
    };
    try {
      throwIfCancelled();
      verifierPhase = true;
      const checkpoint = this.taskVerifier ? await this.taskVerifier.prepare(context) : undefined;
      verifierPhase = false;
      throwIfCancelled();
      promotionPhase = true;
      promotionCheckpoint = this.candidatePromoter ? await this.candidatePromoter.prepare(context) : undefined;
      promotionPrepared = this.candidatePromoter !== null;
      promotionPhase = false;
      throwIfCancelled();
      let selectedModel: string | undefined;
      if (routeReceipt || this.workspaceResourcePolicy()) {
        const reservedReceipt = routeReceipt;
        const dispatched = await this.store.mutate((database) => {
          const storedRun = database.runs.find((item) => item.id === run.id);
          if (!storedRun) throw new Error("RUN_STATE_CHANGED");
          let nextRoute = storedRun.route;
          if (reservedReceipt && reservedReceipt.status !== "denied") {
            validateRunRoutingReceipt(reservedReceipt);
            if (reservedReceipt.binding.runId !== run.id ||
                reservedReceipt.binding.agentId !== agentAtStart.id ||
                reservedReceipt.binding.toolPolicySha256 !== this.toolPolicyDigest() ||
                reservedReceipt.selection.provider !== "volcengine_ark" ||
                storedRun.route?.status !== "reserved" ||
                storedRun.route.receiptSha256 !== reservedReceipt.receiptSha256) {
              throw new Error("RUN_ROUTE_STATE_CHANGED");
            }
            const dispatchedAt = now();
            nextRoute = markRouteDispatched(storedRun.route, dispatchedAt);
            this.settleStoredBudget(database, nextRoute, dispatchedAt);
            storedRun.route = nextRoute;
          }
          if (this.workspaceResourcePolicy()) {
            if (!database.workspaceResources) throw new Error("WORKSPACE_RESOURCE_STATE_MISSING");
            database.workspaceResources = dispatchWorkspaceGrowth(database.workspaceResources,
              {runId: run.id, agentId: agentAtStart.id}, now());
          }
          return {route: nextRoute ? structuredClone(nextRoute) : null};
        });
        routeReceipt = dispatched.route;
        selectedModel = routeReceipt && routeReceipt.status !== "denied"
          ? routeReceipt.selection.model : undefined;
      }
      // Stop may arrive while the durable dispatched transition is waiting on
      // the store. Recheck before the synchronous runner invocation so a
      // missed runner.cancel() cannot launch a late provider call.
      throwIfCancelled();
      let effectCapability: EffectCapabilityReceipt | undefined;
      let effectSinkGrant: string | undefined;
      let initialEffectSinkReceiptPersisted = false;
      const refreshEffectSinkReceipt = async (): Promise<EffectSinkReceipt | undefined> => {
        if (!effectSinkGrant) return undefined;
        const sinkReceipt = this.effectSinkBroker.inspect(effectSinkGrant);
        if (!sinkReceipt) throw new Error("EFFECT_SINK_RECEIPT_MISSING");
        await this.persistEffectSinkReceipt(run.id, agentAtStart.id, sinkReceipt);
        return sinkReceipt;
      };
      let result: RunnerResult;
      let terminalEffectSinkReceipt: EffectSinkReceipt | undefined;
      let authorityError: unknown;
      try {
        if (allowedEffectDecision) {
          const persistCapability = async (next: EffectCapabilityReceipt) => {
            await this.store.mutate((database) => {
              const storedRun = database.runs.find((item) => item.id === run.id);
              if (!storedRun || storedRun.agentId !== agentAtStart.id || storedRun.status !== "running") {
                throw new Error("EFFECT_CAPABILITY_RUN_STATE_CHANGED");
              }
              const previous = storedRun.effectCapability;
              const validTransition = previous === undefined
                ? next.state === "issued"
                : previous.grantId === next.grantId &&
                  ((previous.state === "issued" && next.state === "claimed") ||
                   (previous.state === "claimed" && next.state === "consumed"));
              if (!validTransition) throw new Error("EFFECT_CAPABILITY_RECEIPT_STATE_CHANGED");
              storedRun.effectCapability = structuredClone(next);
            });
          };
          const issued = this.effectCapabilities.issue({
            runId: run.id,
            agentId: agentAtStart.id,
            decision: allowedEffectDecision,
          });
          await persistCapability(issued);
          const binding = bindingFromCapability(issued);
          const claimed = this.effectCapabilities.claim(issued, binding);
          await persistCapability(claimed);
          throwIfCancelled();
          effectCapability = this.effectCapabilities.consume(claimed, binding);
          await persistCapability(effectCapability);
          const sink = this.effectSinkBroker.issue({
            parent: effectCapability,
            workspaceRoot: agentAtStart.workspacePath,
            relativePath: EFFECT_SINK_DEMO_RESULT_PATH,
            payloadSha256: effectSinkPayloadSha256(EFFECT_SINK_DEMO_RESULT_PAYLOAD),
          });
          effectSinkGrant = sink.grant;
          this.onEffectSinkIssued?.(Object.freeze({
            grant: sink.grant,
            port: this.effectSinkBroker.port,
          }));
          await this.beforeInitialEffectSinkReceiptPersist?.();
          await this.persistEffectSinkReceipt(run.id, agentAtStart.id, sink.receipt);
          initialEffectSinkReceiptPersisted = true;
        }
        throwIfCancelled();
        result = await this.runner.run({
          runId: run.id,
          agentId: agentAtStart.id,
          workspacePath: agentAtStart.workspacePath,
          prompt: run.prompt,
          threadId: agentAtStart.codexThreadId,
          ...(selectedModel ? {model: selectedModel} : {}),
          ...(history ? {history} : {}),
          ...(effectSinkGrant ? {effectSink: Object.freeze({
            grant: effectSinkGrant,
            port: this.effectSinkBroker.port,
          })} : {}),
        });
      } catch (error) {
        authorityError = error;
        throw error;
      } finally {
        // Host authority closes synchronously as soon as runner.run settles,
        // before routing settlement, RunGuard verification, or publication.
        // Already committed effects remain committed; issued/in-flight grants
        // become terminal and cannot be redeemed by retained runner references.
        if (effectSinkGrant) {
          const closed = this.effectSinkBroker.close(effectSinkGrant);
          this.onEffectSinkClosed?.(closed);
          if (initialEffectSinkReceiptPersisted) {
            try {
              terminalEffectSinkReceipt = await refreshEffectSinkReceipt();
            } catch (refreshError) {
              // Preserve the causal execution/cancellation failure. A failed
              // follow-up receipt write must not rewrite what caused closure.
              if (authorityError === undefined) throw refreshError;
            }
          }
        }
      }
      if (effectSinkGrant && terminalEffectSinkReceipt?.state !== "committed") {
        throw new EffectSinkNotCommittedError();
      }
      if (routeReceipt && routeReceipt.status === "dispatched") {
        const dispatchedReceipt = routeReceipt;
        const usage = result.usage &&
          Number.isSafeInteger(result.usage.inputTokens) &&
          Number.isSafeInteger(result.usage.outputTokens)
          ? {inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens}
          : null;
        routeReceipt = await this.store.mutate((database) => {
          const storedRun = database.runs.find((item) => item.id === run.id);
          if (!storedRun || storedRun.route?.status !== "dispatched" ||
              storedRun.route.receiptSha256 !== dispatchedReceipt.receiptSha256) {
            throw new Error("RUN_ROUTE_STATE_CHANGED");
          }
          const settledAt = now();
          const settlement = settleRunRoute(storedRun.route, usage, settledAt);
          this.settleStoredBudget(database, settlement, settledAt);
          storedRun.route = settlement;
          return structuredClone(settlement);
        });
      }
      throwIfCancelled();
      let guardReceipt = await this.runGuard.verify(guardSession, agentAtStart.workspacePath);
      if (guardReceipt.verdict === "denied") {
        await this.finishGuardDenial(agentAtStart.id, run.id, guardReceipt);
        return;
      }
      throwIfCancelled();
      if (this.candidatePromoter) {
        promotionPhase = true;
        if (guardReceipt.afterManifestDigest !== guardReceipt.beforeManifestDigest || guardReceipt.changedFiles.length !== 0) {
          throw new Error("Candidate promotion requires a proposal-only runner");
        }
        const promoted = await this.candidatePromoter.promote({
          ...context, checkpoint: promotionCheckpoint, result: structuredClone(result),
          baselineManifestDigest: guardReceipt.beforeManifestDigest!,
        });
        const promotedKeys = promoted && typeof promoted === "object" && !Array.isArray(promoted)
          ? Object.keys(promoted).sort().join(",") : "";
        if (!promoted || typeof promoted !== "object" || Array.isArray(promoted) ||
            (promotedKeys !== "output" && promotedKeys !== "evidence,output") ||
            typeof promoted.output !== "string" ||
            promoted.output.includes("\0") || Buffer.byteLength(promoted.output, "utf8") > this.config.codexMaxOutputBytes) {
          throw new Error("Candidate promoter returned an invalid result");
        }
        if (promoted.evidence !== undefined) {
          promotionEvidence = requirePromotionEvidence(promoted.evidence, {
            runId: run.id, agentId: agentAtStart.id,
            baselineManifestDigest: guardReceipt.beforeManifestDigest!,
          });
        } else if (this.candidatePromoter.recover) {
          throw new Error("Recovery-capable candidate promoter omitted durable evidence");
        }
        throwIfCancelled();
        this.runGuard.recordCandidatePromotion(guardSession);
        guardReceipt = await this.runGuard.verify(guardSession, agentAtStart.workspacePath);
        throwIfCancelled();
        if (guardReceipt.verdict === "denied") {
          await this.finishGuardDenial(agentAtStart.id, run.id, guardReceipt);
          return;
        }
        promotionPhase = false;
        result = { ...result, output: promoted.output };
      }
      if (this.taskVerifier) {
        // Candidate is detached, never persisted as completed before acceptance.
        // Verifiers get host-bound IDs and the real runner result, not model claims.
        const candidate = structuredClone({ ...this.getRun(run.id), status: "completed" as const,
          output: result.output, usage: result.usage, guard: guardReceipt, completedAt: now() });
        const verifiedDigest = guardReceipt.afterManifestDigest;
        verifierPhase = true;
        const decision = await this.taskVerifier.verify({ ...context, checkpoint, run: candidate });
        if (!decision || typeof decision !== "object" ||
            Object.keys(decision).length !== 1 || Object.keys(decision)[0] !== "accepted" ||
            typeof decision.accepted !== "boolean") {
          throw new TaskAcceptanceError();
        }
        verifierPhase = false;
        throwIfCancelled();
        if (!decision.accepted) throw new TaskAcceptanceError(true);
        // Trusted verifiers are read-only. Recheck the workspace after their work.
        acceptance = taskAcceptance(this.verifierId, "passed", "task_verified");
        await closePromotion();
        throwIfCancelled();
        // Authority closure precedes the immutable publication scan. A close
        // hook that mutates the workspace is therefore observed and denied.
        const finalReceipt = await this.runGuard.verify(guardSession, agentAtStart.workspacePath);
        throwIfCancelled();
        if (finalReceipt.verdict === "denied") {
          await this.finishGuardDenial(agentAtStart.id, run.id, finalReceipt);
          return;
        }
        if (finalReceipt.afterManifestDigest !== verifiedDigest) throw new TaskAcceptanceError();
        guardReceipt = finalReceipt;
      }
      await closePromotion();
      throwIfCancelled();
      await this.withWorkspaceAuthority(async () => {
        const workspaceSnapshot = await this.captureWorkspaceSnapshot();
        throwIfCancelled();
        const completedAt = now();
        await this.store.mutate((database) => {
        // Cancellation before this commit boundary must never publish success.
        throwIfCancelled();
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        if (database.runBudget) {
          const budget = parseRunBudgetState(database.runBudget);
          const entry = routeReceipt ? budget.entries.find(item => item.runId === run.id) : null;
          if (!routeReceipt || !entry || entry.agentId !== agentAtStart.id ||
              entry.currentReceipt.receiptSha256 !== routeReceipt.receiptSha256 ||
              entry.status !== routeReceipt.status ||
              (entry.status !== "settled" && entry.status !== "reconciliation_required")) {
            throw new Error("RUN_BUDGET_PUBLICATION_STATE_INVALID");
          }
          database.runBudget = budget;
        }
        this.finalizeWorkspaceReservation(database, run.id, agentAtStart.id,
          workspaceSnapshot, completedAt, true);
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.route = routeReceipt;
        storedRun.guard = guardReceipt;
        storedRun.acceptance = acceptance;
        storedRun.completedAt = completedAt;
        storedRun.promotion = promotionEvidence ? {
          ...promotionEvidence,
          promoterId: this.candidatePromoter!.id,
          finalManifestDigest: guardReceipt.afterManifestDigest!,
          committedAt: completedAt,
        } : null;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
        });
      });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError || controller.signal.aborted || this.cancellationRequests.has(agentAtStart.id);
      const failedDuringPromotion = promotionPhase;
      let closeFailed = false;
      try { await closePromotion(); } catch { closeFailed = true; }
      promotionPhase = false;
      const promotionError = failedDuringPromotion || closeFailed;
      const verifierError = error instanceof TaskAcceptanceError || verifierPhase;
      const message = promotionError ? "Trusted candidate promotion could not apply this Run"
        : verifierError ? new TaskAcceptanceError(error instanceof TaskAcceptanceError && error.rejected).message
        : error instanceof Error ? error.message : String(error);
      if (routeReceipt?.status === "dispatched") {
        try {
          const dispatchedReceipt = routeReceipt;
          routeReceipt = await this.store.mutate((database) => {
            const storedRun = database.runs.find((item) => item.id === run.id);
            if (!storedRun || storedRun.route?.status !== "dispatched" ||
                storedRun.route.receiptSha256 !== dispatchedReceipt.receiptSha256) {
              throw new Error("RUN_ROUTE_STATE_CHANGED");
            }
            const settledAt = now();
            const unsettled = settleRunRoute(storedRun.route, null, settledAt);
            this.settleStoredBudget(database, unsettled, settledAt);
            storedRun.route = unsettled;
            return structuredClone(unsettled);
          });
        } catch {
          // Preserve the already-persisted dispatched reservation. It must not
          // be rewritten as zero cost when settlement itself is uncertain.
        }
      }
      if (this.taskVerifier) {
        acceptance = cancelled ? taskAcceptance(this.verifierId, "cancelled", "run_cancelled")
          : promotionError ? taskAcceptance(this.verifierId, "not_evaluated", "promotion_failed")
          : verifierError ? error instanceof TaskAcceptanceError && error.rejected
            ? taskAcceptance(this.verifierId, "rejected", "task_rejected")
            : taskAcceptance(this.verifierId, "error", "verifier_error")
          : taskAcceptance(this.verifierId, "not_evaluated", "execution_failed");
      }
      let guardReceipt: AgentRun["guard"];
      try {
        guardReceipt = await this.runGuard.verify(guardSession, agentAtStart.workspacePath);
        if (error instanceof EffectSinkNotCommittedError && guardReceipt.verdict !== "denied") {
          guardReceipt = await this.runGuard.rejectTask(guardSession);
          guardReceipt.denialReason = error.message;
        }
        if (this.taskVerifier && guardReceipt.verdict !== "denied") {
          guardReceipt = await this.runGuard.rejectTask(guardSession);
        }
      } catch {
        await this.finishRecoveryFailure(agentAtStart.id, run.id, message,
          cancelled ? "cancelled" : "failed", acceptance);
        return;
      }
      if (guardReceipt.verdict === "denied") {
        await this.finishGuardDenial(
          agentAtStart.id, run.id, guardReceipt, completedAt,
          cancelled ? "cancelled" : "failed",
          acceptance,
        );
        return;
      }
      await this.withWorkspaceAuthority(async () => {
        let failedWorkspaceSnapshot: WorkspaceInventorySnapshot | null = null;
        try { failedWorkspaceSnapshot = await this.captureWorkspaceSnapshot(); } catch { /* fail closed below */ }
        await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          if (storedRun.route?.status === "reserved") {
            this.settleStoredBudget(database, storedRun.route, now());
          }
          this.finalizeWorkspaceReservation(database, run.id, agentAtStart.id,
            failedWorkspaceSnapshot, completedAt, false);
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.guard = guardReceipt;
          storedRun.acceptance = acceptance;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
        });
      });
    } finally {
      if (this.acceptanceControllers.get(agentAtStart.id) === controller) {
        this.acceptanceControllers.delete(agentAtStart.id);
      }
    }
  }

  private async persistEffectSinkReceipt(
    runId: string,
    agentId: string,
    next: EffectSinkReceipt,
  ): Promise<void> {
    const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    const timestamp = (value: unknown) => typeof value === "string" &&
      Number.isFinite(Date.parse(value));
    const shapeValid = next.version === 1 && next.broker === "process-local" &&
      next.runId === runId && next.agentId === agentId &&
      next.action === "write_demo_result" && next.targetClass === "workspace" &&
      next.policy === "effect-firewall-v1" && next.policyVersion === 1 &&
      digest(next.grantSha256) && digest(next.parentGrantSha256) &&
      digest(next.policyDigest) && digest(next.workspaceRootIdentitySha256) &&
      digest(next.payloadSha256) && next.relativePath === EFFECT_SINK_DEMO_RESULT_PATH &&
      timestamp(next.issuedAt) && timestamp(next.expiresAt) &&
      typeof next.boundary === "string" && next.boundary.length > 0 &&
      (next.state === "issued"
        ? next.spentAt === null && next.committedAt === null && next.failedAt === null &&
          next.closedAt === null && next.closeDisposition === null &&
          next.bytesCommitted === null && next.errorCode === null
        : next.state === "spent"
          ? timestamp(next.spentAt) && next.committedAt === null && next.failedAt === null &&
            next.closedAt === null && next.closeDisposition === null &&
            next.bytesCommitted === null && next.errorCode === null
          : next.state === "committed"
            ? timestamp(next.spentAt) && timestamp(next.committedAt) && next.failedAt === null &&
              next.closedAt === null && next.closeDisposition === null &&
              Number.isSafeInteger(next.bytesCommitted) && next.bytesCommitted! >= 0 &&
              next.errorCode === null
            : next.state === "effect_failed"
              ? timestamp(next.spentAt) && next.committedAt === null &&
                timestamp(next.failedAt) && next.closedAt === null &&
                next.closeDisposition === null && next.bytesCommitted === null &&
                typeof next.errorCode === "string" && next.errorCode.startsWith("EFFECT_SINK_")
              : next.state === "revoked" && next.committedAt === null &&
                next.failedAt === null && timestamp(next.closedAt) &&
                next.bytesCommitted === null && next.errorCode === "EFFECT_SINK_CLOSED" &&
                ((next.closeDisposition === "unredeemed" && next.spentAt === null) ||
                 (next.closeDisposition === "in_flight" && timestamp(next.spentAt))));
    if (!shapeValid) throw new Error("EFFECT_SINK_RECEIPT_INVALID");

    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId);
      if (!storedRun || storedRun.agentId !== agentId || storedRun.status !== "running") {
        throw new Error("EFFECT_SINK_RUN_STATE_CHANGED");
      }
      const previous = storedRun.effectSinkReceipt;
      if (previous) {
        const bindingKeys = [
          "broker", "grantSha256", "parentGrantSha256", "runId", "agentId", "action",
          "targetClass", "policy", "policyVersion", "policyDigest",
          "workspaceRootIdentitySha256", "relativePath", "payloadSha256", "issuedAt",
          "expiresAt", "boundary",
        ] as const;
        if (bindingKeys.some((key) => previous[key] !== next[key])) {
          throw new Error("EFFECT_SINK_RECEIPT_BINDING_CHANGED");
        }
        const transition = `${previous.state}->${next.state}`;
        const validTransition = previous.state === next.state
          ? JSON.stringify(previous) === JSON.stringify(next)
          : transition === "issued->spent" || transition === "issued->committed" ||
            transition === "issued->effect_failed" || transition === "issued->revoked" ||
            transition === "spent->committed" || transition === "spent->effect_failed" ||
            transition === "spent->revoked";
        if (!validTransition) throw new Error("EFFECT_SINK_RECEIPT_STATE_CHANGED");
      } else if (next.state !== "issued") {
        throw new Error("EFFECT_SINK_RECEIPT_STATE_CHANGED");
      }
      storedRun.effectSinkReceipt = structuredClone(next);
    });
  }

  private planRoute(runId: string, agentId: string, decidedAt: string): RunRoutingReceipt | null {
    if (this.config.modelRoutingMode === "off") return null;
    let catalog: unknown = {};
    try { catalog = JSON.parse(this.config.modelRoutingCatalogJson); } catch { catalog = {}; }
    // This service owns one Ark transport. A catalog that names any other
    // provider is invalid as a whole; a route cannot silently swap transports.
    if (catalog && typeof catalog === "object" && !Array.isArray(catalog)) {
      const routes = (catalog as {routes?: unknown}).routes;
      if (Array.isArray(routes) && routes.some(route => !route || typeof route !== "object" ||
          (route as {provider?: unknown}).provider !== "volcengine_ark")) catalog = {};
    }
    const toolPolicyDigest = this.toolPolicyDigest();
    return planRunRouteOrDeny({
      runId, agentId, catalog,
      requirements: {
        schemaVersion: 1,
        minQualityScore: this.config.modelRoutingMinQualityScore,
        maxInputTokens: this.config.modelRoutingMaxInputTokens,
        maxOutputTokens: this.config.modelRoutingMaxOutputTokens,
        maxReservedCostMicrounits: this.config.modelRoutingMaxCostMicroUnits ?? 0,
        requiredCapabilities: [],
      },
      toolPolicyDigest, decidedAt,
    });
  }

  private runBudgetPolicy(): RunBudgetPolicy | null {
    if (this.config.modelRoutingGlobalBudgetMicroUnits === null ||
        this.config.modelRoutingGlobalBudgetExpiresAt === null) return null;
    return parseRunBudgetPolicy({
      version: 1,
      policyId: `deployment:${this.config.runtimeInstanceId}:routing-budget-v1`,
      validFrom: "1970-01-01T00:00:00.000Z",
      expiresAt: this.config.modelRoutingGlobalBudgetExpiresAt,
      maxReservedAggregateMicrounits: this.config.modelRoutingGlobalBudgetMicroUnits,
      costUnit: "synthetic-microunit",
    });
  }

  private settleStoredBudget(database: Database, receipt: RunRoutingReceipt, at: string): void {
    if (!database.runBudget) {
      if (this.runBudgetPolicy()) throw new Error("RUN_BUDGET_STATE_MISSING");
      return;
    }
    database.runBudget = settleRunBudget(database.runBudget, receipt, at);
  }

  private async finishPreExecutionFailure(agentId: string, runId: string, error: unknown): Promise<void> {
    const cancelled = error instanceof RunCancelledError || this.cancellationRequests.has(agentId);
    const message = cancelled ? "Run cancelled before guarded execution"
      : error instanceof Error ? error.message : String(error);
    await this.store.mutate((database) => {
      const storedRun = database.runs.find(item => item.id === runId);
      const agent = database.agents.find(item => item.id === agentId);
      const completedAt = now();
      if (storedRun) {
        if (storedRun.route?.status === "reserved") {
          this.settleStoredBudget(database, storedRun.route, completedAt);
        }
        this.finalizeWorkspaceReservation(database, runId, agentId, null, completedAt, false);
        storedRun.status = cancelled ? "cancelled" : "failed";
        storedRun.error = message;
        storedRun.output = null;
        storedRun.usage = null;
        storedRun.acceptance = this.verifierId
          ? taskAcceptance(this.verifierId, cancelled ? "cancelled" : "not_evaluated",
            cancelled ? "run_cancelled" : "execution_failed")
          : taskAcceptance(null);
        storedRun.completedAt = completedAt;
      }
      if (agent) {
        if (agent.status !== "stopped") agent.status = cancelled ? "ready" : "error";
        agent.lastError = cancelled ? null : message;
        agent.updatedAt = completedAt;
      }
    });
  }

  private async finishRecoveryFailure(
    agentId: string,
    runId: string,
    message: string,
    status: "failed" | "cancelled",
    acceptance: TaskAcceptance,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find(item => item.id === runId);
      const agent = database.agents.find(item => item.id === agentId);
      const completedAt = now();
      if (storedRun) {
        // Only work durably known not to have dispatched may release its hold.
        // A dispatched route remains at its conservative accounting minimum.
        if (storedRun.route?.status === "reserved") {
          this.settleStoredBudget(database, storedRun.route, completedAt);
        }
        // RunGuard could not prove the workspace contents recovered. A
        // metadata scan alone cannot authorize release, so retain the full
        // dispatched reservation and require reconciliation.
        this.finalizeWorkspaceReservation(database, runId, agentId, null, completedAt, false);
        storedRun.status = status;
        storedRun.error = `${message}; workspace recovery could not be verified`;
        storedRun.output = null;
        storedRun.acceptance = acceptance;
        storedRun.completedAt = completedAt;
        if (storedRun.guard) {
          storedRun.guard.verdict = "denied";
          storedRun.guard.recovery = "failed";
          storedRun.guard.recoveredManifestDigest = null;
          storedRun.guard.denialReason = "RunGuard recovery verification failed";
          storedRun.guard.events.push({at: completedAt, kind: "recovery_required",
            detail: "post-failure workspace verification did not complete"});
        }
      }
      if (agent) {
        agent.recoveryHold = {runId, reason: "rollback_failed", since: completedAt};
        if (agent.status !== "stopped") agent.status = "error";
        agent.codexThreadId = null;
        agent.lastError = recoveryRequired;
        agent.updatedAt = completedAt;
      }
    });
  }

  private toolPolicyDigest(): string {
    return routingSha256({version: 1,
      sandboxMode: this.config.codexSandboxMode,
      nativeToolPolicy: this.config.codexNativeToolPolicy,
      providerGate: this.config.codexProviderGate,
      maxAttempts: 1,
    });
  }

  private async finishGuardDenial(
    agentId: string,
    runId: string,
    receipt: AgentRun["guard"],
    completedAt = now(),
    status: "failed" | "cancelled" = "failed",
    acceptance?: TaskAcceptance,
  ): Promise<void> {
    const reason = receipt?.denialReason ?? "RunGuard denied this Run";
    await this.withWorkspaceAuthority(async () => {
      let workspaceSnapshot: WorkspaceInventorySnapshot | null = null;
      try { workspaceSnapshot = await this.captureWorkspaceSnapshot(); } catch { /* fail closed below */ }
      await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId);
      const agent = database.agents.find((item) => item.id === agentId);
      if (storedRun) {
        if (storedRun.route?.status === "reserved") {
          this.settleStoredBudget(database, storedRun.route, now());
        }
        this.finalizeWorkspaceReservation(database, runId, agentId,
          workspaceSnapshot, completedAt, false);
        storedRun.status = status;
        storedRun.error = reason;
        storedRun.output = null;
        storedRun.usage = null;
        storedRun.guard = receipt;
        storedRun.acceptance = acceptance ?? (this.verifierId
          ? taskAcceptance(this.verifierId, "not_evaluated", "workspace_denied") : taskAcceptance(null));
        storedRun.completedAt = completedAt;
      }
      if (agent) {
        if (receipt?.recovery === "failed") {
          agent.recoveryHold = { runId, reason: "rollback_failed", since: completedAt };
        }
        if (agent.status !== "stopped") agent.status = agent.recoveryHold ? "error" : "ready";
        agent.codexThreadId = null;
        agent.lastError = agent.recoveryHold ? recoveryRequired : null;
        agent.updatedAt = completedAt;
      }
      });
    });
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready") requireVerifiedWorkspace(agent);
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    this.acceptanceControllers.get(agentId)?.abort();
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }

  private async withLifecycleTransition<T>(id: string, operation: () => Promise<T>): Promise<T> {
    // Check existence before surfacing the transition conflict so missing IDs
    // retain their normal 404 behavior.
    this.getAgent(id);
    const workspaceResources = this.store.snapshot().workspaceResources;
    if (workspaceResources && parseWorkspaceResourceState(workspaceResources)
      .lifecycleIntents.some(intent => intent.agentId === id)) {
      throw new HttpError(409,
        "This Agent has an unresolved workspace lifecycle intent; use operator reconciliation first");
    }
    return this.withLifecycleTransitionKey(id, operation);
  }

  private async withLifecycleTransitionKey<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.lifecycleTransitions.has(id)) {
      throw new HttpError(409, "Another lifecycle operation is already in progress for this Agent");
    }
    this.lifecycleTransitions.add(id);
    try {
      return await operation();
    } finally {
      this.lifecycleTransitions.delete(id);
    }
  }
}
