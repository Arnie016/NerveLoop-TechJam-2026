import {createHash} from "node:crypto";
import {lstat, readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const SCORECARD_MODULE_URL = new URL(
  "../../../scripts/judge-evidence-scorecard.mjs",
  import.meta.url,
);
const SEALED_SNAPSHOT_URL = new URL(
  "../../../evidence/judge-evidence-summary.json",
  import.meta.url,
);
const SEALED_SNAPSHOT_MANIFEST_URL = new URL(
  "../../../evidence/judge-evidence-summary.manifest.json",
  import.meta.url,
);
const PROJECT_ROOT_PATH = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const SEALED_SNAPSHOT_MANIFEST_SHA256 =
  "aa70574fa596fdbdeb573ed7e75041ea004f8eb9dea785007345ed6f2ca6a3ec";

export const JUDGE_EVIDENCE_MAX_BYTES = 64 * 1024;

const headlineKpiKeys = [
  "evidenceLanesPassed",
  "evidenceLaneCount",
  "promotedChanges",
  "promotedLocalCandidates",
  "retainedBaselines",
  "negativeControlFamiliesRejected",
  "negativeControlFamilyCount",
  "weakestPromotedPerformanceRatio",
  "videoTokenProxyReductionPercent",
  "adaptiveRepairHiddenCases",
  "adaptiveRepairFinalFailures",
  "adaptiveRepairSynthesizedCandidates",
  "adaptiveRepairPromotedRegressions",
  "adaptiveRepairTraceSpans",
  "heldoutCampaignCount",
  "heldoutCasesPerCampaign",
  "heldoutUnsafePromotionEvents",
  "heldoutUnsafeCandidateCampaigns",
  "heldoutNegativeBehaviorFamiliesRejected",
  "heldoutIndeterminateOutcomes",
  "heldoutPermutationInvariantReplays",
  "heldoutTotalCandidateCaseExecutions",
] as const;

const laneContracts = [
  {
    id: "adaptive-video-repair",
    passDecision: "PROMOTE_LOCAL_CANDIDATE",
    kpis: [
      "hiddenCaseCount",
      "initialFailureCount",
      "rejectedPartialFailureCount",
      "finalFailureCount",
      "postPromotionFailureCount",
      "containmentCapabilitiesDenied",
      "synthesizedCandidateCount",
      "promotedRegressionCases",
      "repairTraceSpanCount",
      "repairTraceDurationMs",
    ],
    requiredKpis: ["hiddenCaseCount", "finalFailureCount", "synthesizedCandidateCount",
      "promotedRegressionCases", "repairTraceSpanCount"],
  },
  {
    id: "framefuse-metal",
    passDecision: "PROMOTE",
    kpis: [
      "replicationCount",
      "medianGeometricMeanSpeedup",
      "minimumObservedWorstCaseSpeedup",
      "maximumHiddenMismatchCount",
      "attackerMaximumHiddenMismatchCount",
    ],
    requiredKpis: ["minimumObservedWorstCaseSpeedup", "maximumHiddenMismatchCount"],
  },
  {
    id: "residual-rmsnorm",
    passDecision: "RETAIN_BASELINE",
    kpis: [
      "replicationCount",
      "bestObservedGeometricMeanSpeedup",
      "weakestObservedShapeSpeedup",
      "maximumAttackerHiddenMismatches",
    ],
    requiredKpis: ["weakestObservedShapeSpeedup", "maximumAttackerHiddenMismatches"],
  },
  {
    id: "video-token-governor",
    passDecision: "PROMOTE",
    kpis: [
      "replicationCount",
      "minimumTokenReductionPercent",
      "minimumRareEventRecall",
      "minimumSceneBoundaryRecall",
      "exactOneFrameEventRecallFloor",
      "twoSidedCutPairRecallFloor",
      "maximumTemporalGapFrames",
      "maximumP95SelectionMs",
      "negativeControlFamiliesRejected",
      "negativeControlFamilyCount",
    ],
    requiredKpis: [
      "minimumTokenReductionPercent",
      "exactOneFrameEventRecallFloor",
      "twoSidedCutPairRecallFloor",
    ],
  },
  {
    id: "decision-calibration",
    passDecision: "CALIBRATION_PASS",
    kpis: [
      "distinctNegativePrograms",
      "negativeBehaviorFamilies",
      "distinctPositivePrograms",
      "observedUnsafePromotionRate",
      "observedSafeAcceptanceRate",
    ],
    requiredKpis: [
      "distinctNegativePrograms",
      "negativeBehaviorFamilies",
      "observedUnsafePromotionRate",
    ],
  },
  {
    id: "fresh-functional-replay",
    passDecision: "REPLAY_PASS",
    kpis: ["freshReplayCount", "durationMs", "performanceRetimed"],
    requiredKpis: ["freshReplayCount"],
  },
  {
    id: "post-commit-heldout-calibration",
    passDecision: "HELDOUT_CALIBRATION_PASS",
    kpis: [
      "campaignCount",
      "casesPerCampaign",
      "unsafePromotionEvents",
      "unsafeCandidateCampaigns",
      "negativeBehaviorFamiliesRejected",
      "negativeBehaviorFamilyCount",
      "safeCandidateCampaigns",
      "falseStops",
      "indeterminateOutcomes",
      "permutationInvariantReplays",
      "permutationReplayCount",
      "totalCandidateCaseExecutions",
    ],
    requiredKpis: [
      "campaignCount",
      "casesPerCampaign",
      "unsafePromotionEvents",
      "unsafeCandidateCampaigns",
      "negativeBehaviorFamiliesRejected",
      "indeterminateOutcomes",
      "permutationInvariantReplays",
      "totalCandidateCaseExecutions",
    ],
  },
] as const;

export type JudgeEvidenceMetric = number | boolean;

export interface JudgeEvidenceLane {
  id: string;
  question: string;
  decision: string;
  passedGateCount: number;
  gateCount: number;
  kpis: Record<string, JudgeEvidenceMetric>;
}

export interface JudgeRepairEpisodeSpan {
  sequence: number;
  spanId: string;
  parentSpanId: string;
  phase: string;
  action: string;
  status: string;
  durationMs: number;
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
  spans: JudgeRepairEpisodeSpan[];
  proofBoundary: string;
}

export interface JudgeEvidenceProjection {
  evidenceMode: "live-scorecard" | "sealed-snapshot";
  verdict: "EVIDENCE_GATE_PASS" | "EVIDENCE_GATE_FAIL";
  generatedAt: string;
  evaluationRule: string;
  decisionKpis: Record<string, JudgeEvidenceMetric>;
  lanes: JudgeEvidenceLane[];
  repairEpisode: JudgeRepairEpisode;
  decisionPath: string[];
  proofBoundary: string;
}

export type JudgeEvidenceSourceLoader = () => Promise<unknown>;

export interface JudgeEvidenceLoadOptions {
  sourceMode?: "auto" | "live-only" | "sealed-only";
  sourceLoader?: JudgeEvidenceSourceLoader;
  scorecardModuleUrl?: URL;
  sealedSnapshotUrl?: URL;
  sealedManifestUrl?: URL;
}

interface ScorecardModule {
  loadEvidence: () => Promise<unknown>;
  evaluateEvidence: (evidence: unknown) => unknown;
  evidencePaths: Record<string, unknown>;
}

interface JudgeEvidenceSnapshotManifest {
  schemaVersion: 1;
  algorithm: "sha256";
  artifact: "judge-evidence-summary.json";
  sha256: string;
  byteLength: number;
  generatedAt: string;
  verdict: "EVIDENCE_GATE_PASS" | "EVIDENCE_GATE_FAIL";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`JUDGE_EVIDENCE_INVALID_${label}`);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new Error(`JUDGE_EVIDENCE_INVALID_${label}`);
  }
  return value;
}

