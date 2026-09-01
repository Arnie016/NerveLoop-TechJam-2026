import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { computeReceiptPayloadSha256, validateTrackCReceipt } from "./run-track-c-kill-switch-demo.mjs";

const execFileAsync = promisify(execFile);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const launchpadRoot = path.resolve(scriptRoot, "..");
const scriptPath = path.join(scriptRoot, "run-track-c-kill-switch-demo.mjs");
const stableFallbackPath = path.join(launchpadRoot, "docs/demo/nerveloop-submission-draft.mp4");
let temporaryRoot;
let receiptPath;
let receipt;
let stableBefore;
let stableAfter;
let runStdout;

async function fileSha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

before(async () => {
  temporaryRoot = await mkdtemp(path.join(tmpdir(), "nerveloop-track-c-test-"));
  receiptPath = path.join(temporaryRoot, "receipt.json");
  stableBefore = await fileSha256(stableFallbackPath);
  const completed = await execFileAsync(process.execPath, [scriptPath, "--output", receiptPath], {
    cwd: launchpadRoot,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  runStdout = JSON.parse(completed.stdout);
  receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  stableAfter = await fileSha256(stableFallbackPath);
});

after(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

test("runs one same-Agent normal, pre-dispatch denial, rollback, and later-safe sequence", () => {
  assert.equal(runStdout.verdict, "PASS");
  assert.deepEqual(runStdout.runs, {
    normal: "completed",
    effectFirewallDenied: "failed",
    postRunRollback: "failed",
    laterSafe: "completed",
  });
  assert.equal(receipt.schemaVersion, "nerveloop.track-c-functional-flow.v3");
  assert.equal(receipt.track, "Track #1: Agent Launchpad: Design and Build Lightweight Agent Middleware");
  assert.deepEqual(receipt.implementation.enforcementPhases, [
    "pre-dispatch typed effect denial",
    "cooperative exact sink redemption",
    "post-run verification and rollback",
  ]);
  assert.equal(receipt.implementation.sameAgentSequence, true);
  assert.equal(receipt.sequence.normalRun.guardVerdict, "retained");
  assert.equal(receipt.sequence.laterFreshSafeRun.guardVerdict, "retained");
  assert.deepEqual([
    receipt.sequence.normalRun.effectCapability.state,
    receipt.sequence.postRunMaliciousRun.effectCapability.state,
    receipt.sequence.laterFreshSafeRun.effectCapability.state,
  ], ["consumed", "consumed", "consumed"]);
  assert.deepEqual([
    receipt.sequence.normalRun.effectSinkReceipt.state,
    receipt.sequence.postRunMaliciousRun.effectSinkReceipt.state,
    receipt.sequence.laterFreshSafeRun.effectSinkReceipt.state,
  ], ["committed", "revoked", "committed"]);
  assert.equal(receipt.sequence.effectFirewallDeniedRun.effectCapability, null);
  assert.equal(receipt.sequence.effectFirewallDeniedRun.effectSinkReceipt, null);
  assert.equal(new Set([
    receipt.sequence.normalRun.effectCapability.grantId,
    receipt.sequence.postRunMaliciousRun.effectCapability.grantId,
    receipt.sequence.laterFreshSafeRun.effectCapability.grantId,
  ]).size, 3);
  assert.equal(new Set([
    receipt.sequence.normalRun.runId,
    receipt.sequence.effectFirewallDeniedRun.runId,
    receipt.sequence.postRunMaliciousRun.runId,
    receipt.sequence.laterFreshSafeRun.runId,
  ]).size, 4);
  assert.equal(validateTrackCReceipt(receipt), receipt);
});

test("proves the typed Effect Firewall denial occurred before the fixture worker", () => {
  const denied = receipt.sequence.effectFirewallDeniedRun;
  assert.equal(denied.guardVerdict, "denied");
  assert.equal(denied.recovery, "not_needed");
  assert.equal(denied.outputPublished, false);
  assert.equal(denied.workerDispatchDelta, 0);
  assert.deepEqual(denied.changedFiles, []);
  assert.equal(denied.beforeManifestDigest, denied.afterManifestDigest);
  assert.deepEqual(denied.effectDecision, {
    version: 1,
    policy: "effect-firewall-v1",
    verdict: "denied",
    action: "delete_mock_asset",
    targetClass: "protected",
    reason: "protected_target_denied",
    workerSpawned: false,
    protectedBaselineVerifiedUnchanged: true,
  });
  assert.equal(receipt.sequence.workerDispatch.effectDenialDispatchDelta, 0);
  assert.equal(receipt.sequence.protectedState.bytesIdenticalAfterEffectDenial, true);
});

test("keeps post-run RunGuard rollback as the measured defense-in-depth path", () => {
  const rollback = receipt.sequence.postRunMaliciousRun;
  assert.equal(rollback.guardVerdict, "denied");
  assert.equal(rollback.recovery, "rolled_back");
  assert.equal(rollback.outputPublished, false);
  assert.equal(rollback.workerDispatchDelta, 1);
  assert.equal(rollback.effectDecision, null);
  assert.equal(rollback.effectCapability.action, "write_demo_result");
  assert.equal(rollback.effectCapability.targetClass, "workspace");
  assert.equal(rollback.effectCapability.useBudget, 1);
  assert.equal(rollback.effectCapability.usesClaimed, 1);
  assert.equal(rollback.effectSinkReceipt.state, "revoked");
  assert.equal(rollback.effectSinkReceipt.closeDisposition, "unredeemed");
  assert.equal(rollback.effectSinkReceipt.errorCode, "EFFECT_SINK_CLOSED");
  assert.equal(rollback.effectSinkReceipt.committedAt, null);
  assert.equal(rollback.changedFiles.includes(".env"), false);
  assert.equal(rollback.changedFiles.includes("[redacted protected path]"), true);
  assert.equal(rollback.changedFiles.includes("attack-scratch.tmp"), true);
  assert.deepEqual(receipt.sequence.boundedRollbackCleanup, {
    checkpointRestored: true,
    protectedBytesRestored: true,
    scratchArtifactRemoved: true,
    agentReturnedReady: true,
    recoveryHoldPresent: false,
    childProcessesStarted: 0,
    processCleanupRequired: false,
  });
  assert.equal(receipt.sequence.protectedState.bytesIdenticalAfterRollback, true);
});

test("preserves the stable submission fallback byte-for-byte", () => {
  assert.equal(stableBefore, stableAfter);
  assert.equal(receipt.stableFallback.beforeSha256, stableBefore);
  assert.equal(receipt.stableFallback.afterSha256, stableAfter);
  assert.equal(receipt.stableFallback.unchanged, true);
  assert.equal(receipt.stableFallback.overwritten, false);
});

test("rejects a false pre-dispatch claim even when an attacker recomputes the receipt hash", () => {
  const tampered = structuredClone(receipt);
  tampered.sequence.effectFirewallDeniedRun.workerDispatchDelta = 1;
  tampered.receiptPayloadSha256 = computeReceiptPayloadSha256(tampered);
  assert.throws(() => validateTrackCReceipt(tampered), /TRACK_C_EFFECT_FIREWALL_RUN_INVALID/);
});

test("rejects a false restoration claim even when an attacker recomputes the receipt hash", () => {
  const tampered = structuredClone(receipt);
  tampered.sequence.protectedState.bytesIdenticalAfterRollback = false;
  tampered.receiptPayloadSha256 = computeReceiptPayloadSha256(tampered);
  assert.throws(() => validateTrackCReceipt(tampered), /TRACK_C_PROTECTED_STATE_INVALID/);
});

test("rejects provider or hardened-sandbox overclaims even when re-sealed", () => {
  for (const mutation of [
    (candidate) => { candidate.proofBoundary.providerCalls = true; },
    (candidate) => { candidate.proofBoundary.hardenedSandbox = true; },
    (candidate) => { candidate.proofBoundary.ambientFilesystemAuthorityRemoved = true; },
    (candidate) => { candidate.implementation.providerDispatch = true; },
  ]) {
    const tampered = structuredClone(receipt);
    mutation(tampered);
    tampered.receiptPayloadSha256 = computeReceiptPayloadSha256(tampered);
    assert.throws(() => validateTrackCReceipt(tampered), /TRACK_C_BOUNDARY_OVERCLAIM|TRACK_C_IMPLEMENTATION_INVALID/);
  }
});

test("rejects false or bearer-leaking sink evidence even when re-sealed", () => {
  for (const mutation of [
    (candidate) => { candidate.sequence.normalRun.effectSinkReceipt.state = "revoked"; },
    (candidate) => { candidate.sequence.postRunMaliciousRun.effectSinkReceipt.closeDisposition = null; },
    (candidate) => { candidate.sequence.laterFreshSafeRun.effectSinkReceipt.grant = "leaked-bearer"; },
  ]) {
    const tampered = structuredClone(receipt);
    mutation(tampered);
    tampered.receiptPayloadSha256 = computeReceiptPayloadSha256(tampered);
    assert.throws(() => validateTrackCReceipt(tampered), /TRACK_C_(NORMAL_RUN|POST_RUN_ROLLBACK|LATER_SAFE_RUN)_INVALID/);
  }
});

test("CLI receipt verification rejects an unsealed edit", async () => {
  const tamperedPath = path.join(temporaryRoot, "tampered.json");
  const tampered = structuredClone(receipt);
  tampered.sequence.boundedRollbackCleanup.scratchArtifactRemoved = false;
  await writeFile(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--verify-receipt", tamperedPath], { cwd: launchpadRoot, timeout: 10_000 }),
    /TRACK_C_RECEIPT_PAYLOAD_HASH_INVALID/,
  );
});

test("CLI verifies the untouched machine-readable receipt", async () => {
  const completed = await execFileAsync(process.execPath, [scriptPath, "--verify-receipt", receiptPath], {
    cwd: launchpadRoot,
    timeout: 10_000,
  });
  const result = JSON.parse(completed.stdout);
  assert.equal(result.verdict, "PASS");
  assert.equal(result.mode, "verify-receipt");
  assert.equal(result.receiptPayloadSha256, receipt.receiptPayloadSha256);
});
