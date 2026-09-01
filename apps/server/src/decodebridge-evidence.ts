import {createHash} from "node:crypto";
import {lstat, readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  loadDecodeBridgeAgentServiceProof,
  type DecodeBridgeAgentServiceProofOptions,
  type DecodeBridgeGovernedRunProjection,
} from "./decodebridge-agentservice-proof.js";
import {
  buildDecodeBridgeCausalReflex,
  type DecodeBridgeCausalReflexProjection,
} from "./decodebridge-causal-reflex.js";

const DEFAULT_EXPERIMENT_ROOT_URL = new URL(
  "../../../../experiments/decodebridge-video-ingest/",
  import.meta.url,
);
const DEFAULT_CAMPAIGN_RELATIVE_PATH =
  "artifacts/campaigns/2026-08-30T070339Z/";
const DEFAULT_SEALED_SNAPSHOT_URL = new URL(
  "../../../evidence/decodebridge-sealed-evidence.v1.json",
  import.meta.url,
);
const DEFAULT_SEALED_MANIFEST_URL = new URL(
  "../../../evidence/decodebridge-sealed-evidence.v1.manifest.json",
  import.meta.url,
);
// The manifest is the repository trust anchor for the delivery fallback. Updating
// either sealed file therefore requires an explicit source change and review.
const SEALED_MANIFEST_SHA256 =
  "971fd5dbc39d1b881eaddbcb462200db2c84a51bde586edd63c679a6bf40404f";

const MAX_AGGREGATE_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 512 * 1024;
const MAX_VERIFICATION_BYTES = 32 * 1024;

type JsonRecord = Record<string, unknown>;

export interface DecodeBridgeActionStage {
  id: "proposed" | "allowed" | "leased" | "executed" | "verified" | "retained";
  label: string;
  status: "DEFINED" | "ALLOWED_LOCAL_SCOPE" | "NOT_EVIDENCED" | "EXECUTED" | "VERIFIED" |
    "LEASE_CONSUMED_CLOSED" | "LOCAL_CANDIDATE_ONLY";
  evidence: string;
  provenance: "artifact-contract" | "adapter-policy" | "sealed-receipts" | "agentservice-proof";
}

export interface DecodeBridgeEvidenceProjection {
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
  actionStages: DecodeBridgeActionStage[];
  governedRun: DecodeBridgeGovernedRunProjection;
  causalReflex: DecodeBridgeCausalReflexProjection;
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

export interface DecodeBridgeEvidenceOptions {
  experimentRootUrl?: URL;
  campaignRelativePath?: string;
  agentServiceProofOptions?: DecodeBridgeAgentServiceProofOptions;
  sourceMode?: "auto" | "live-only" | "sealed-only";
  sealedSnapshotUrl?: URL;
  sealedManifestUrl?: URL;
}

type DecodeBridgeEvidenceSnapshot = Omit<DecodeBridgeEvidenceProjection, "evidenceSource">;

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`DECODEBRIDGE_INVALID_${label}`);
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`DECODEBRIDGE_INVALID_${label}`);
  return value;
}

function string(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`DECODEBRIDGE_INVALID_${label}`);
  }
  return value;
}

function number(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new Error(`DECODEBRIDGE_INVALID_${label}`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`DECODEBRIDGE_INVALID_${label}`);
  }
  return value as number;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`DECODEBRIDGE_INVALID_${label}`);
  }
  return value;
}

function requireTrue(value: unknown, label: string): true {
  if (value !== true) throw new Error(`DECODEBRIDGE_GATE_${label}`);
  return true;
}