function metric(value: unknown, label: string): JudgeEvidenceMetric {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`JUDGE_EVIDENCE_INVALID_${label}`);
}

function safeInteger(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`JUDGE_EVIDENCE_INVALID_${label}`);
  }
  return value as number;
}

function finiteNumber(value: unknown, label: string, minimum = 0, maximum = 3_600_000): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`JUDGE_EVIDENCE_INVALID_${label}`);
  }
  return value;
}

function sha256String(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`JUDGE_EVIDENCE_INVALID_${label}`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const text = boundedString(value, label, 96);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(text)) {
    throw new Error(`JUDGE_EVIDENCE_INVALID_${label}`);
  }
  return text;
}

function loadRepairEpisode(rawValue: unknown): JudgeRepairEpisode {
  const raw = record(rawValue, "REPAIR_EPISODE");
  if (raw.schemaVersion !== 1 || raw.outcome !== "VERIFIED_AND_APPLIED_PENDING_SERVICE_ACCEPTANCE"
    || raw.retained !== true) throw new Error("JUDGE_EVIDENCE_INVALID_REPAIR_EPISODE");
  const traceId = sha256String(raw.traceId, "REPAIR_TRACE_ID");
  const traceSha256 = sha256String(raw.traceSha256, "REPAIR_TRACE_SHA256");
  const startedAt = boundedString(raw.startedAt, "REPAIR_STARTED_AT", 64);
  const completedAt = boundedString(raw.completedAt, "REPAIR_COMPLETED_AT", 64);
  if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(completedAt))
    || Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new Error("JUDGE_EVIDENCE_INVALID_REPAIR_TIMING");
  }
  const proposerRaw = record(raw.proposer, "REPAIR_PROPOSER");
  if (proposerRaw.kind !== "bounded-source-synthesis-v1" || proposerRaw.modelUsed !== false
    || proposerRaw.candidateCatalogueUsed !== false) {
    throw new Error("JUDGE_EVIDENCE_INVALID_REPAIR_PROPOSER");
  }
  const policyRaw = record(raw.policy, "REPAIR_POLICY");
  if (policyRaw.targetPath !== "src/segment-window.mjs" || policyRaw.writesAllowed !== 1
    || policyRaw.externalNetworkAllowed !== false || policyRaw.publicationAllowed !== false
    || policyRaw.hiddenOracleMutableByProposer !== false) {
    throw new Error("JUDGE_EVIDENCE_INVALID_REPAIR_POLICY");
  }
  if (!Array.isArray(raw.attempts) || raw.attempts.length < 2 || raw.attempts.length > 8) {
    throw new Error("JUDGE_EVIDENCE_INVALID_REPAIR_ATTEMPTS");
  }
  const attempts = raw.attempts.map((value, index) => {
    const attempt = record(value, `REPAIR_ATTEMPT_${index}`);
    if (attempt.index !== index + 1 || !Array.isArray(attempt.transforms)
      || attempt.transforms.length < 1 || attempt.transforms.length > 2) {
      throw new Error(`JUDGE_EVIDENCE_INVALID_REPAIR_ATTEMPT_${index}`);
    }
    const transforms = attempt.transforms.map((transform, transformIndex) => {
      const parsed = identifier(transform, `REPAIR_ATTEMPT_${index}_TRANSFORM_${transformIndex}`);
      if (!["half-open-intersection", "empty-window-guard"].includes(parsed)) {
        throw new Error(`JUDGE_EVIDENCE_INVALID_REPAIR_ATTEMPT_${index}_TRANSFORM`);
      }
      return parsed;
    });
    const verdict = boundedString(attempt.verdict, `REPAIR_ATTEMPT_${index}_VERDICT`, 64);
    if (!["OUTPUTS_REJECTED", "OUTPUTS_MATCH_ORACLE"].includes(verdict)) {
      throw new Error(`JUDGE_EVIDENCE_INVALID_REPAIR_ATTEMPT_${index}_VERDICT`);
    }
    return {
      index: index + 1,
      variant: identifier(attempt.variant, `REPAIR_ATTEMPT_${index}_VARIANT`),
      decisionReason: identifier(attempt.decisionReason, `REPAIR_ATTEMPT_${index}_REASON`),
      transforms,
      candidateSha256: sha256String(attempt.candidateSha256, `REPAIR_ATTEMPT_${index}_CANDIDATE`),
      verdict,
      failedCases: safeInteger(attempt.failedCases, `REPAIR_ATTEMPT_${index}_FAILURES`, 0, 100_000),
    };
  });
  if (!attempts.some(attempt => attempt.verdict === "OUTPUTS_REJECTED" && attempt.failedCases > 0)
    || attempts.at(-1)?.verdict !== "OUTPUTS_MATCH_ORACLE" || attempts.at(-1)?.failedCases !== 0) {
    throw new Error("JUDGE_EVIDENCE_INVALID_REPAIR_ATTEMPT_DECISIONS");
  }
  const regressionRaw = record(raw.regression, "REPAIR_REGRESSION");
  if (!Array.isArray(regressionRaw.categories) || regressionRaw.categories.length < 1
    || regressionRaw.categories.length > 8) throw new Error("JUDGE_EVIDENCE_INVALID_REPAIR_REGRESSION");
  const regression = {
    regressionId: identifier(regressionRaw.regressionId, "REPAIR_REGRESSION_ID"),
    caseId: identifier(regressionRaw.caseId, "REPAIR_REGRESSION_CASE"),
    categories: regressionRaw.categories.map((value, index) =>
      identifier(value, `REPAIR_REGRESSION_CATEGORY_${index}`)),
    startMs: safeInteger(regressionRaw.startMs, "REPAIR_REGRESSION_START", -1_000_000, 1_000_000),
    endMs: safeInteger(regressionRaw.endMs, "REPAIR_REGRESSION_END", -1_000_000, 1_000_000),
    expectedCount: safeInteger(regressionRaw.expectedCount, "REPAIR_REGRESSION_EXPECTED", 0, 32),
    actualCount: regressionRaw.actualCount === null ? null
      : safeInteger(regressionRaw.actualCount, "REPAIR_REGRESSION_ACTUAL", 0, 32),
    caseSha256: sha256String(regressionRaw.caseSha256, "REPAIR_REGRESSION_SHA256"),
  };
  const replayRaw = record(raw.regressionReplay, "REPAIR_REGRESSION_REPLAY");
  if (replayRaw.passed !== true || replayRaw.replayedByDistinctJob !== true
    || replayRaw.regressionId !== regression.regressionId) {
    throw new Error("JUDGE_EVIDENCE_INVALID_REPAIR_REGRESSION_REPLAY");
  }
  const regressionReplay = {
    regressionId: regression.regressionId,
    candidateSha256: sha256String(replayRaw.candidateSha256, "REPAIR_REPLAY_CANDIDATE"),
    fullOracleCases: safeInteger(replayRaw.fullOracleCases, "REPAIR_REPLAY_CASES", 1, 100_000),
    passed: true as const,
    replayedByDistinctJob: true as const,
  };
  if (regressionReplay.candidateSha256 !== attempts.at(-1)?.candidateSha256) {
    throw new Error("JUDGE_EVIDENCE_INVALID_REPAIR_REPLAY_BINDING");
  }
  if (!Array.isArray(raw.spans) || raw.spans.length < 7 || raw.spans.length > 32) {
    throw new Error("JUDGE_EVIDENCE_INVALID_REPAIR_SPANS");
  }
  const spanIds = new Set<string>();
  const spans = raw.spans.map((value, index) => {
    const span = record(value, `REPAIR_SPAN_${index}`);
    if (span.sequence !== index + 1 || span.parentSpanId !== traceId) {
      throw new Error(`JUDGE_EVIDENCE_INVALID_REPAIR_SPAN_${index}`);
    }
    const spanId = identifier(span.spanId, `REPAIR_SPAN_${index}_ID`);
    if (spanIds.has(spanId)) throw new Error("JUDGE_EVIDENCE_DUPLICATE_REPAIR_SPAN_ID");
    spanIds.add(spanId);
    return {
      sequence: index + 1,
      spanId,
      parentSpanId: traceId,
      phase: identifier(span.phase, `REPAIR_SPAN_${index}_PHASE`),
      action: identifier(span.action, `REPAIR_SPAN_${index}_ACTION`),
      status: identifier(span.status, `REPAIR_SPAN_${index}_STATUS`),
      durationMs: finiteNumber(span.durationMs, `REPAIR_SPAN_${index}_DURATION`),
    };
  });
  return {
    schemaVersion: 1,
    traceId,
    traceSha256,
    runId: identifier(raw.runId, "REPAIR_RUN_ID"),
    agentId: identifier(raw.agentId, "REPAIR_AGENT_ID"),
    startedAt,
    completedAt,
    durationMs: finiteNumber(raw.durationMs, "REPAIR_DURATION"),
    outcome: "VERIFIED_AND_APPLIED_PENDING_SERVICE_ACCEPTANCE",
    retained: true,
    proposer: {
      kind: "bounded-source-synthesis-v1",
      modelUsed: false,
      candidateCatalogueUsed: false,
      inputBoundary: boundedString(proposerRaw.inputBoundary, "REPAIR_PROPOSER_BOUNDARY", 1_024),
    },
    policy: {
      targetPath: "src/segment-window.mjs",
      attemptBudget: safeInteger(policyRaw.attemptBudget, "REPAIR_ATTEMPT_BUDGET", 1, 8),
      writesAllowed: 1,
      externalNetworkAllowed: false,
      publicationAllowed: false,
      hiddenOracleMutableByProposer: false,
    },
    attempts,
    regression,
    regressionReplay,
    spans,
    proofBoundary: boundedString(raw.proofBoundary, "REPAIR_PROOF_BOUNDARY", 4_096),
  };
}

