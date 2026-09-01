import {createHash} from "node:crypto";
import {lstat, readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {decodeBridgeCanonicalSha256, decodeBridgeWorkCellContract} from "./decodebridge-work-cell.js";

const DEFAULT_PROOF_URL = new URL(
  "../../../research/evidence/decodebridge-agentservice/current.json",
  import.meta.url,
);
const DEFAULT_EXPERIMENT_ROOT_URL = new URL(
  "../../../../experiments/decodebridge-video-ingest/",
  import.meta.url,
);
const DEFAULT_LAUNCHPAD_ROOT_URL = new URL("../../../", import.meta.url);
const SOURCE_IDENTITY_PATHS = [
  "Package.swift",
  "Sources/DecodeBridge/main.swift",
  "Sources/DecodeBridge/FeaturePipeline.swift",
  "Sources/DecodeBridge/TemporalFacilitySelector.swift",
  "Sources/DecodeBridge/Shaders/PatchFeatures.metal",
  "BENCHMARK_CONTRACT.md",
  "verify_receipt.py",
] as const;
const HOST_POLICY_PATHS = [
  "apps/server/src/decodebridge-work-cell.ts",
  "apps/server/src/agent-service.ts",
  "apps/server/src/types.ts",
] as const;

type JsonRecord = Record<string, unknown>;

export interface DecodeBridgeGovernedRunProjection {
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
  proofEnvelope: JsonRecord;
  boundary: string;
}

export interface DecodeBridgeAgentServiceProofOptions {
  proofUrl?: URL;
  experimentRootUrl?: URL;
  launchpadRootUrl?: URL;
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`DECODEBRIDGE_AGENT_RUN_INVALID_${label}`);
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`DECODEBRIDGE_AGENT_RUN_INVALID_${label}`);
  return value;
}

function string(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`DECODEBRIDGE_AGENT_RUN_INVALID_${label}`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  const parsed = string(value, label, 64);
  if (!/^[a-f0-9]{64}$/.test(parsed)) throw new Error(`DECODEBRIDGE_AGENT_RUN_INVALID_${label}`);
  return parsed;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`DECODEBRIDGE_AGENT_RUN_INVALID_${label}`);
  }
  return value as number;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function regularBytes(url: URL, maximum: number, label: string): Promise<Buffer> {
  const filePath = fileURLToPath(url);
  const entry = await lstat(filePath);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 ||
      entry.size <= 0 || entry.size > maximum) {
    throw new Error(`DECODEBRIDGE_AGENT_RUN_INVALID_${label}_FILE`);
  }
  return await readFile(filePath);
}

async function fileDigest(url: URL, maximum = 64 * 1024 * 1024): Promise<string> {
  return digest(await regularBytes(url, maximum, "BOUND_ARTIFACT"));
}

async function treeDigest(root: URL): Promise<string> {
  const entries = await Promise.all(SOURCE_IDENTITY_PATHS.map(async relative =>
    [relative, await fileDigest(new URL(relative, root))] as const));
  return digest(entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, sha]) => `${name}:${sha}`).join("\n"));
}

async function hostPolicyDigest(root: URL): Promise<string> {
  const entries = await Promise.all(HOST_POLICY_PATHS.map(async relative =>
    [path.basename(relative), await fileDigest(new URL(relative, root))] as const));
  return digest(entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, sha]) => `${name}:${sha}`).join("\n"));
}

function requireEqual(left: unknown, right: unknown, label: string): void {
  if (left !== right) throw new Error(`DECODEBRIDGE_AGENT_RUN_GATE_${label}`);
}

function artifactByName(envelope: JsonRecord, name: string): JsonRecord {
  const artifacts = array(envelope.artifacts, "ENVELOPE_ARTIFACTS").map((item, index) =>
    record(item, `ENVELOPE_ARTIFACT_${index}`));
  const matches = artifacts.filter(artifact => artifact.name === name);
  if (matches.length !== 1) throw new Error("DECODEBRIDGE_AGENT_RUN_GATE_ENVELOPE_ARTIFACT");
  return matches[0]!;
}