function requireZero(value: unknown, label: string): 0 {
  if (value !== 0) throw new Error(`DECODEBRIDGE_GATE_${label}`);
  return 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const raw = value as JsonRecord;
    return `{${Object.keys(raw).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(raw[key])}`).join(",")}}`;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("DECODEBRIDGE_INVALID_CANONICAL_NUMBER");
    const magnitude = Math.abs(value);
    let encoded = value.toString();
    // Match the Python verifier's json.dumps float exponent convention.
    if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e16)) {
      encoded = value.toExponential();
    }
    if (encoded.includes("e")) {
      const [mantissa, rawExponent] = encoded.split("e");
      const negative = rawExponent!.startsWith("-");
      const exponent = rawExponent!.replace(/^[-+]/, "").padStart(2, "0");
      return `${mantissa}e${negative ? "-" : "+"}${exponent}`;
    }
    return encoded;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("DECODEBRIDGE_INVALID_CANONICAL_JSON");
  return encoded;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readRegularFile(url: URL, maximumBytes: number, label: string): Promise<Buffer> {
  const filePath = fileURLToPath(url);
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximumBytes) {
    throw new Error(`DECODEBRIDGE_INVALID_${label}_FILE`);
  }
  return readFile(filePath);
}

async function readJson(url: URL, maximumBytes: number, label: string): Promise<{
  bytes: Buffer;
  value: JsonRecord;
}> {
  const bytes = await readRegularFile(url, maximumBytes, label);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`DECODEBRIDGE_INVALID_${label}_JSON`);
  }
  return {bytes, value: record(parsed, label)};
}

function resolveBoundedArtifact(
  experimentRootUrl: URL,
  campaignRelativePath: string,
  relativePath: string,
): URL {
  if (!relativePath.startsWith(campaignRelativePath) || relativePath.includes("\\")) {
    throw new Error("DECODEBRIDGE_INVALID_RECEIPT_PATH");
  }
  const resolved = new URL(relativePath, experimentRootUrl);
  const campaignRootPath = path.resolve(fileURLToPath(new URL(campaignRelativePath, experimentRootUrl)));
  const resolvedPath = path.resolve(fileURLToPath(resolved));
  if (resolvedPath !== campaignRootPath && !resolvedPath.startsWith(`${campaignRootPath}${path.sep}`)) {
    throw new Error("DECODEBRIDGE_RECEIPT_PATH_ESCAPE");
  }
  return resolved;
}

function numericArray(value: unknown, label: string): number[] {
  return array(value, label).map((entry, index) => number(entry, `${label}_${index}`));
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, label).map((entry, index) => string(entry, `${label}_${index}`, 256));
}

interface ValidReceipt {
  frames: number;
  asset: string;
  inputSha256: string;
  device: string;
  featureContract: string;
  timelineSha256: string;
  maximumAbsoluteError: number;
  comparedValueCount: number;
  selectorPolicy: string;
  tokenReductionPercent: number;
  selectedFrames: number;
  rowStridePaddingObserved: boolean;
}

async function validateReceipt(
  raw: JsonRecord,
  recordRaw: JsonRecord,
  experimentRootUrl: URL,
): Promise<ValidReceipt> {
  if (raw.schemaVersion !== 1) throw new Error("DECODEBRIDGE_INVALID_RECEIPT_SCHEMA");
  const inputPath = string(raw.inputPath, "INPUT_PATH", 256);
  if (inputPath !== recordRaw.asset) throw new Error("DECODEBRIDGE_RECEIPT_ASSET_MISMATCH");
  const inputSha256 = sha256(raw.inputSHA256, "INPUT_SHA256");
  const inputUrl = new URL(`artifacts/${encodeURIComponent(inputPath)}`, experimentRootUrl);
  const inputBytes = await readRegularFile(inputUrl, 1024 * 1024 * 1024, "INPUT_ASSET");
  if (digest(inputBytes) !== inputSha256) throw new Error("DECODEBRIDGE_INPUT_DIGEST_MISMATCH");

  requireTrue(raw.compressedSamplesVerified, "COMPRESSED_SAMPLES");
  requireTrue(raw.hardwareRequired, "HARDWARE_REQUIRED");
  requireTrue(raw.hardwareInUse, "HARDWARE_IN_USE");
  requireTrue(raw.presentationTimelineExactMatch, "TIMELINE_EXACT");
  requireTrue(raw.callbackOrderDiffersFromPresentationOrder, "CALLBACK_REORDERING");
  requireTrue(raw.decodeOrderContainsPTSInversion, "PTS_INVERSION");
  requireTrue(raw.metalCompatiblePlaneMappings, "METAL_PLANE_MAPPING");
  requireTrue(raw.featureParityPassed, "FEATURE_PARITY");
  requireTrue(raw.selectionExactMatch, "SELECTION_EXACT");
  requireZero(raw.droppedFrameCount, "DROPPED_FRAMES");
  requireZero(raw.interruptedFrameCount, "INTERRUPTED_FRAMES");

  const frames = integer(raw.decodedFrameCount, "DECODED_FRAMES", 1);
  if (raw.sampleCount !== frames || raw.iosurfaceBackedFrameCount !== frames) {
    throw new Error("DECODEBRIDGE_GATE_FRAME_ACCOUNTING");
  }
  const pixelFormats = stringArray(raw.pixelFormats, "PIXEL_FORMATS");
  if (pixelFormats.length !== 1 || pixelFormats[0] !== "420v") {
    throw new Error("DECODEBRIDGE_GATE_PIXEL_FORMAT");
  }

  const parity = record(raw.featureParity, "FEATURE_PARITY");
  requireZero(parity.mismatchCount, "PARITY_MISMATCHES");
  const maximumAbsoluteError = number(parity.maximumAbsoluteError, "MAXIMUM_ABSOLUTE_ERROR");
  const comparedValueCount = integer(parity.comparedValueCount, "COMPARED_VALUE_COUNT", 1);

  const metalMetrics = record(raw.metalFeatureMetrics, "METAL_METRICS");
  if (metalMetrics.commandStatus !== "completed"
    || integer(metalMetrics.commandBuffersSubmitted, "COMMANDS_SUBMITTED", 1)
      !== integer(metalMetrics.commandBuffersCompleted, "COMMANDS_COMPLETED", 1)
    || metalMetrics.pixelStagingBytes !== 0
    || metalMetrics.baseAddressLockCount !== 0
    || metalMetrics.blitEncoderCount !== 0) {
    throw new Error("DECODEBRIDGE_GATE_METAL_COMPLETION_OR_STAGING");
  }
  const cpuMetrics = record(raw.cpuFeatureMetrics, "CPU_METRICS");
  integer(cpuMetrics.baseAddressLockCount, "CPU_BASE_LOCKS", 1);
  if (cpuMetrics.pixelStagingBytes !== 0) throw new Error("DECODEBRIDGE_GATE_CPU_STAGING");

  const benchmark = record(raw.featureBenchmark, "FEATURE_BENCHMARK");
  if (benchmark.mode !== "balanced-feature-benchmark"
    || benchmark.cpuDeterministic !== true
    || benchmark.metalDeterministic !== true
    || benchmark.localStageThresholdMet !== true
    || benchmark.promotionEligible !== false) {
    throw new Error("DECODEBRIDGE_GATE_BENCHMARK_CONTRACT");
  }
  const timedOrder = stringArray(benchmark.timedOrder, "TIMED_ORDER");
  if (!["cpu,metal,metal,cpu", "metal,cpu,cpu,metal"].includes(timedOrder.join(","))) {
    throw new Error("DECODEBRIDGE_GATE_BALANCED_ORDER");
  }
  const recordSpeedup = number(recordRaw.median_feature_stage_speedup, "RECORD_SPEEDUP");
  const receiptSpeedup = number(benchmark.medianFeatureStageSpeedup, "RECEIPT_SPEEDUP");
  if (Math.abs(recordSpeedup - receiptSpeedup) > Number.EPSILON * Math.max(recordSpeedup, 1) * 8) {
    throw new Error("DECODEBRIDGE_SPEEDUP_BINDING_MISMATCH");
  }

  const cpuSelection = record(raw.cpuSelection, "CPU_SELECTION");
  const metalSelection = record(raw.metalSelection, "METAL_SELECTION");
  const cpuFrames = numericArray(cpuSelection.selectedFrames, "CPU_SELECTED_FRAMES");
  const metalFrames = numericArray(metalSelection.selectedFrames, "METAL_SELECTED_FRAMES");
  if (canonicalJson(cpuFrames) !== canonicalJson(metalFrames)) {
    throw new Error("DECODEBRIDGE_SELECTION_LIST_MISMATCH");
  }
  const cpuDiagnostics = record(cpuSelection.diagnostics, "CPU_SELECTION_DIAGNOSTICS");
  const metalDiagnostics = record(metalSelection.diagnostics, "METAL_SELECTION_DIAGNOSTICS");
  if (sha256(cpuDiagnostics.selectedDigestSHA256, "CPU_SELECTED_DIGEST")
      !== sha256(metalDiagnostics.selectedDigestSHA256, "METAL_SELECTED_DIGEST")
    || cpuDiagnostics.selectedTokenCount !== metalDiagnostics.selectedTokenCount
    || cpuDiagnostics.fullTokenCount !== metalDiagnostics.fullTokenCount) {
    throw new Error("DECODEBRIDGE_SELECTION_BINDING_MISMATCH");
  }

  return {
    frames,
    asset: inputPath,
    inputSha256,
    device: string(raw.metalDevice, "METAL_DEVICE", 256),
    featureContract: string(raw.featureContract, "FEATURE_CONTRACT", 256),
    timelineSha256: sha256(raw.presentationTimelineSHA256, "TIMELINE_SHA256"),
    maximumAbsoluteError,
    comparedValueCount,
    selectorPolicy: string(raw.selectorPolicy, "SELECTOR_POLICY", 256),
    tokenReductionPercent: number(raw.tokenReductionPercent, "TOKEN_REDUCTION"),
    selectedFrames: cpuFrames.length,
    rowStridePaddingObserved: raw.rowStridePaddingObserved === true,
  };
}

function normalizedCapturedAt(value: unknown): string {
  const raw = string(value, "CAPTURED_AT", 32);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw);
  const normalized = match
    ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`
    : raw;
  if (!Number.isFinite(Date.parse(normalized))) throw new Error("DECODEBRIDGE_INVALID_CAPTURED_AT");
  return normalized;
}