function selectedMetrics(
  rawValue: unknown,
  keys: readonly string[],
  requiredKeys: readonly string[],
  label: string,
): Record<string, JudgeEvidenceMetric> {
  const raw = record(rawValue, label);
  const selected: Record<string, JudgeEvidenceMetric> = {};
  for (const key of keys) {
    if (Object.hasOwn(raw, key)) selected[key] = metric(raw[key], `${label}_${key}`);
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(selected, key)) throw new Error(`JUDGE_EVIDENCE_MISSING_${label}_${key}`);
  }
  return selected;
}

function loadLane(
  rawValue: unknown,
  contract: (typeof laneContracts)[number],
  index: number,
): JudgeEvidenceLane {
  const raw = record(rawValue, `LANE_${index}`);
  if (raw.id !== contract.id) throw new Error(`JUDGE_EVIDENCE_INVALID_LANE_${index}_ID`);
  const decision = boundedString(raw.decision, `LANE_${index}_DECISION`, 64);
  if (decision !== contract.passDecision && decision !== "BLOCK") {
    throw new Error(`JUDGE_EVIDENCE_INVALID_LANE_${index}_DECISION`);
  }
  if (!Array.isArray(raw.gates) || raw.gates.length === 0 || raw.gates.length > 64) {
    throw new Error(`JUDGE_EVIDENCE_INVALID_LANE_${index}_GATES`);
  }
  const passedGateCount = raw.gates.reduce((count, rawGate, gateIndex) => {
    const gateRecord = record(rawGate, `LANE_${index}_GATE_${gateIndex}`);
    if (typeof gateRecord.passed !== "boolean") {
      throw new Error(`JUDGE_EVIDENCE_INVALID_LANE_${index}_GATE_${gateIndex}_PASSED`);
    }
    return count + (gateRecord.passed ? 1 : 0);
  }, 0);
  if ((decision === "BLOCK") === (passedGateCount === raw.gates.length)) {
    throw new Error(`JUDGE_EVIDENCE_INCONSISTENT_LANE_${index}_DECISION`);
  }
  return {
    id: contract.id,
    question: boundedString(raw.question, `LANE_${index}_QUESTION`, 1_024),
    decision,
    passedGateCount,
    gateCount: raw.gates.length,
    kpis: selectedMetrics(raw.kpis, contract.kpis, contract.requiredKpis, `LANE_${index}_KPIS`),
  };
}

