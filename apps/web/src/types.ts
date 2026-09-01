export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

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
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface EffectCapabilityReceipt {
  version: 1;
  registry: "process-local";
  grantId: string;
  state: "issued" | "claimed" | "consumed";
  runId: string;
  agentId: string;
  action: "read_asset_metadata" | "write_demo_result" | "transform_media" |
    "publish_candidate" | "delete_mock_asset";
  targetClass: "scratch" | "workspace" | "candidate" | "protected";
  policy: "effect-firewall-v1";
  policyVersion: 1;
  policyDigest: string;
  issuedAt: string;
  expiresAt: string;
  claimedAt: string | null;
  consumedAt: string | null;
  useBudget: 1;
  usesClaimed: 0 | 1;
  boundary: string;
}

export type EffectSinkState = "issued" | "spent" | "committed" | "effect_failed" | "revoked";

/** Sanitized sink evidence. The opaque bearer grant is never returned by the API. */
export interface EffectSinkReceipt {
  version: 1;
  broker: "process-local";
  grantSha256: string;
  parentGrantSha256: string;
  state: EffectSinkState;
  runId: string;
  agentId: string;
  action: "read_asset_metadata" | "write_demo_result" | "transform_media" |
    "publish_candidate" | "delete_mock_asset";
  targetClass: "scratch" | "workspace" | "candidate" | "protected";
  policy: "effect-firewall-v1";
  policyVersion: 1;
  policyDigest: string;
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

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  route: {
    version: 1;
    status: "reserved" | "dispatched" | "settled" | "reconciliation_required" | "denied";
    selection?: {
      routeId: string;
      model: string;
      qualityScore: number;
    };
    reservation?: {
      inputTokens: number;
      outputTokens: number;
      reservedCostMicrounits: number;
    };
    settlement?: {
      reason: string;
      estimatedCostMicrounits: number | null;
      retainedMinimumCostMicrounits: number;
      releasedCostMicrounits: number;
      billingProof: false;
      qualityProof: false;
    } | null;
    reason?: string;
    errorCode?: string;
    attemptsUsed: 0 | 1;
    maxAttempts: 1;
    proofBoundary: string;
  } | null;
  guard: {
    verdict: "pending" | "retained" | "denied";
    grantedScope: "agent-workspace-only";
    denialReason: string | null;
    recovery: "not_needed" | "rolled_back" | "failed";
    changedFiles: string[];
    effectDecision?: {
      version: 1;
      policy: "effect-firewall-v1";
      verdict: "allowed" | "denied";
      action: "delete_mock_asset" | "write_demo_result";
      targetClass: "protected" | "workspace";
      reason: "explicit_workspace_allow" | "protected_target_denied" | "effect_not_allowlisted";
      workerSpawned: false;
      protectedBaselineVerifiedUnchanged: boolean;
    };
    events: Array<{
      kind: string;
      detail: string;
    }>;
  } | null;
  effectCapability?: EffectCapabilityReceipt;
  effectSinkReceipt?: EffectSinkReceipt;
  acceptance?: {
    version: 1;
    verifierId: string | null;
    status: "not_requested" | "pending" | "passed" | "rejected" | "error" |
      "cancelled" | "interrupted" | "not_evaluated";
    reason: string;
    checkedAt: string | null;
  };
  createdAt: string;
}

export type GlobalSyntheticBudgetInfo =
  | {
      configured: true;
      policyId: string;
      expiresAt: string;
      limitMicrounits: string;
      retainedMinimumMicrounits: string;
      activeReservedMicrounits: string;
      availableForNewReservationsMicrounits: string;
      overageMicrounits: string;
      overLimit: boolean;
      reconciliationEntries: number;
      expired: boolean;
      boundary: string;
    }
  | {
      configured: false;
      boundary: string;
    };

export type WorkspaceResourceInfo =
  | {
      configured: true;
      mode: "logical-bytes-v1";
      policyId: string;
      maxRetainedBytes: string;
      maxGrowthPerRunBytes: string;
      retainedBytes: string;
      reservedGrowthBytes: string;
      lifecycleReservedBytes: string;
      availableForNewReservationsBytes: string;
      overageBytes: string;
      activeInventories: number;
      archivedInventories: number;
      quarantineInventories: number;
      reconciliationRequired: boolean;
      reconciliationReservations: number;
      preparedLifecycleIntents: number;
      reconciliationLifecycleIntents: number;
      boundary: string;
    }
  | {
      configured: false;
      mode: "off";
      boundary: string;
    };