async function loadLiveDecodeBridgeEvidence(
  options: DecodeBridgeEvidenceOptions = {},
): Promise<DecodeBridgeEvidenceSnapshot> {
  const experimentRootUrl = options.experimentRootUrl ?? DEFAULT_EXPERIMENT_ROOT_URL;
  const campaignRelativePath = options.campaignRelativePath ?? DEFAULT_CAMPAIGN_RELATIVE_PATH;
  const campaignRootUrl = new URL(campaignRelativePath, experimentRootUrl);
  const aggregateResult = await readJson(
    new URL("aggregate.json", campaignRootUrl),
    MAX_AGGREGATE_BYTES,
    "AGGREGATE",
  );
  const aggregateFileSha256 = digest(aggregateResult.bytes);
  const sidecar = (await readRegularFile(
    new URL("aggregate.file-sha256.txt", campaignRootUrl),
    256,
    "AGGREGATE_SIDECAR",
  )).toString("utf8").trim();
  const sidecarMatch = /^([0-9a-f]{64})\s+aggregate\.json$/.exec(sidecar);
  if (!sidecarMatch || sidecarMatch[1] !== aggregateFileSha256) {
    throw new Error("DECODEBRIDGE_AGGREGATE_FILE_DIGEST_MISMATCH");
  }

  const aggregate = aggregateResult.value;
  if (aggregate.schema_version !== 1 || aggregate.decision !== "LOCAL_PROMOTION_CANDIDATE") {
    throw new Error("DECODEBRIDGE_INVALID_AGGREGATE_DECISION");
  }
  const payloadKey = Object.hasOwn(aggregate, "aggregate_payload_sha256")
    ? "aggregate_payload_sha256"
    : "aggregate_sha256";
  const aggregatePayloadSha256 = sha256(aggregate[payloadKey], "AGGREGATE_PAYLOAD_SHA256");
  const digestPayload = {...aggregate};
  delete digestPayload.aggregate_payload_sha256;
  delete digestPayload.aggregate_sha256;
  if (digest(canonicalJson(digestPayload)) !== aggregatePayloadSha256) {
    throw new Error("DECODEBRIDGE_AGGREGATE_PAYLOAD_DIGEST_MISMATCH");
  }

  const campaignCount = integer(aggregate.campaign_count, "CAMPAIGN_COUNT", 1);
  const assetCount = integer(aggregate.asset_count, "ASSET_COUNT", 1);
  const receiptCount = integer(aggregate.receipt_count, "RECEIPT_COUNT", 1);
  const geometricMeanSpeedup = number(
    aggregate.feature_stage_speedup_geomean,
    "GEOMETRIC_MEAN_SPEEDUP",
  );
  const weakestAssetMedianSpeedup = number(
    aggregate.weakest_asset_median_speedup,
    "WEAKEST_ASSET_SPEEDUP",
  );
  const thresholds = record(aggregate.thresholds, "THRESHOLDS");
  if (campaignCount < number(thresholds.minimum_campaigns, "MINIMUM_CAMPAIGNS", 1)
    || geometricMeanSpeedup < number(thresholds.minimum_geomean_speedup, "MINIMUM_GEOMEAN")
    || weakestAssetMedianSpeedup < number(thresholds.minimum_asset_median_speedup, "MINIMUM_ASSET")) {
    throw new Error("DECODEBRIDGE_INCONSISTENT_PROMOTION_DECISION");
  }
  requireTrue(aggregate.all_receipts_verified, "ALL_RECEIPTS_VERIFIED");

  const assetMediansRaw = record(aggregate.asset_median_speedups, "ASSET_MEDIANS");
  const assetMedianSpeedups = Object.entries(assetMediansRaw).map(([asset, value]) => ({
    asset: string(asset, "ASSET_MEDIAN_NAME", 256),
    speedup: number(value, "ASSET_MEDIAN_SPEEDUP"),
  })).sort((left, right) => left.asset.localeCompare(right.asset));
  if (assetMedianSpeedups.length !== assetCount) {
    throw new Error("DECODEBRIDGE_ASSET_COUNT_MISMATCH");
  }

  const records = array(aggregate.records, "RECORDS");
  if (records.length !== receiptCount || receiptCount !== campaignCount * assetCount) {
    throw new Error("DECODEBRIDGE_RECEIPT_COUNT_MISMATCH");
  }
  const receiptSha256: string[] = [];
  const validReceipts: ValidReceipt[] = [];
  const seenPaths = new Set<string>();
  const seenCampaigns = new Set<string>();
  const seenAssets = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const recordRaw = record(records[index], `RECORD_${index}`);
    if (recordRaw.verification_verdict !== "PASS"
      || array(recordRaw.failed_gates, `RECORD_${index}_FAILED_GATES`).length !== 0) {
      throw new Error("DECODEBRIDGE_RECORD_NOT_VERIFIED");
    }
    const receiptPath = string(recordRaw.receipt_path, `RECORD_${index}_PATH`, 512);
    seenCampaigns.add(string(recordRaw.campaign_id, `RECORD_${index}_CAMPAIGN`, 128));
    seenAssets.add(string(recordRaw.asset, `RECORD_${index}_ASSET`, 256));
    if (seenPaths.has(receiptPath)) throw new Error("DECODEBRIDGE_DUPLICATE_RECEIPT_PATH");
    seenPaths.add(receiptPath);
    const expectedReceiptSha256 = sha256(recordRaw.receipt_sha256, `RECORD_${index}_SHA256`);
    const receiptUrl = resolveBoundedArtifact(
      experimentRootUrl,
      campaignRelativePath,
      receiptPath,
    );
    const receiptResult = await readJson(receiptUrl, MAX_RECEIPT_BYTES, `RECEIPT_${index}`);
    // Receipt digests follow the independent Python verifier's canonical,
    // compact, key-sorted JSON contract. The aggregate file itself has a
    // separate raw-byte sidecar binding above.
    if (digest(canonicalJson(receiptResult.value)) !== expectedReceiptSha256) {
      throw new Error("DECODEBRIDGE_RECEIPT_DIGEST_MISMATCH");
    }
    const verificationUrl = new URL(
      path.basename(fileURLToPath(receiptUrl)).replace(/\.receipt\.json$/, ".verification.json"),
      receiptUrl,
    );
    const verification = (await readJson(
      verificationUrl,
      MAX_VERIFICATION_BYTES,
      `VERIFICATION_${index}`,
    )).value;
    if (verification.verdict !== "PASS"
      || verification.receipt_sha256 !== expectedReceiptSha256
      || array(verification.failed_gates, `VERIFICATION_${index}_FAILED_GATES`).length !== 0) {
      throw new Error("DECODEBRIDGE_VERIFICATION_BINDING_MISMATCH");
    }
    receiptSha256.push(expectedReceiptSha256);
    validReceipts.push(await validateReceipt(
      receiptResult.value,
      recordRaw,
      experimentRootUrl,
    ));
  }
  if (seenCampaigns.size !== campaignCount || seenAssets.size !== assetCount) {
    throw new Error("DECODEBRIDGE_CAMPAIGN_OR_ASSET_COUNT_MISMATCH");
  }

  const devices = new Set(validReceipts.map((receipt) => receipt.device));
  const featureContracts = new Set(validReceipts.map((receipt) => receipt.featureContract));
  const timelineDigests = new Set(validReceipts.map((receipt) => receipt.timelineSha256));
  const selectorPolicies = new Set(validReceipts.map((receipt) => receipt.selectorPolicy));
  const reductions = new Set(validReceipts.map((receipt) => receipt.tokenReductionPercent));
  const selectedFrameCounts = new Set(validReceipts.map((receipt) => receipt.selectedFrames));
  if (devices.size !== 1 || featureContracts.size !== 1 || timelineDigests.size !== 1 || selectorPolicies.size !== 1
    || reductions.size !== 1 || selectedFrameCounts.size !== 1
    || !validReceipts.some((receipt) => receipt.rowStridePaddingObserved)) {
    throw new Error("DECODEBRIDGE_CROSS_RECEIPT_INCONSISTENCY");
  }

  const redTeam = record(aggregate.red_team, "RED_TEAM");
  if (redTeam.kind !== "receipt-mutator-negative-controls") {
    throw new Error("DECODEBRIDGE_INVALID_RED_TEAM_KIND");
  }
  requireTrue(redTeam.passed, "RED_TEAM");
  const controls = array(redTeam.controls, "RED_TEAM_CONTROLS").map((entry, index) => {
    const control = record(entry, `CONTROL_${index}`);
    const expectedGate = string(control.expected_gate, `CONTROL_${index}_EXPECTED_GATE`, 256);
    const failedGates = stringArray(control.failed_gates, `CONTROL_${index}_FAILED_GATES`);
    if (control.verdict !== "REJECTED" || control.rejected_by_expected_gate !== true
      || !failedGates.includes(expectedGate)) {
      throw new Error("DECODEBRIDGE_RED_TEAM_CONTROL_NOT_REJECTED");
    }
    return {
      name: string(control.name, `CONTROL_${index}_NAME`, 256),
      expectedGate,
      failedGates,
      verdict: "REJECTED" as const,
    };
  });
  if (controls.length === 0) throw new Error("DECODEBRIDGE_MISSING_RED_TEAM_CONTROLS");

  const claimBoundary = string(aggregate.claim_boundary, "CLAIM_BOUNDARY");
  const redTeamLimitation = string(redTeam.claim_boundary, "RED_TEAM_LIMITATION");
  const featureContract = [...featureContracts][0]!;
  const selectorPolicy = [...selectorPolicies][0]!;
  const device = [...devices][0]!;
  const timelineSha256 = [...timelineDigests][0]!;
  const tokenReductionPercent = [...reductions][0]!;
  const selectedFrames = [...selectedFrameCounts][0]!;
  const inputDigests = new Map<string, string>();
  for (const receipt of validReceipts) {
    const existing = inputDigests.get(receipt.asset);
    if (existing && existing !== receipt.inputSha256) {
      throw new Error("DECODEBRIDGE_INPUT_IDENTITY_MISMATCH");
    }
    inputDigests.set(receipt.asset, receipt.inputSha256);
  }
  const inputSha256 = [...inputDigests].map(([asset, assetSha256]) => ({
    asset,
    sha256: assetSha256,
  })).sort((left, right) => left.asset.localeCompare(right.asset));
  const benchmarkContractSha256 = digest(await readRegularFile(
    new URL("BENCHMARK_CONTRACT.md", experimentRootUrl),
    128 * 1024,
    "BENCHMARK_CONTRACT",
  ));
  const policySha256 = digest(`${featureContract}|${selectorPolicy}`);
  const runtimeControlResult = await readJson(
    new URL("artifacts/runtime-negative-controls/latest.json", experimentRootUrl),
    128 * 1024,
    "RUNTIME_CONTROLS",
  );
  const runtimeControlsRaw = runtimeControlResult.value;
  if (runtimeControlsRaw.schema_version !== 1
    || runtimeControlsRaw.kind !== "runtime-negative-control-suite"
    || runtimeControlsRaw.verdict !== "PASS") {
    throw new Error("DECODEBRIDGE_INVALID_RUNTIME_CONTROLS");
  }
  const runtimeControlPayloadSha256 = sha256(
    runtimeControlsRaw.report_payload_sha256,
    "RUNTIME_CONTROL_PAYLOAD_SHA256",
  );
  const runtimeControlPayload = {...runtimeControlsRaw};
  delete runtimeControlPayload.report_payload_sha256;
  if (digest(canonicalJson(runtimeControlPayload)) !== runtimeControlPayloadSha256) {
    throw new Error("DECODEBRIDGE_RUNTIME_CONTROL_PAYLOAD_DIGEST_MISMATCH");
  }
  const runtimeControlExecutableSha256 = sha256(
    runtimeControlsRaw.binary_sha256,
    "RUNTIME_CONTROL_EXECUTABLE_SHA256",
  );
  const runtimeControlAssetSha256 = sha256(
    runtimeControlsRaw.asset_sha256,
    "RUNTIME_CONTROL_ASSET_SHA256",
  );
  const runtimeExecutableBytes = await readRegularFile(
    new URL(".build/arm64-apple-macosx/release/decodebridge", experimentRootUrl),
    256 * 1024 * 1024,
    "RUNTIME_CONTROL_EXECUTABLE",
  );
  if (digest(runtimeExecutableBytes) !== runtimeControlExecutableSha256) {
    throw new Error("DECODEBRIDGE_RUNTIME_EXECUTABLE_DIGEST_MISMATCH");
  }
  const runtimeAsset = inputSha256.find((asset) => asset.sha256 === runtimeControlAssetSha256);
  if (!runtimeAsset) throw new Error("DECODEBRIDGE_RUNTIME_CONTROL_ASSET_MISMATCH");
  const runtimeControls = array(runtimeControlsRaw.results, "RUNTIME_CONTROL_RESULTS")
    .map((entry, index) => {
      const control = record(entry, `RUNTIME_CONTROL_${index}`);
      const expectedGate = string(control.expected_gate, `RUNTIME_CONTROL_${index}_EXPECTED`, 256);
      const observedGate = string(control.observed_gate, `RUNTIME_CONTROL_${index}_OBSERVED`, 256);
      if (control.exit_code !== 2 || control.verdict !== "PASS" || observedGate !== expectedGate) {
        throw new Error("DECODEBRIDGE_RUNTIME_CONTROL_NOT_DENIED");
      }
      return {
        fault: string(control.fault, `RUNTIME_CONTROL_${index}_FAULT`, 256),
        expectedGate,
        observedGate,
        exitCode: 2 as const,
        verdict: "PASS" as const,
      };
    });
  const runtimeControlCount = integer(
    runtimeControlsRaw.control_count,
    "RUNTIME_CONTROL_COUNT",
    1,
  );
  if (runtimeControls.length !== runtimeControlCount
    || runtimeControlsRaw.passed_count !== runtimeControlCount) {
    throw new Error("DECODEBRIDGE_RUNTIME_CONTROL_COUNT_MISMATCH");
  }
  const runtimeControlArtifactSha256 = digest(runtimeControlResult.bytes);
  const capturedAt = normalizedCapturedAt(aggregate.captured_at_utc);
  const proofEnvelopeMissingBindings = [
    "historical run-bound lease",
    "KPI-campaign executable SHA-256 (runtime-control executable is bound separately)",
    "historical runtime shader SHA-256",
    "historical verifier executable SHA-256",
  ];
  const governedRun = await loadDecodeBridgeAgentServiceProof(options.agentServiceProofOptions);
  const causalReflex = buildDecodeBridgeCausalReflex({
    inputSha256: runtimeAsset.sha256,
    executableSha256: runtimeControlExecutableSha256,
    aggregateSha256: aggregateFileSha256,
    timelineSha256,
    featureContract,
    selectorPolicy,
    selectedFrames,
    tokenReductionPercent,
    governedEvidenceRootSha256: governedRun.evidenceRootSha256,
    faultEvidenceSha256: runtimeControlArtifactSha256,
    recoveryEvidenceSha256: governedRun.regressionReplayExecutionSha256,
    runtimeFaults: runtimeControls,
    regressionIds: governedRun.regressionIds,
  });

  return {
    schemaVersion: 1,
    actionId: "decodebridge-video-feature-route-v1",
    title: "Hardware-attested video feature route",
    decision: "LOCAL_PROMOTION_CANDIDATE",
    capturedAt,
    methodology: {
      name: "NerveLoop VERA",
      expansion: "Verified Evidence Reconciliation Architecture",
      tagline: "dynamic strategy, earned memory, fixed proof",
    },
    governedRun,
    causalReflex,
    actionStages: [
      {
        id: "proposed",
        label: "Proposed",
        status: "DEFINED",
        evidence: `${featureContract} feeding ${selectorPolicy}`,
        provenance: "artifact-contract",
      },
      {
        id: "allowed",
        label: "Allowed",
        status: "ALLOWED_LOCAL_SCOPE",
        evidence: "Adapter admits only digest-bound, owned local fixtures; no external authorization is inferred.",
        provenance: "adapter-policy",
      },
      {
        id: "leased",
        label: "Leased",
        status: "LEASE_CONSUMED_CLOSED",
        evidence: "A separate correctness-only AgentService Run consumed and closed one artifact-bound lease; the historical KPI campaign remains unleased.",
        provenance: "agentservice-proof",
      },
      {
        id: "executed",
        label: "Executed",
        status: "EXECUTED",
        evidence: `${receiptCount} historical campaign receipts plus one separately lease-bound correctness Run`,
        provenance: "sealed-receipts",
      },
      {
        id: "verified",
        label: "Verified",
        status: "VERIFIED",
        evidence: `${receiptCount}/${receiptCount} receipt, asset, verifier and semantic bindings passed`,
        provenance: "sealed-receipts",
      },
      {
        id: "retained",
        label: "Retained",
        status: "LOCAL_CANDIDATE_ONLY",
        evidence: "AgentService retained the correctness receipt; the historical performance KPI remains a workload-level local candidate.",
        provenance: "adapter-policy",
      },
    ],
    proofEnvelope: {
      schemaVersion: "nerveloop.proof-envelope.v1",
      envelopeId: `decodebridge-${aggregateFileSha256.slice(0, 24)}`,
      capturedAtUtc: capturedAt,
      task: {
        taskId: "decodebridge-video-feature-route-v1",
        workload: "DecodeBridge",
        route: `${featureContract}->${selectorPolicy}`,
        contractSha256: benchmarkContractSha256,
      },
      authority: {
        state: "NOT_APPLICABLE",
        leaseId: null,
        policySha256,
        scope: ["owned-local-fixtures", "read-only-evidence-projection", "no-external-action"],
        fresh: false,
      },
      artifacts: [
        ...inputSha256.map((input) => ({
          role: "INPUT" as const,
          name: input.asset,
          sha256: input.sha256,
        })),
        {
          role: "EXECUTABLE" as const,
          name: "runtime-negative-control executable",
          sha256: runtimeControlExecutableSha256,
        },
        {
          role: "POLICY" as const,
          name: "DecodeBridge benchmark contract v1",
          sha256: benchmarkContractSha256,
        },
        ...receiptSha256.map((receiptDigest, index) => ({
          role: "RECEIPT" as const,
          name: `campaign receipt ${index + 1}`,
          sha256: receiptDigest,
        })),
        {
          role: "AGGREGATE" as const,
          name: "three-campaign aggregate",
          sha256: aggregateFileSha256,
        },
        {
          role: "RAW_MEASUREMENTS" as const,
          name: "runtime negative controls",
          sha256: runtimeControlArtifactSha256,
        },
      ],
      execution: {
        state: "EXECUTED",
        actualBackendPath: false,
        traceId: timelineSha256,
        environment: {
          device,
          campaignCount,
          assetCount,
          receiptCount,
          runtimeFaultCount: runtimeControlCount,
          historicalExecutionPath: "standalone-local-binary-not-AgentService",
        },
        metrics: [
          {
            name: "feature-stage-speedup-geomean",
            value: geometricMeanSpeedup,
            unit: "ratio",
            scope: "patch-feature stage only; decode and runtime shader compilation excluded",
            baseline: "release-compiled scalar Double CPU correctness reference",
          },
          {
            name: "weakest-asset-median-speedup",
            value: weakestAssetMedianSpeedup,
            unit: "ratio",
            scope: "weakest median among four owned H.264 fixtures",
            baseline: "release-compiled scalar Double CPU correctness reference",
          },
          {
            name: "token-proxy-reduction",
            value: tokenReductionPercent,
            unit: "percent",
            scope: `${selectedFrames} feature-selected frames from each 360-frame owned fixture`,
            baseline: "all decoded frame-patch tokens",
          },
        ],
      },
      verification: {
        verdict: "PASS",
        verifierIdentity: "DecodeBridge independent Python receipt verifier sidecars",
        evidenceRootSha256: aggregateFileSha256,
        gates: [
          {id: "hardware.actual_use", status: "PASS", detail: `${receiptCount}/${receiptCount} receipts`},
          {id: "timeline.reference_exact_match", status: "PASS", detail: `${receiptCount}/${receiptCount} receipts`},
          {id: "feature.parity", status: "PASS", detail: "zero tolerance-gated mismatches"},
          {id: "selection.cpu_metal_identity", status: "PASS", detail: `${receiptCount}/${receiptCount} receipts`},
          {id: "runtime.negative_controls", status: "PASS", detail: `${runtimeControlCount}/${runtimeControlCount} named faults exited through the expected gate`},
          {id: "authority.historical_lease", status: "NOT_APPLICABLE", detail: "not present in retained campaign evidence"},
        ],
        regressionIds: [],
      },
      decision: {
        proofState: "OBSERVED",
        promotionEligible: false,
        reason: "Workload-level local candidate; historical campaigns are not bound to an Agent Launchpad lease.",
        previousVerifiedStatePreserved: true,
      },
      claimBoundary: [
        claimBoundary,
        "Feature-stage comparison against a scalar Double CPU correctness reference, not optimized CPU or end-to-end latency.",
        string(runtimeControlsRaw.claim_boundary, "RUNTIME_CONTROL_CLAIM_BOUNDARY"),
        redTeamLimitation,
      ],
    },
    proofEnvelopeMissingBindings,
    kpi: {
      label: "feature-stage-speedup",
      comparison: "direct-metal-vs-release-compiled-scalar-double-cpu-reference",
      geometricMeanSpeedup,
      weakestAssetMedianSpeedup,
      assetMedianSpeedups,
      exclusions: [
        "Video decode is timed separately and excluded from this speedup.",
        "Runtime shader compilation is reported separately and excluded.",
        "This is not compressed-bytes-to-decision or end-to-end latency.",
        "The CPU reference is a correctness oracle, not an optimized Accelerate/vImage baseline.",
      ],
    },
    execution: {
      campaignCount,
      assetCount,
      receiptCount,
      decodedFrameCount: validReceipts.reduce((sum, receipt) => sum + receipt.frames, 0),
      device,
      hardwareRequired: true,
      hardwareInUse: true,
      compressedSamplesVerified: true,
      pixelFormat: "420v",
      iosurfaceBacked: true,
      directMetalPlaneMappings: true,
      noApplicationFullFrameStaging: true,
    },
    timeline: {
      exactReceiptCount: receiptCount,
      callbackReorderingObserved: true,
      decodeOrderPtsInversionObserved: true,
      presentationTimelineSha256: timelineSha256,
      droppedFrames: 0,
      interruptedFrames: 0,
    },
    parity: {
      exactSelectionReceiptCount: receiptCount,
      numericalParityReceiptCount: receiptCount,
      mismatchCount: 0,
      maximumAbsoluteError: Math.max(...validReceipts.map((receipt) => receipt.maximumAbsoluteError)),
      comparedValueCount: validReceipts.reduce((sum, receipt) => sum + receipt.comparedValueCount, 0),
      selectorPolicy,
      tokenReductionPercent,
      selectedFrames,
    },
    redTeam: {
      kind: "receipt-mutator-negative-controls",
      rejectedControlCount: controls.length,
      controls,
      limitation: redTeamLimitation,
      runtime: {
        kind: "runtime-negative-control-suite",
        artifactSha256: runtimeControlArtifactSha256,
        executableSha256: runtimeControlExecutableSha256,
        assetSha256: runtimeControlAssetSha256,
        executedControlCount: runtimeControlCount,
        controls: runtimeControls,
        limitation: string(
          runtimeControlsRaw.claim_boundary,
          "RUNTIME_CONTROL_CLAIM_BOUNDARY",
        ),
      },
      recovery: {
        status: "PRIOR_DIGEST_VALID_EVIDENCE_UNCHANGED",
        evidence: `Fault candidates were denied; prior aggregate ${aggregateFileSha256.slice(0, 12)} remained digest-valid and unchanged. No rollback is claimed.`,
      },
    },
    artifacts: {
      aggregateFileSha256,
      aggregatePayloadSha256,
      inputSha256,
      runtimeControlArtifactSha256,
      runtimeControlExecutableSha256,
      receiptSha256,
    },
    proofBoundary: `${claimBoundary} The KPI is feature-stage only against a release-compiled scalar Double CPU reference; it is not an optimized CPU or end-to-end comparison.`,
  };
}