export function projectJudgeEvidence(rawValue: unknown): JudgeEvidenceProjection {
  const raw = record(rawValue, "REPORT");
  if (raw.schemaVersion !== 1) throw new Error("JUDGE_EVIDENCE_INVALID_SCHEMA_VERSION");
  const verdict = raw.overallVerdict;
  if (verdict !== "EVIDENCE_GATE_PASS" && verdict !== "EVIDENCE_GATE_FAIL") {
    throw new Error("JUDGE_EVIDENCE_INVALID_VERDICT");
  }
  const generatedAt = boundedString(raw.generatedAt, "GENERATED_AT", 64);
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("JUDGE_EVIDENCE_INVALID_GENERATED_AT");
  const rawLanes = raw.lanes;
  if (!Array.isArray(rawLanes) || rawLanes.length !== laneContracts.length) {
    throw new Error("JUDGE_EVIDENCE_INVALID_LANE_COUNT");
  }
  const lanes = laneContracts.map((contract, index) => loadLane(rawLanes[index], contract, index));
  const repairEpisode = loadRepairEpisode(raw.repairEpisode);
  const passedLaneCount = lanes.filter(lane => lane.decision !== "BLOCK").length;
  const decisionKpis = selectedMetrics(
    raw.decisionKpis,
    headlineKpiKeys,
    headlineKpiKeys,
    "HEADLINE_KPIS",
  );
  if (
    decisionKpis.evidenceLaneCount !== laneContracts.length
    || decisionKpis.evidenceLanesPassed !== passedLaneCount
    || (verdict === "EVIDENCE_GATE_PASS") !== (passedLaneCount === laneContracts.length)
  ) {
    throw new Error("JUDGE_EVIDENCE_INCONSISTENT_VERDICT");
  }
  if (!Array.isArray(raw.observableDecisionPath) || raw.observableDecisionPath.length === 0
    || raw.observableDecisionPath.length > 16) {
    throw new Error("JUDGE_EVIDENCE_INVALID_DECISION_PATH");
  }
  const decisionPath = raw.observableDecisionPath.map((step, index) =>
    boundedString(step, `DECISION_PATH_${index}`, 512));
  const projection: JudgeEvidenceProjection = {
    evidenceMode: "live-scorecard",
    verdict,
    generatedAt,
    evaluationRule: boundedString(raw.evaluationRule, "EVALUATION_RULE", 2_048),
    decisionKpis,
    lanes,
    repairEpisode,
    decisionPath,
    proofBoundary: boundedString(raw.proofBoundary, "PROOF_BOUNDARY", 4_096),
  };
  if (Buffer.byteLength(JSON.stringify(projection), "utf8") > JUDGE_EVIDENCE_MAX_BYTES) {
    throw new Error("JUDGE_EVIDENCE_PROJECTION_TOO_LARGE");
  }
  return projection;
}

