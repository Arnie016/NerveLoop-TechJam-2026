import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseArguments, summarizeConditionSamples } from "./track-c-condition-benchmark.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(projectRoot, "node_modules/.bin/tsx");
const benchmark = path.join(projectRoot, "scripts/track-c-condition-benchmark.mjs");

function phase(overrides = {}) {
  return {
    executed: true,
    threatDetected: false,
    contained: null,
    protectedStateIntact: true,
    outputRetained: false,
    workerDispatchCount: 1,
    staleEscapes: 0,
    logicalRecoveryTargets: 0,
    effectSinkState: null,
    effectSinkCloseDisposition: null,
    effectSinkBearerExposed: false,
    totalMs: 1,
    ...overrides,
  };
}

function sample(condition, overrides = {}) {
  const contained = condition !== "reset-all-baseline";
  const effect = condition === "effect-firewall-pre-dispatch";
  return {
    condition,
    initialSafe: phase({ outputRetained: contained, effectSinkState: "committed" }),
    threat: phase({
      threatDetected: contained,
      contained: true,
      workerDispatchCount: effect ? 0 : 1,
      logicalRecoveryTargets: condition === "reset-all-baseline" ? 8 : effect ? 0 : 1,
      effectSinkState: effect ? null : "revoked",
      effectSinkCloseDisposition: effect ? null : "unredeemed",
    }),
    laterSafe: phase({ outputRetained: contained, effectSinkState: "committed" }),
    sequenceMs: 3,
    ...overrides,
  };
}

test("argument parser is bounded and rejects unknown controls", () => {
  assert.deepEqual(parseArguments(["--rounds=2", "--warmup=0", "--files=8", "--bytes=64", "--json"]), {
    rounds: 2,
    warmupRounds: 0,
    baselineFiles: 8,
    bytesPerFile: 64,
    writeEvidence: false,
    jsonOnly: true,
  });
  assert.throws(() => parseArguments(["--rounds=0"]), /ROUNDS_OUT_OF_RANGE/);
  assert.throws(() => parseArguments(["--bogus"]), /UNKNOWN_ARGUMENT/);
});

test("three-condition summary separates pre-dispatch prevention from post-run rollback", () => {
  const report = summarizeConditionSamples([
    sample("reset-all-baseline"),
    sample("effect-firewall-pre-dispatch"),
    sample("run-guard-post-run"),
  ], { rounds: 1 });
  assert.equal(report.comparison.effectFirewallVsResetAll.outcomeImprovement.value, true);
  assert.equal(report.comparison.runGuardRollbackVsResetAll.outcomeImprovement.value, true);
  assert.equal(report.comparison.defenseInDepthObserved.value, true);
  assert.equal(report.comparison.effectFirewallVsResetAll.threatLogicalRecoveryTargetReductionPercent.value, 100);
  assert.equal(report.comparison.runGuardRollbackVsResetAll.threatLogicalRecoveryTargetReductionPercent.value, 87.5);
  assert.equal(report.conditions.effectFirewall.threatWorkerDispatchRate.value, 0);
  assert.equal(report.conditions.runGuardRollback.threatWorkerDispatchRate.value, 1);
  assert.equal(report.comparison.presentationImprovement.value, null);
});

test("Effect Firewall outcome gate fails closed if a worker was dispatched", () => {
  const effect = sample("effect-firewall-pre-dispatch");
  effect.threat = phase({
    threatDetected: true,
    contained: true,
    workerDispatchCount: 1,
    logicalRecoveryTargets: 0,
  });
  const report = summarizeConditionSamples([
    sample("reset-all-baseline"),
    effect,
    sample("run-guard-post-run"),
  ], { rounds: 1 });
  assert.equal(report.comparison.effectFirewallVsResetAll.outcomeImprovement.value, false);
  assert.equal(report.comparison.effectFirewallVsResetAll.outcomeImprovement.gates.threatWorkerDispatchReduced, false);
  assert.equal(report.comparison.defenseInDepthObserved.value, false);
});