function requireExact(value: unknown, expected: unknown, label: string): void {
  if (value !== expected) throw new Error(`DECODEBRIDGE_SEALED_GATE_${label}`);
}

function validateSealedSnapshot(
  raw: JsonRecord,
  semanticContract: JsonRecord,
): DecodeBridgeEvidenceSnapshot {
  const expectedTopLevelKeys = [
    "actionId",
    "actionStages",
    "artifacts",
    "capturedAt",
    "causalReflex",
    "decision",
    "execution",
    "governedRun",
    "kpi",
    "methodology",
    "parity",
    "proofBoundary",
    "proofEnvelope",
    "proofEnvelopeMissingBindings",
    "redTeam",
    "schemaVersion",
    "timeline",
    "title",
  ];
  if (canonicalJson(Object.keys(raw).sort()) !== canonicalJson(expectedTopLevelKeys)) {
    throw new Error("DECODEBRIDGE_SEALED_GATE_TOP_LEVEL_SCHEMA");
  }
  requireExact(raw.schemaVersion, semanticContract.projectionSchemaVersion,
    "PROJECTION_SCHEMA");
  requireExact(raw.actionId, semanticContract.actionId, "ACTION_ID");
  requireExact(raw.decision, semanticContract.decision, "DECISION");
  requireExact(raw.capturedAt, semanticContract.capturedAt, "CAPTURED_AT");

  const methodology = record(raw.methodology, "SEALED_METHODOLOGY");
  requireExact(methodology.name, "NerveLoop VERA", "METHODOLOGY");
  const execution = record(raw.execution, "SEALED_EXECUTION");
  for (const field of ["campaignCount", "assetCount", "receiptCount", "decodedFrameCount",
    "device"] as const) {
    requireExact(execution[field], semanticContract[field], `EXECUTION_${field.toUpperCase()}`);
  }
  for (const field of ["hardwareRequired", "hardwareInUse", "compressedSamplesVerified",
    "iosurfaceBacked", "directMetalPlaneMappings", "noApplicationFullFrameStaging"] as const) {
    requireExact(execution[field], true, `EXECUTION_${field.toUpperCase()}`);
  }
  requireExact(execution.pixelFormat, "420v", "PIXEL_FORMAT");

  const timeline = record(raw.timeline, "SEALED_TIMELINE");
  requireExact(timeline.exactReceiptCount, semanticContract.receiptCount,
    "TIMELINE_RECEIPT_COUNT");
  requireExact(timeline.callbackReorderingObserved, true, "CALLBACK_REORDERING");
  requireExact(timeline.decodeOrderPtsInversionObserved, true, "PTS_INVERSION");
  requireExact(timeline.droppedFrames, 0, "DROPPED_FRAMES");
  requireExact(timeline.interruptedFrames, 0, "INTERRUPTED_FRAMES");
  sha256(timeline.presentationTimelineSha256, "SEALED_TIMELINE_SHA256");

  const parity = record(raw.parity, "SEALED_PARITY");
  requireExact(parity.exactSelectionReceiptCount, semanticContract.receiptCount,
    "SELECTION_RECEIPT_COUNT");
  requireExact(parity.numericalParityReceiptCount, semanticContract.receiptCount,
    "PARITY_RECEIPT_COUNT");
  requireExact(parity.mismatchCount, 0, "PARITY_MISMATCH_COUNT");
  requireExact(parity.comparedValueCount, semanticContract.comparedValueCount,
    "COMPARED_VALUE_COUNT");
  requireExact(parity.selectorPolicy, semanticContract.selectorPolicy, "SELECTOR_POLICY");
  requireExact(parity.selectedFrames, semanticContract.selectedFrames, "SELECTED_FRAMES");
  requireExact(parity.tokenReductionPercent, semanticContract.tokenReductionPercent,
    "TOKEN_REDUCTION");

  const governedRun = record(raw.governedRun, "SEALED_GOVERNED_RUN");
  requireExact(governedRun.status, "VERIFIED", "GOVERNED_STATUS");
  requireExact(governedRun.leaseState, "CLOSED", "GOVERNED_LEASE_STATE");
  requireExact(governedRun.leaseReused, false, "GOVERNED_LEASE_REUSE");
  requireExact(governedRun.actualBackendPath, true, "GOVERNED_BACKEND_PATH");
  requireExact(governedRun.providerDispatch, false, "GOVERNED_PROVIDER_DISPATCH");
  requireExact(governedRun.taskAcceptance, "passed", "GOVERNED_ACCEPTANCE");
  requireExact(governedRun.runGuard, "retained", "GOVERNED_RUN_GUARD");
  requireExact(governedRun.decodedFrameCount, semanticContract.governedDecodedFrameCount,
    "GOVERNED_DECODED_FRAMES");
  requireExact(governedRun.comparedValueCount, semanticContract.governedComparedValueCount,
    "GOVERNED_COMPARED_VALUES");
  requireExact(governedRun.featureParityMismatchCount, 0, "GOVERNED_PARITY");
  requireExact(governedRun.selectionExactMatch, true, "GOVERNED_SELECTION");
  requireExact(governedRun.promotionEligible, false, "GOVERNED_NO_PROMOTION");
  const regressionIds = array(governedRun.regressionIds, "SEALED_REGRESSION_IDS");
  if (regressionIds.length !== 1 || regressionIds[0] !== "decodebridge-pts-one-tick-v1") {
    throw new Error("DECODEBRIDGE_SEALED_GATE_REGRESSION_IDS");
  }

  const causalReflex = record(raw.causalReflex, "SEALED_CAUSAL_REFLEX");
  requireExact(causalReflex.name, "Causal Proof-Graph Reflex", "CAUSAL_NAME");
  const causalDecision = record(causalReflex.decision, "SEALED_CAUSAL_DECISION");
  requireExact(causalDecision.verdict, "SELECTIVE_RECOVERY_VERIFIED", "CAUSAL_VERDICT");
  requireExact(causalDecision.invalidatedNodeCount, 3, "CAUSAL_INVALIDATED");
  requireExact(causalDecision.reusedNodeCount, 3, "CAUSAL_REUSED");
  requireExact(causalDecision.replayedNodeCount, 3, "CAUSAL_REPLAYED");
  requireExact(causalDecision.fullReplayNodeCount, 6, "CAUSAL_FULL_REPLAY");
  requireExact(causalDecision.logicalReplayAvoidedPercent, 50, "CAUSAL_REPLAY_AVOIDED");
  requireExact(causalDecision.stalePromotionEscapes, 0, "CAUSAL_STALE_PROMOTION");
  if (array(causalReflex.nodes, "SEALED_CAUSAL_NODES").length !== 6) {
    throw new Error("DECODEBRIDGE_SEALED_GATE_CAUSAL_NODE_COUNT");
  }

  const proofEnvelope = record(raw.proofEnvelope, "SEALED_PROOF_ENVELOPE");
  requireExact(proofEnvelope.schemaVersion, "nerveloop.proof-envelope.v1", "ENVELOPE_SCHEMA");
  const envelopeVerification = record(proofEnvelope.verification,
    "SEALED_ENVELOPE_VERIFICATION");
  requireExact(envelopeVerification.verdict, "PASS", "ENVELOPE_VERDICT");
  const envelopeDecision = record(proofEnvelope.decision, "SEALED_ENVELOPE_DECISION");
  requireExact(envelopeDecision.proofState, "OBSERVED", "ENVELOPE_PROOF_STATE");
  requireExact(envelopeDecision.promotionEligible, false, "ENVELOPE_NO_PROMOTION");

  const redTeam = record(raw.redTeam, "SEALED_RED_TEAM");
  requireExact(redTeam.rejectedControlCount, semanticContract.rejectedControlCount,
    "RED_TEAM_COUNT");
  const runtime = record(redTeam.runtime, "SEALED_RUNTIME_CONTROLS");
  requireExact(runtime.executedControlCount, semanticContract.runtimeControlCount,
    "RUNTIME_CONTROL_COUNT");
  if (!array(runtime.controls, "SEALED_RUNTIME_CONTROL_RESULTS").every((entry, index) => {
    const control = record(entry, `SEALED_RUNTIME_CONTROL_${index}`);
    return control.verdict === "PASS" && control.exitCode === 2
      && control.expectedGate === control.observedGate;
  })) {
    throw new Error("DECODEBRIDGE_SEALED_GATE_RUNTIME_CONTROLS");
  }

  const artifacts = record(raw.artifacts, "SEALED_ARTIFACTS");
  if (array(artifacts.inputSha256, "SEALED_INPUT_DIGESTS").length !== 4
    || array(artifacts.receiptSha256, "SEALED_RECEIPT_DIGESTS").length !== 12) {
    throw new Error("DECODEBRIDGE_SEALED_GATE_ARTIFACT_COUNTS");
  }
  for (const field of ["aggregateFileSha256", "aggregatePayloadSha256",
    "runtimeControlArtifactSha256", "runtimeControlExecutableSha256"] as const) {
    sha256(artifacts[field], `SEALED_${field.toUpperCase()}`);
  }
  const serialized = JSON.stringify(raw);
  if (serialized.includes("/Users/") || serialized.includes("/tmp/")
    || serialized.includes("receipt_path") || serialized.includes("workspacePath")) {
    throw new Error("DECODEBRIDGE_SEALED_GATE_PATH_LEAK");
  }
  const boundary = string(raw.proofBoundary, "SEALED_PROOF_BOUNDARY", 4096);
  if (!boundary.includes("not TikTok access") || !boundary.includes("not an optimized CPU")
    || !boundary.includes("not an optimized CPU or end-to-end comparison")) {
    throw new Error("DECODEBRIDGE_SEALED_GATE_PROOF_BOUNDARY");
  }
  return structuredClone(raw) as unknown as DecodeBridgeEvidenceSnapshot;
}