async function regularFileState(url: URL, label: string): Promise<"present" | "missing"> {
  try {
    const stat = await lstat(fileURLToPath(url));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`JUDGE_EVIDENCE_INVALID_${label}_FILE`);
    }
    return "present";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    throw error;
  }
}

async function importScorecardModule(url: URL): Promise<ScorecardModule> {
  const imported = await import(url.href) as unknown;
  const scorecard = imported as Partial<ScorecardModule>;
  if (typeof scorecard.loadEvidence !== "function"
    || typeof scorecard.evaluateEvidence !== "function"
    || typeof scorecard.evidencePaths !== "object"
    || scorecard.evidencePaths === null
    || Array.isArray(scorecard.evidencePaths)) {
    throw new Error("JUDGE_EVIDENCE_MODULE_CONTRACT_INVALID");
  }
  return scorecard as ScorecardModule;
}

function scorecardSiblingPrerequisites(scorecard: ScorecardModule): URL[] {
  const paths = record(scorecard.evidencePaths, "LIVE_EVIDENCE_PATHS");
  const rawPaths = [paths.frameFuse, paths.rmsNorm, paths.videoTokenOracle];
  if (!Array.isArray(paths.videoTokenRuns) || paths.videoTokenRuns.length === 0) {
    throw new Error("JUDGE_EVIDENCE_MODULE_PATH_CONTRACT_INVALID");
  }
  rawPaths.push(...paths.videoTokenRuns);
  const result = rawPaths.map((value, index) => {
    const candidate = boundedString(value, `LIVE_SIBLING_PATH_${index}`, 4_096);
    if (!path.isAbsolute(candidate)) {
      throw new Error("JUDGE_EVIDENCE_MODULE_PATH_CONTRACT_INVALID");
    }
    const resolved = path.resolve(candidate);
    const relative = path.relative(PROJECT_ROOT_PATH, resolved);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      throw new Error("JUDGE_EVIDENCE_MODULE_PATH_CONTRACT_INVALID");
    }
    return pathToFileURL(resolved);
  });
  if (new Set(result.map(url => fileURLToPath(url))).size !== result.length) {
    throw new Error("JUDGE_EVIDENCE_MODULE_PATH_CONTRACT_INVALID");
  }
  return result;
}