export interface WorkspaceLifecycleReconciliationItem {
  intentId: string;
  agentId: string;
  kind: "create" | "instruction_update" | "archive";
  status: "prepared" | "reconciliation_required";
  intentSha256: string;
  expectedAgentBeforeSha256: string | null;
  candidateAgentSha256: string | null;
  payloadManifestSha256: string;
  reservedStagingBytes: string;
  createdAt: string;
  updatedAt: string;
  probeState: "exact_before" | "exact_stage" | "exact_after" | "unsafe_or_mismatch";
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

export interface WorkspaceLifecycleOperatorActionReceipt {
  version: 1;
  actionId: string;
  action: "retry" | "cancel";
  intentId: string;
  agentId: string;
  kind: "create" | "instruction_update" | "archive";
  requestSha256: string;
  beforeLedgerSha256: string;
  beforeIntentSha256: string;
  evidenceSha256: string;
  status: "accepted" | "terminal";
  effect: "reopened" | "cancelled";
  afterIntentSha256: string | null;
  outcome: "completed" | "cancelled" | "unresolved" | null;
  acceptedAt: string;
  terminalAt: string | null;
  resultLedgerSha256: string | null;
  receiptSha256: string;
}

export interface WorkspaceLifecycleOperatorResult {
  action: WorkspaceLifecycleOperatorActionReceipt;
  replayed: boolean;
  outcome: "accepted" | "completed" | "cancelled" | "unresolved";
  reconciliation: WorkspaceLifecycleReconciliationReport;
}

export type JudgeEvidenceMetric = number | boolean;

export interface JudgeEvidenceLane {
  id: string;
  question: string;
  decision: string;
  passedGateCount: number;
  gateCount: number;
  kpis: Record<string, JudgeEvidenceMetric>;
}

export interface JudgeRepairEpisode {
  schemaVersion: 1;
  traceId: string;
  traceSha256: string;
  runId: string;
  agentId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  outcome: "VERIFIED_AND_APPLIED_PENDING_SERVICE_ACCEPTANCE";
  retained: true;
  proposer: {
    kind: "bounded-source-synthesis-v1";
    modelUsed: false;
    candidateCatalogueUsed: false;
    inputBoundary: string;
  };
  policy: {
    targetPath: "src/segment-window.mjs";
    attemptBudget: number;
    writesAllowed: 1;
    externalNetworkAllowed: false;
    publicationAllowed: false;
    hiddenOracleMutableByProposer: false;
  };
  attempts: Array<{
    index: number;
    variant: string;
    decisionReason: string;
    transforms: string[];
    candidateSha256: string;
    verdict: string;
    failedCases: number;
  }>;
  regression: {
    regressionId: string;
    caseId: string;
    categories: string[];
    startMs: number;
    endMs: number;
    expectedCount: number;
    actualCount: number | null;
    caseSha256: string;
  };
  regressionReplay: {
    regressionId: string;
    candidateSha256: string;
    fullOracleCases: number;
    passed: true;
    replayedByDistinctJob: true;
  };
  spans: Array<{
    sequence: number;
    spanId: string;
    parentSpanId: string;
    phase: string;
    action: string;
    status: string;
    durationMs: number;
  }>;
  proofBoundary: string;
}

export interface JudgeEvidenceSummary {
  evidenceMode: "live-scorecard" | "sealed-snapshot";
  verdict: "EVIDENCE_GATE_PASS" | "EVIDENCE_GATE_FAIL";
  generatedAt: string;
  evaluationRule: string;
  decisionKpis: {
    evidenceLanesPassed: number;
    evidenceLaneCount: number;
    heldoutCampaignCount: number;
    heldoutCasesPerCampaign: number;
    heldoutUnsafePromotionEvents: number;
    heldoutUnsafeCandidateCampaigns: number;
    heldoutNegativeBehaviorFamiliesRejected: number;
    heldoutIndeterminateOutcomes: number;
    heldoutPermutationInvariantReplays: number;
    heldoutTotalCandidateCaseExecutions: number;
    [key: string]: JudgeEvidenceMetric;
  };
  lanes: JudgeEvidenceLane[];
  repairEpisode: JudgeRepairEpisode;
  decisionPath: string[];
  proofBoundary: string;
}

export interface DecodeBridgeEvidenceSummary {
  schemaVersion: 1;
  actionId: "decodebridge-video-feature-route-v1";
  title: string;
  decision: "LOCAL_PROMOTION_CANDIDATE";
  capturedAt: string;
  methodology: {
    name: "NerveLoop VERA";
    expansion: "Verified Evidence Reconciliation Architecture";
    tagline: "dynamic strategy, earned memory, fixed proof";
  };
  governedRun: {
    status: "VERIFIED";
    capturedAtUtc: string;
    runId: string;
    leaseId: string;
    leaseState: "CLOSED";
    leaseReused: false;
    actualBackendPath: true;
    providerDispatch: false;
    taskAcceptance: "passed";
    runGuard: "retained";
    changedFiles: ["decodebridge-agent-run.receipt.json"];
    decodedFrameCount: number;
    comparedValueCount: number;
    hardwareInUse: true;
    exactTimeline: true;
    featureParityMismatchCount: 0;
    selectionExactMatch: true;
    benchmarkMode: "single-probe";
    promotionEligible: false;
    regressionIds: ["decodebridge-pts-one-tick-v1"];
    regressionReplayExecutionSha256: string;
    receiptSha256: string;
    evidenceRootSha256: string;
    artifactPayloadSha256: string;
    proofEnvelope: Record<string, unknown>;
    boundary: string;
  };
  causalReflex: {
    schemaVersion: 1;
    name: "Causal Proof-Graph Reflex";
    promise: string;
    scenario: {
      fault: "pts-one-tick";
      observedGate: "timeline.reference_exact_match";
      faultNode: "presentation-timeline";
      regressionId: "decodebridge-pts-one-tick-v1";
    };
    nodes: Array<{
      id: "input-identity" | "hardware-decode" | "presentation-timeline" |
        "metal-feature-parity" | "temporal-selector" | "retention-authority";
      label: string;
      owner: string;
      dependsOn: string[];
      evidenceSha256: string;
      faultState: "REUSED" | "REVOKED";
      recoveryState: "REUSED" | "REPLAYED";
      selectiveVerifierInvocationCount?: 0 | 1;
      fullReplayVerifierInvocationCount?: 1;
    }>;
    decision: {
      verdict: "SELECTIVE_RECOVERY_VERIFIED";
      invalidatedNodeCount: number;
      reusedNodeCount: number;
      replayedNodeCount: number;
      fullReplayNodeCount: number;
      logicalReplayAvoidedPercent: number;
      stalePromotionEscapes: 0;
      revokedCapabilities: ["selector.publish", "route.retain"];
    };
    roots: {
      verified: string;
      faulted: string;
      recovered: string;
    };
    execution?: {
      engine: "IN_PROCESS_DETERMINISTIC_NODE_VERIFIERS";
      selectiveVerifierInvocations: Array<
        "input-identity" | "hardware-decode" | "presentation-timeline" |
        "metal-feature-parity" | "temporal-selector" | "retention-authority"
      >;
      reusedWithoutInvocation: Array<
        "input-identity" | "hardware-decode" | "presentation-timeline" |
        "metal-feature-parity" | "temporal-selector" | "retention-authority"
      >;
      fullReplayVerifierInvocations: Array<
        "input-identity" | "hardware-decode" | "presentation-timeline" |
        "metal-feature-parity" | "temporal-selector" | "retention-authority"
      >;
      selectiveInvocationCount: number;
      fullReplayInvocationCount: number;
      recoveredEvidenceRootSha256: string;
      fullReplayEvidenceRootSha256: string;
      fullReplayEquivalent: true;
      staleAuthorityCount: 0;
    };
    counterfactualFaultMatrix?: Array<{
      kind: "TOPOLOGY_COUNTERFACTUAL";
      faultNode: "input-identity" | "hardware-decode" | "presentation-timeline" |
        "metal-feature-parity" | "temporal-selector" | "retention-authority";
      replayedNodes: string[];
      reusedNodes: string[];
      selectiveVerifierInvocationCount: number;
      fullReplayVerifierInvocationCount: number;
      fullReplayEquivalent: true;
      staleAuthorityCount: 0;
    }>;
    faultEvidenceSha256: string;
    recoveryEvidenceSha256: string;
    proofBoundary: string;
  };
  actionStages: Array<{
    id: "proposed" | "allowed" | "leased" | "executed" | "verified" | "retained";
    label: string;
    status: "DEFINED" | "ALLOWED_LOCAL_SCOPE" | "NOT_EVIDENCED" | "EXECUTED" |
      "VERIFIED" | "LEASE_CONSUMED_CLOSED" | "LOCAL_CANDIDATE_ONLY";
    evidence: string;
    provenance: "artifact-contract" | "adapter-policy" | "sealed-receipts" | "agentservice-proof";
  }>;
  proofEnvelope: {
    schemaVersion: "nerveloop.proof-envelope.v1";
    envelopeId: string;
    capturedAtUtc: string;
    task: {
      taskId: string;
      workload: "DecodeBridge";
      route: string;
      contractSha256: string;
    };
    authority: {
      state: "NOT_APPLICABLE";
      leaseId: null;
      policySha256: string;
      scope: string[];
      fresh: false;
    };
    artifacts: Array<{
      role: "INPUT" | "EXECUTABLE" | "POLICY" | "RECEIPT" | "AGGREGATE" |
        "RAW_MEASUREMENTS";
      name: string;
      sha256: string;
    }>;
    execution: {
      state: "EXECUTED";
      actualBackendPath: false;
      traceId: string;
      environment: Record<string, string | number | boolean | null>;
      metrics: Array<{
        name: string;
        value: number;
        unit: string;
        scope: string;
        baseline: string;
      }>;
    };
    verification: {
      verdict: "PASS";
      verifierIdentity: string;
      evidenceRootSha256: string;
      gates: Array<{
        id: string;
        status: "PASS" | "NOT_APPLICABLE";
        detail: string;
      }>;
      regressionIds: string[];
    };
    decision: {
      proofState: "OBSERVED";
      promotionEligible: false;
      reason: string;
      previousVerifiedStatePreserved: true;
    };
    claimBoundary: string[];
  };
  proofEnvelopeMissingBindings: string[];
  kpi: {
    label: "feature-stage-speedup";
    comparison: "direct-metal-vs-release-compiled-scalar-double-cpu-reference";
    geometricMeanSpeedup: number;
    weakestAssetMedianSpeedup: number;
    assetMedianSpeedups: Array<{asset: string; speedup: number}>;
    exclusions: string[];
  };
  execution: {
    campaignCount: number;
    assetCount: number;
    receiptCount: number;
    decodedFrameCount: number;
    device: string;
    hardwareRequired: true;
    hardwareInUse: true;
    compressedSamplesVerified: true;
    pixelFormat: "420v";
    iosurfaceBacked: true;
    directMetalPlaneMappings: true;
    noApplicationFullFrameStaging: true;
  };
  timeline: {
    exactReceiptCount: number;
    callbackReorderingObserved: true;
    decodeOrderPtsInversionObserved: true;
    presentationTimelineSha256: string;
    droppedFrames: 0;
    interruptedFrames: 0;
  };
  parity: {
    exactSelectionReceiptCount: number;
    numericalParityReceiptCount: number;
    mismatchCount: 0;
    maximumAbsoluteError: number;
    comparedValueCount: number;
    selectorPolicy: string;
    tokenReductionPercent: number;
    selectedFrames: number;
  };
  redTeam: {
    kind: "receipt-mutator-negative-controls";
    rejectedControlCount: number;
    controls: Array<{
      name: string;
      expectedGate: string;
      failedGates: string[];
      verdict: "REJECTED";
    }>;
    limitation: string;
    runtime: {
      kind: "runtime-negative-control-suite";
      artifactSha256: string;
      executableSha256: string;
      assetSha256: string;
      executedControlCount: number;
      controls: Array<{
        fault: string;
        expectedGate: string;
        observedGate: string;
        exitCode: 2;
        verdict: "PASS";
      }>;
      limitation: string;
    };
    recovery: {
      status: "PRIOR_DIGEST_VALID_EVIDENCE_UNCHANGED";
      evidence: string;
    };
  };
  artifacts: {
    aggregateFileSha256: string;
    aggregatePayloadSha256: string;
    inputSha256: Array<{asset: string; sha256: string}>;
    runtimeControlArtifactSha256: string;
    runtimeControlExecutableSha256: string;
    receiptSha256: string[];
  };
  proofBoundary: string;
  evidenceSource: {
    mode: "LIVE_SIBLING_M5_ARTIFACTS" | "SEALED_LOCAL_SNAPSHOT";
    label: string;
    validation:
      | "LIVE_ARTIFACT_BINDINGS_REVALIDATED"
      | "SEALED_BYTES_HASH_SCHEMA_SEMANTICS_VALIDATED";
    currentHardwareRun: false;
    snapshotSha256: string | null;
  };
}

export interface SystemInfo {
  arkConfigured: boolean;
  demoRunner: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  modelRouting?: {
    mode: "off" | "least-cost-qualified-v1";
    catalogConfigured: boolean;
    minQualityScore: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxCostMicroUnits: number | null;
    globalBudget: GlobalSyntheticBudgetInfo;
    boundary: string;
  };
  workspaceResources?: WorkspaceResourceInfo;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