async function loadSealedDecodeBridgeEvidence(
  options: DecodeBridgeEvidenceOptions,
): Promise<{projection: DecodeBridgeEvidenceSnapshot; snapshotSha256: string}> {
  const snapshotUrl = options.sealedSnapshotUrl ?? DEFAULT_SEALED_SNAPSHOT_URL;
  const manifestUrl = options.sealedManifestUrl ?? DEFAULT_SEALED_MANIFEST_URL;
  const manifestResult = await readJson(manifestUrl, 16 * 1024, "SEALED_MANIFEST");
  if (digest(manifestResult.bytes) !== SEALED_MANIFEST_SHA256) {
    throw new Error("DECODEBRIDGE_SEALED_MANIFEST_DIGEST_MISMATCH");
  }
  const manifest = manifestResult.value;
  requireExact(manifest.schemaVersion, "decodebridge.sealed-evidence-manifest.v1",
    "MANIFEST_SCHEMA");
  requireExact(manifest.algorithm, "sha256", "MANIFEST_ALGORITHM");
  requireExact(manifest.mediaType, "application/json", "MANIFEST_MEDIA_TYPE");
  requireExact(manifest.artifact, path.basename(fileURLToPath(snapshotUrl)),
    "MANIFEST_ARTIFACT");
  const expectedSnapshotSha256 = sha256(manifest.sha256, "SEALED_SNAPSHOT_SHA256");
  const expectedByteLength = integer(manifest.byteLength, "SEALED_BYTE_LENGTH", 1);
  const semanticContract = record(manifest.semanticContract, "SEALED_SEMANTIC_CONTRACT");

  const snapshotResult = await readJson(snapshotUrl, 512 * 1024, "SEALED_SNAPSHOT");
  if (snapshotResult.bytes.length !== expectedByteLength) {
    throw new Error("DECODEBRIDGE_SEALED_SNAPSHOT_LENGTH_MISMATCH");
  }
  if (digest(snapshotResult.bytes) !== expectedSnapshotSha256) {
    throw new Error("DECODEBRIDGE_SEALED_SNAPSHOT_DIGEST_MISMATCH");
  }
  return {
    projection: validateSealedSnapshot(snapshotResult.value, semanticContract),
    snapshotSha256: expectedSnapshotSha256,
  };
}