async function allSiblingPrerequisitesPresent(scorecard: ScorecardModule): Promise<boolean> {
  const states = await Promise.all(scorecardSiblingPrerequisites(scorecard).map((url, index) =>
    regularFileState(url, `LIVE_SIBLING_${index}`)));
  return states.every(state => state === "present");
}

async function loadCurrentScorecard(scorecard: ScorecardModule): Promise<unknown> {
  const evidence = await scorecard.loadEvidence();
  return scorecard.evaluateEvidence(evidence);
}

function parseSnapshotManifest(rawValue: unknown): JudgeEvidenceSnapshotManifest {
  const raw = record(rawValue, "SNAPSHOT_MANIFEST");
  if (
    raw.schemaVersion !== 1
    || raw.algorithm !== "sha256"
    || raw.artifact !== "judge-evidence-summary.json"
    || typeof raw.sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(raw.sha256)
    || typeof raw.byteLength !== "number"
    || !Number.isSafeInteger(raw.byteLength)
    || raw.byteLength <= 0
    || raw.byteLength > JUDGE_EVIDENCE_MAX_BYTES
    || typeof raw.generatedAt !== "string"
    || !Number.isFinite(Date.parse(raw.generatedAt))
    || (raw.verdict !== "EVIDENCE_GATE_PASS" && raw.verdict !== "EVIDENCE_GATE_FAIL")
  ) {
    throw new Error("JUDGE_EVIDENCE_INVALID_SNAPSHOT_MANIFEST");
  }
  return raw as unknown as JudgeEvidenceSnapshotManifest;
}