export async function loadDecodeBridgeAgentServiceProof(
  options: DecodeBridgeAgentServiceProofOptions = {},
): Promise<DecodeBridgeGovernedRunProjection> {
  const proofUrl = options.proofUrl ?? DEFAULT_PROOF_URL;
  const experimentRootUrl = options.experimentRootUrl ?? DEFAULT_EXPERIMENT_ROOT_URL;
  const launchpadRootUrl = options.launchpadRootUrl ?? DEFAULT_LAUNCHPAD_ROOT_URL;
  const bytes = await regularBytes(proofUrl, 512 * 1024, "PROOF");
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch {
    throw new Error("DECODEBRIDGE_AGENT_RUN_INVALID_PROOF_JSON");
  }
  const raw = record(parsed, "PROOF");
  requireEqual(raw.schemaVersion, "decodebridge-agentservice-run-proof.v1", "SCHEMA");
  requireEqual(raw.kind, "lease-bound-local-work-cell-proof", "KIND");
  const artifactPayloadSha256 = sha256(raw.artifactPayloadSha256, "PAYLOAD_SHA");
  const {artifactPayloadSha256: _omitted, ...payload} = raw;
  requireEqual(decodeBridgeCanonicalSha256(payload), artifactPayloadSha256, "PAYLOAD_SHA");
  const serialized = JSON.stringify(raw);
  if (serialized.includes("/Users/") || serialized.includes("/tmp/") ||
      serialized.includes("receipt_path") || serialized.includes("workspacePath")) {
    throw new Error("DECODEBRIDGE_AGENT_RUN_GATE_PATH_LEAK");
  }

  const run = record(raw.run, "RUN");
  const runId = string(run.runId, "RUN_ID", 80);
  const agentId = string(run.agentId, "AGENT_ID", 80);
  requireEqual(run.status, "completed", "RUN_COMPLETED");
  requireEqual(run.providerDispatch, false, "NO_PROVIDER_DISPATCH");
  const acceptance = record(run.acceptance, "ACCEPTANCE");
  requireEqual(acceptance.verifierId, "decodebridge-independent-verifier-v1", "VERIFIER_ID");
  requireEqual(acceptance.status, "passed", "ACCEPTANCE_PASS");
  requireEqual(acceptance.reason, "task_verified", "ACCEPTANCE_REASON");
  const guard = record(run.guard, "RUN_GUARD");
  requireEqual(guard.verdict, "retained", "RUN_GUARD_RETAINED");
  requireEqual(guard.recovery, "not_needed", "RUN_GUARD_RECOVERY");
  const changedFiles = array(guard.changedFiles, "CHANGED_FILES");
  if (changedFiles.length !== 1 || changedFiles[0] !== decodeBridgeWorkCellContract.receiptName) {
    throw new Error("DECODEBRIDGE_AGENT_RUN_GATE_CHANGED_FILES");
  }
  const eventKinds = array(guard.events, "RUN_GUARD_EVENTS")
    .map((event, index) => record(event, `RUN_GUARD_EVENT_${index}`).kind);
  if (eventKinds[0] !== "grant_issued" ||
      eventKinds.filter(kind => kind === "verification_retained").length < 2) {
    throw new Error("DECODEBRIDGE_AGENT_RUN_GATE_RUN_GUARD_EVENTS");
  }

  const authority = record(raw.authority, "AUTHORITY");
  requireEqual(authority.state, "CLOSED", "AUTHORITY_CLOSED");
  requireEqual(authority.closeReason, "VERIFIED", "AUTHORITY_VERIFIED");
  requireEqual(authority.failureCode, null, "AUTHORITY_FAILURE");
  requireEqual(raw.secondExecutionDenied, true, "LEASE_REUSE_DENIED");
  const lease = record(authority.lease, "LEASE");
  const leaseId = string(lease.leaseId, "LEASE_ID", 80);
  requireEqual(lease.runId, runId, "LEASE_RUN_BINDING");
  requireEqual(lease.agentId, agentId, "LEASE_AGENT_BINDING");
  requireEqual(lease.maxExecutions, 1, "LEASE_EXECUTION_LIMIT");
  requireEqual(lease.workload, decodeBridgeWorkCellContract.workload, "LEASE_WORKLOAD");
  requireEqual(lease.route, decodeBridgeWorkCellContract.route, "LEASE_ROUTE");
  requireEqual(lease.receiptName, decodeBridgeWorkCellContract.receiptName, "LEASE_RECEIPT_NAME");
  const leaseSha256 = sha256(lease.leaseSha256, "LEASE_SHA");
  const {leaseSha256: _leaseOmitted, ...leasePayload} = lease;
  requireEqual(decodeBridgeCanonicalSha256(leasePayload), leaseSha256, "LEASE_SHA");
  const bindings = record(lease.bindings, "LEASE_BINDINGS");

  const regressionBytes = await regularBytes(
    new URL("artifacts/regressions/decodebridge-pts-one-tick-v1.json", experimentRootUrl),
    512 * 1024,
    "REGRESSION",
  );
  const regression = record(JSON.parse(regressionBytes.toString("utf8")), "REGRESSION");
  requireEqual(regression.regression_id, "decodebridge-pts-one-tick-v1", "REGRESSION_ID");
  requireEqual(regression.status, "RETAINED_AFTER_REPRODUCTION_AND_REPLAY", "REGRESSION_STATUS");
  const regressionPayloadSha256 = sha256(regression.artifact_payload_sha256, "REGRESSION_PAYLOAD_SHA");
  const {artifact_payload_sha256: _regressionOmitted, ...regressionPayload} = regression;
  requireEqual(decodeBridgeCanonicalSha256(regressionPayload), regressionPayloadSha256,
    "REGRESSION_PAYLOAD_SHA");
  requireEqual(
    regression.regression_builder_sha256,
    await fileDigest(new URL("build_runtime_regression.py", experimentRootUrl)),
    "REGRESSION_BUILDER_CURRENT",
  );
  requireEqual(
    regression.regression_verifier_sha256,
    await fileDigest(new URL("verify_runtime_regression.py", experimentRootUrl)),
    "REGRESSION_VERIFIER_CURRENT",
  );

  const current = {
    executableSha256: await fileDigest(new URL(".build/release/decodebridge", experimentRootUrl)),
    sourceTreeSha256: await treeDigest(experimentRootUrl),
    inputSha256: await fileDigest(new URL("artifacts/owned-h264-bframes-322x182-stride.mp4", experimentRootUrl),
      1024 * 1024 * 1024),
    manifestSha256: await fileDigest(new URL("artifacts/asset-manifest-v1.json", experimentRootUrl)),
    shaderSha256: await fileDigest(new URL("Sources/DecodeBridge/Shaders/PatchFeatures.metal", experimentRootUrl)),
    verifierSha256: await fileDigest(new URL("verify_receipt.py", experimentRootUrl)),
    hostPolicySha256: await hostPolicyDigest(launchpadRootUrl),
    regressionArtifactSha256: digest(regressionBytes),
    regressionPayloadSha256,
    regressionVerifierSha256: await fileDigest(
      new URL("verify_runtime_regression.py", experimentRootUrl),
    ),
    contractSha256: decodeBridgeWorkCellContract.contractSha256,
  };
  for (const [key, expected] of Object.entries(current)) {
    requireEqual(bindings[key], expected, `CURRENT_${key.toUpperCase()}`);
  }

  const execution = record(authority.execution, "EXECUTION");
  requireEqual(execution.exitCode, 0, "EXECUTION_EXIT");
  requireEqual(execution.receiptName, decodeBridgeWorkCellContract.receiptName, "EXECUTION_RECEIPT");
  const verification = record(authority.verification, "VERIFICATION");
  requireEqual(verification.verdict, "PASS", "VERIFICATION_PASS");
  requireEqual(verification.failedGates && array(verification.failedGates, "FAILED_GATES").length,
    0, "VERIFICATION_FAILED_GATES");
  const receiptSha256 = sha256(verification.receiptSha256, "RECEIPT_SHA");
  const regressionIds = array(verification.regressionIds, "REGRESSION_IDS");
  if (regressionIds.length !== 1 || regressionIds[0] !== "decodebridge-pts-one-tick-v1") {
    throw new Error("DECODEBRIDGE_AGENT_RUN_GATE_REGRESSION_IDS");
  }
  const regressionReplayExecutionSha256 = sha256(
    verification.regressionReplayExecutionSha256,
    "REGRESSION_REPLAY_EXECUTION_SHA",
  );
  requireEqual(execution.receiptCanonicalSha256, receiptSha256, "EXECUTION_VERIFICATION_RECEIPT");

  const receipt = record(raw.receipt, "RECEIPT");
  requireEqual(decodeBridgeCanonicalSha256(receipt), receiptSha256, "RECEIPT_SHA");
  requireEqual(receipt.schemaVersion, 2, "RECEIPT_SCHEMA");
  requireEqual(receipt.inputPath, "owned-h264-bframes-322x182-stride.mp4", "RECEIPT_INPUT");
  requireEqual(receipt.inputSHA256, current.inputSha256, "RECEIPT_INPUT_SHA");
  const identity = record(receipt.implementationIdentity, "RECEIPT_IDENTITY");
  requireEqual(identity.executableSHA256, current.executableSha256, "RECEIPT_EXECUTABLE");
  requireEqual(identity.sourceTreeSHA256, current.sourceTreeSha256, "RECEIPT_SOURCE_TREE");
  requireEqual(identity.runtimeShaderSHA256, current.shaderSha256, "RECEIPT_SHADER");
  requireEqual(identity.verifierSHA256, current.verifierSha256, "RECEIPT_VERIFIER");
  requireEqual(receipt.hardwareRequired, true, "HARDWARE_REQUIRED");
  requireEqual(receipt.hardwareInUse, true, "HARDWARE_IN_USE");
  requireEqual(receipt.compressedSamplesVerified, true, "COMPRESSED_SAMPLES");
  requireEqual(receipt.presentationTimelineExactMatch, true, "TIMELINE_EXACT");
  requireEqual(receipt.callbackOrderDiffersFromPresentationOrder, true, "CALLBACK_REORDER");
  requireEqual(receipt.decodeOrderContainsPTSInversion, true, "PTS_INVERSION");
  requireEqual(receipt.metalCompatiblePlaneMappings, true, "METAL_MAPPING");
  requireEqual(receipt.featureParityPassed, true, "FEATURE_PARITY");
  requireEqual(receipt.selectionExactMatch, true, "SELECTION_EXACT");
  requireEqual(receipt.droppedFrameCount, 0, "DROPPED_FRAMES");
  requireEqual(receipt.interruptedFrameCount, 0, "INTERRUPTED_FRAMES");
  const decodedFrameCount = integer(receipt.decodedFrameCount, "DECODED_FRAMES", 1);
  requireEqual(receipt.sampleCount, decodedFrameCount, "FRAME_ACCOUNTING");
  requireEqual(receipt.iosurfaceBackedFrameCount, decodedFrameCount, "IOSURFACE_ACCOUNTING");
  const pixelFormats = array(receipt.pixelFormats, "PIXEL_FORMATS");
  if (pixelFormats.length !== 1 || pixelFormats[0] !== "420v") {
    throw new Error("DECODEBRIDGE_AGENT_RUN_GATE_PIXEL_FORMAT");
  }
  const parity = record(receipt.featureParity, "FEATURE_PARITY");
  requireEqual(parity.mismatchCount, 0, "PARITY_MISMATCH");
  const comparedValueCount = integer(parity.comparedValueCount, "COMPARED_VALUES", 1);
  const benchmark = record(receipt.featureBenchmark, "FEATURE_BENCHMARK");
  requireEqual(benchmark.mode, "single-probe", "SINGLE_PROBE");
  requireEqual(benchmark.promotionEligible, false, "NO_SELF_PROMOTION");

  const envelope = record(raw.proofEnvelope, "PROOF_ENVELOPE");
  requireEqual(envelope.schemaVersion, "nerveloop.proof-envelope.v1", "ENVELOPE_SCHEMA");
  const task = record(envelope.task, "ENVELOPE_TASK");
  requireEqual(task.taskId, runId, "ENVELOPE_RUN_BINDING");
  requireEqual(task.contractSha256, decodeBridgeWorkCellContract.contractSha256,
    "ENVELOPE_CONTRACT");
  const envelopeAuthority = record(envelope.authority, "ENVELOPE_AUTHORITY");
  requireEqual(envelopeAuthority.state, "REVOKED", "ENVELOPE_AUTHORITY_CLOSED");
  requireEqual(envelopeAuthority.leaseId, leaseId, "ENVELOPE_LEASE_BINDING");
  requireEqual(envelopeAuthority.fresh, true, "ENVELOPE_FRESH_LEASE");
  const envelopeExecution = record(envelope.execution, "ENVELOPE_EXECUTION");
  requireEqual(envelopeExecution.state, "EXECUTED", "ENVELOPE_EXECUTED");
  requireEqual(envelopeExecution.actualBackendPath, true, "ENVELOPE_BACKEND_PATH");
  requireEqual(envelopeExecution.traceId, runId, "ENVELOPE_TRACE");
  const envelopeVerification = record(envelope.verification, "ENVELOPE_VERIFICATION");
  requireEqual(envelopeVerification.verdict, "PASS", "ENVELOPE_VERIFIED");
  const evidenceRootSha256 = sha256(envelopeVerification.evidenceRootSha256, "EVIDENCE_ROOT");
  const envelopeDecision = record(envelope.decision, "ENVELOPE_DECISION");
  requireEqual(envelopeDecision.proofState, "VERIFIED", "ENVELOPE_PROOF_STATE");
  requireEqual(envelopeDecision.promotionEligible, false, "ENVELOPE_NO_PROMOTION");
  requireEqual(artifactByName(envelope, decodeBridgeWorkCellContract.receiptName).sha256,
    receiptSha256, "ENVELOPE_RECEIPT_ARTIFACT");
  requireEqual(artifactByName(envelope, "nerveloop-decodebridge-host-policy").sha256,
    current.hostPolicySha256, "ENVELOPE_HOST_POLICY");
  requireEqual(artifactByName(envelope, "decodebridge-pts-one-tick-v1").sha256,
    current.regressionArtifactSha256, "ENVELOPE_REGRESSION_ARTIFACT");
  const envelopeRegressionIds = array(envelopeVerification.regressionIds,
    "ENVELOPE_REGRESSION_IDS");
  if (envelopeRegressionIds.length !== 1 || envelopeRegressionIds[0] !== "decodebridge-pts-one-tick-v1") {
    throw new Error("DECODEBRIDGE_AGENT_RUN_GATE_ENVELOPE_REGRESSION_IDS");
  }

  return {
    status: "VERIFIED",
    capturedAtUtc: string(raw.capturedAtUtc, "CAPTURED_AT", 64),
    runId,
    leaseId,
    leaseState: "CLOSED",
    leaseReused: false,
    actualBackendPath: true,
    providerDispatch: false,
    taskAcceptance: "passed",
    runGuard: "retained",
    changedFiles: [decodeBridgeWorkCellContract.receiptName],
    decodedFrameCount,
    comparedValueCount,
    hardwareInUse: true,
    exactTimeline: true,
    featureParityMismatchCount: 0,
    selectionExactMatch: true,
    benchmarkMode: "single-probe",
    promotionEligible: false,
    regressionIds: ["decodebridge-pts-one-tick-v1"],
    regressionReplayExecutionSha256,
    receiptSha256,
    evidenceRootSha256,
    artifactPayloadSha256,
    proofEnvelope: structuredClone(envelope),
    boundary: "One local correctness-only AgentService Run on one owned fixture; historical KPI campaigns remain separate standalone evidence.",
  };
}