function missingFilesystemEntry(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function defaultLiveSourceIsAvailable(): Promise<boolean> {
  try {
    const aggregateUrl = new URL(
      `${DEFAULT_CAMPAIGN_RELATIVE_PATH}aggregate.json`,
      DEFAULT_EXPERIMENT_ROOT_URL,
    );
    const stat = await lstat(fileURLToPath(aggregateUrl));
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (missingFilesystemEntry(error)) return false;
    throw error;
  }
}

function withLiveSource(
  projection: DecodeBridgeEvidenceSnapshot,
): DecodeBridgeEvidenceProjection {
  return {
    ...projection,
    evidenceSource: {
      mode: "LIVE_SIBLING_M5_ARTIFACTS",
      label: "Live sibling M5 evidence bindings revalidated at request time; the workload was not rerun.",
      validation: "LIVE_ARTIFACT_BINDINGS_REVALIDATED",
      currentHardwareRun: false,
      snapshotSha256: null,
    },
  };
}

function withSealedSource(
  projection: DecodeBridgeEvidenceSnapshot,
  snapshotSha256: string,
): DecodeBridgeEvidenceProjection {
  return {
    ...projection,
    proofBoundary: `${projection.proofBoundary} Delivery fallback: sealed repository-local `
      + "snapshot only; no current hardware execution or live source-tree validation is implied.",
    evidenceSource: {
      mode: "SEALED_LOCAL_SNAPSHOT",
      label: "Sealed repository-local DecodeBridge evidence; no current hardware execution is implied.",
      validation: "SEALED_BYTES_HASH_SCHEMA_SEMANTICS_VALIDATED",
      currentHardwareRun: false,
      snapshotSha256,
    },
  };
}

export async function loadDecodeBridgeEvidence(
  options: DecodeBridgeEvidenceOptions = {},
): Promise<DecodeBridgeEvidenceProjection> {
  const sourceMode = options.sourceMode ?? "auto";
  if (sourceMode === "sealed-only") {
    const sealed = await loadSealedDecodeBridgeEvidence(options);
    return withSealedSource(sealed.projection, sealed.snapshotSha256);
  }

  const customizedLiveSource = options.experimentRootUrl !== undefined
    || options.campaignRelativePath !== undefined
    || options.agentServiceProofOptions !== undefined;
  if (sourceMode === "auto" && !customizedLiveSource
    && !(await defaultLiveSourceIsAvailable())) {
    const sealed = await loadSealedDecodeBridgeEvidence(options);
    return withSealedSource(sealed.projection, sealed.snapshotSha256);
  }

  // Any present or explicitly selected live source is authoritative. Validation
  // failure must surface rather than silently degrading to a historical snapshot.
  return withLiveSource(await loadLiveDecodeBridgeEvidence(options));
}

export type DecodeBridgeEvidenceLoader = () => Promise<DecodeBridgeEvidenceProjection>;