function snapshotAsScorecard(rawValue: unknown): Record<string, unknown> {
  const raw = record(rawValue, "SNAPSHOT");
  if (!Array.isArray(raw.lanes)) throw new Error("JUDGE_EVIDENCE_INVALID_SNAPSHOT_LANES");
  return {
    schemaVersion: 1,
    generatedAt: raw.generatedAt,
    evaluationRule: raw.evaluationRule,
    overallVerdict: raw.verdict,
    decisionKpis: raw.decisionKpis,
    repairEpisode: raw.repairEpisode,
    lanes: raw.lanes.map((rawLane, laneIndex) => {
      const lane = record(rawLane, `SNAPSHOT_LANE_${laneIndex}`);
      if (
        typeof lane.passedGateCount !== "number"
        || !Number.isSafeInteger(lane.passedGateCount)
        || typeof lane.gateCount !== "number"
        || !Number.isSafeInteger(lane.gateCount)
        || lane.gateCount <= 0
        || lane.passedGateCount < 0
        || lane.passedGateCount > lane.gateCount
      ) {
        throw new Error(`JUDGE_EVIDENCE_INVALID_SNAPSHOT_LANE_${laneIndex}_GATE_COUNTS`);
      }
      const passedGateCount = lane.passedGateCount;
      const gateCount = lane.gateCount;
      return {
        id: lane.id,
        question: lane.question,
        decision: lane.decision,
        kpis: lane.kpis,
        gates: Array.from({length: gateCount}, (_, gateIndex) => ({
          passed: gateIndex < passedGateCount,
        })),
      };
    }),
    observableDecisionPath: raw.decisionPath,
    proofBoundary: raw.proofBoundary,
  };
}