test("outcome gates fail closed on a stale guarded escape", () => {
  const rollback = sample("run-guard-post-run");
  rollback.threat = phase({
    threatDetected: true,
    contained: false,
    protectedStateIntact: false,
    workerDispatchCount: 1,
    staleEscapes: 1,
    logicalRecoveryTargets: 1,
  });
  const report = summarizeConditionSamples([
    sample("reset-all-baseline"),
    sample("effect-firewall-pre-dispatch"),
    rollback,
  ], { rounds: 1 });
  assert.equal(report.comparison.runGuardRollbackVsResetAll.outcomeImprovement.value, false);
  assert.equal(report.comparison.runGuardRollbackVsResetAll.outcomeImprovement.gates.protectedIntegrityNotWorse, false);
  assert.equal(report.comparison.runGuardRollbackVsResetAll.outcomeImprovement.gates.staleEscapesNotWorse, false);
});

test("focused integration exercises real AgentService Effect Firewall and RunGuard paths without writing evidence", { timeout: 45_000 }, () => {
  const result = spawnSync(tsx, [benchmark, "--rounds=1", "--warmup=0", "--files=8", "--bytes=64", "--json"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 40_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.evidence, null);
  assert.equal(output.report.schemaVersion, 3);
  assert.equal(output.report.implementationUse.duplicatedPolicyLogic, false);
  assert.match(output.report.implementationUse.effectFirewall, /AgentService.*proposeEffect.*effect-policy.*denyEffectBeforeDispatch/);
  assert.match(output.report.implementationUse.rollback, /AgentService.*FixtureRunner\.run.*RunGuard\.verify/);

  const baseline = output.report.conditions.resetAllBaseline;
  const effect = output.report.conditions.effectFirewall;
  const rollback = output.report.conditions.runGuardRollback;
  assert.equal(baseline.threatDetectionRate.value, 0);
  assert.equal(effect.threatDetectionRate.value, 1);
  assert.equal(rollback.threatDetectionRate.value, 1);
  assert.equal(baseline.protectedStateIntegrityRate.value, 1);
  assert.equal(effect.protectedStateIntegrityRate.value, 1);
  assert.equal(rollback.protectedStateIntegrityRate.value, 1);
  assert.equal(baseline.staleEscapeCount.value, 0);
  assert.equal(effect.staleEscapeCount.value, 0);
  assert.equal(rollback.staleEscapeCount.value, 0);
  assert.equal(baseline.threatWorkerDispatchRate.value, 1);
  assert.equal(effect.threatWorkerDispatchRate.value, 0);
  assert.equal(rollback.threatWorkerDispatchRate.value, 1);
  assert.equal(baseline.laterSafeRunRetentionRate.value, 0);
  assert.equal(effect.laterSafeRunRetentionRate.value, 1);
  assert.equal(rollback.laterSafeRunRetentionRate.value, 1);
  assert.equal(baseline.initialSafeSinkCommitRate.value, 1);
  assert.equal(effect.initialSafeSinkCommitRate.value, 1);
  assert.equal(rollback.initialSafeSinkCommitRate.value, 1);
  assert.equal(effect.threatUnredeemedSinkRevocationRate.value, 0);
  assert.equal(rollback.threatUnredeemedSinkRevocationRate.value, 1);
  assert.equal(effect.sinkBearerExposureCount.value, 0);
  assert.equal(rollback.sinkBearerExposureCount.value, 0);
  assert.equal(baseline.threatLogicalRecoveryTargets.value.p50, 8);
  assert.equal(effect.threatLogicalRecoveryTargets.value.p50, 0);
  assert.equal(rollback.threatLogicalRecoveryTargets.value.p50, 1);
  assert.equal(output.report.comparison.effectFirewallVsResetAll.outcomeImprovement.value, true);
  assert.equal(output.report.comparison.runGuardRollbackVsResetAll.outcomeImprovement.value, true);
  assert.equal(output.report.comparison.defenseInDepthObserved.value, true);
  assert.equal(output.report.proofBoundary.modelCalls, 0);
  assert.equal(output.report.proofBoundary.latencyControlled, false);
});

test("CLI rejects unsupported flags before any benchmark run", () => {
  const result = spawnSync(tsx, [benchmark, "--unknown-control"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UNKNOWN_ARGUMENT/);
});