export async function loadSealedJudgeEvidence(
  snapshotUrl: URL = SEALED_SNAPSHOT_URL,
  manifestUrl: URL = SEALED_SNAPSHOT_MANIFEST_URL,
): Promise<JudgeEvidenceProjection> {
  const [snapshotStat, manifestStat] = await Promise.all([
    lstat(fileURLToPath(snapshotUrl)),
    lstat(fileURLToPath(manifestUrl)),
  ]);
  if (
    !snapshotStat.isFile()
    || snapshotStat.isSymbolicLink()
    || snapshotStat.size <= 0
    || snapshotStat.size > JUDGE_EVIDENCE_MAX_BYTES
    || !manifestStat.isFile()
    || manifestStat.isSymbolicLink()
    || manifestStat.size <= 0
    || manifestStat.size > 16 * 1024
  ) {
    throw new Error("JUDGE_EVIDENCE_INVALID_SNAPSHOT_FILES");
  }
  const [snapshotBytes, manifestBytes] = await Promise.all([
    readFile(fileURLToPath(snapshotUrl)),
    readFile(fileURLToPath(manifestUrl)),
  ]);
  const manifestDigest = createHash("sha256").update(manifestBytes).digest("hex");
  if (manifestDigest !== SEALED_SNAPSHOT_MANIFEST_SHA256) {
    throw new Error("JUDGE_EVIDENCE_SNAPSHOT_MANIFEST_DIGEST_MISMATCH");
  }
  const manifest = parseSnapshotManifest(JSON.parse(manifestBytes.toString("utf8")));
  const digest = createHash("sha256").update(snapshotBytes).digest("hex");
  if (manifest.byteLength !== snapshotBytes.length || manifest.sha256 !== digest) {
    throw new Error("JUDGE_EVIDENCE_SNAPSHOT_DIGEST_MISMATCH");
  }
  const projection = projectJudgeEvidence(snapshotAsScorecard(
    JSON.parse(snapshotBytes.toString("utf8")),
  ));
  if (projection.generatedAt !== manifest.generatedAt || projection.verdict !== manifest.verdict) {
    throw new Error("JUDGE_EVIDENCE_SNAPSHOT_MANIFEST_MISMATCH");
  }
  return {...projection, evidenceMode: "sealed-snapshot"};
}

export async function loadJudgeEvidence(
  sourceLoaderOrOptions?: JudgeEvidenceSourceLoader | JudgeEvidenceLoadOptions,
): Promise<JudgeEvidenceProjection> {
  const options: JudgeEvidenceLoadOptions = typeof sourceLoaderOrOptions === "function"
    ? {sourceMode: "live-only", sourceLoader: sourceLoaderOrOptions}
    : sourceLoaderOrOptions ?? {};
  const sourceMode = options.sourceMode ?? "auto";
  if (options.sourceLoader) {
    if (sourceMode === "sealed-only") {
      throw new Error("JUDGE_EVIDENCE_SOURCE_MODE_CONFLICT");
    }
    return projectJudgeEvidence(await options.sourceLoader());
  }
  if (sourceMode === "sealed-only") {
    return loadSealedJudgeEvidence(options.sealedSnapshotUrl, options.sealedManifestUrl);
  }

  const moduleUrl = options.scorecardModuleUrl ?? SCORECARD_MODULE_URL;
  const moduleState = await regularFileState(moduleUrl, "LIVE_SCORECARD");
  if (moduleState === "missing") {
    if (sourceMode === "live-only") {
      throw new Error("JUDGE_EVIDENCE_LIVE_SCORECARD_MISSING");
    }
    return loadSealedJudgeEvidence(options.sealedSnapshotUrl, options.sealedManifestUrl);
  }
  const scorecard = await importScorecardModule(moduleUrl);
  if (!(await allSiblingPrerequisitesPresent(scorecard))) {
    if (sourceMode === "live-only") {
      throw new Error("JUDGE_EVIDENCE_LIVE_SIBLING_PREREQUISITES_MISSING");
    }
    return loadSealedJudgeEvidence(options.sealedSnapshotUrl, options.sealedManifestUrl);
  }
  // Once every live sibling prerequisite is present, live validation is
  // authoritative. Any parsing, identity, semantics or evaluation failure must
  // surface instead of being hidden by the historical sealed snapshot.
  return projectJudgeEvidence(await loadCurrentScorecard(scorecard));
}
