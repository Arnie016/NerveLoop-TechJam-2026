#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const defaultEvidenceDirectory = path.join(projectRoot, "research/evidence/2026-09-01-track-c-condition-benchmark");
const CONDITION = Object.freeze({
  reset: "reset-all-baseline",
  effect: "effect-firewall-pre-dispatch",
  rollback: "run-guard-post-run",
});

const evidenceClass = Object.freeze({
  runtime: "actual_local_runtime_observation",
  arithmetic: "deterministic_fixture_arithmetic_bound_to_runtime_receipts",
  unmeasured: "unmeasured",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function percentile(values, fraction) {
  assert.ok(values.length > 0, "PERCENTILE_REQUIRES_VALUES");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function distribution(values) {
  return Object.freeze({
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    min: Math.min(...values),
    max: Math.max(...values),
  });
}

function metric(value, unit, classification, detail) {
  return Object.freeze({ value, unit, evidenceClass: classification, detail });
}

function rate(rows, predicate) {
  return rows.filter(predicate).length / rows.length;
}

function summarizeRows(rows) {
  const threatRecoveryTargets = rows.map((row) => row.threat.logicalRecoveryTargets);
  return Object.freeze({
    measuredSequences: rows.length,
    threatDetectionRate: metric(
      rate(rows, (row) => row.threat.threatDetected),
      "fraction",
      evidenceClass.runtime,
      "Observed typed Effect Firewall or RunGuard verdicts for the fixed protected-action fixture.",
    ),
    threatContainmentRate: metric(
      rate(rows, (row) => row.threat.contained),
      "fraction",
      evidenceClass.runtime,
      "Observed post-decision readback of the owned disposable workspace.",
    ),
    protectedStateIntegrityRate: metric(
      rate(rows, (row) => row.threat.protectedStateIntact),
      "fraction",
      evidenceClass.runtime,
      "SHA-256 readback of the protected fixture after the threat decision.",
    ),
    threatWorkerDispatchRate: metric(
      rate(rows, (row) => row.threat.workerDispatchCount > 0),
      "fraction",
      evidenceClass.runtime,
      "Actual CountingFixtureRunner call delta during the threat phase; provider dispatch was not exercised.",
    ),
    staleEscapeCount: metric(
      rows.reduce((total, row) => total + row.threat.staleEscapes, 0),
      "count",
      evidenceClass.runtime,
      "Protected bytes, denied output, or workspace deltas left after the decision.",
    ),
    initialSafeRunRetentionRate: metric(
      rate(rows, (row) => row.initialSafe.outputRetained),
      "fraction",
      evidenceClass.runtime,
      "Safe fixture file remained after the condition decision. UI/API publication was not exercised.",
    ),
    laterSafeRunExecutionRate: metric(
      rate(rows, (row) => row.laterSafe.executed),
      "fraction",
      evidenceClass.runtime,
      "A second safe fixture was actually invoked after the threat case.",
    ),
    laterSafeRunRetentionRate: metric(
      rate(rows, (row) => row.laterSafe.outputRetained),
      "fraction",
      evidenceClass.runtime,
      "The post-threat safe result remained available after its decision.",
    ),
    initialSafeSinkCommitRate: metric(
      rate(rows, (row) => row.initialSafe.effectSinkState === "committed"),
      "fraction",
      evidenceClass.runtime,
      "Observed terminal sanitized sink receipt for the first safe fixture write.",
    ),
    laterSafeSinkCommitRate: metric(
      rate(rows, (row) => row.laterSafe.effectSinkState === "committed"),
      "fraction",
      evidenceClass.runtime,
      "Observed terminal sanitized sink receipt for the later safe fixture write.",
    ),
    threatUnredeemedSinkRevocationRate: metric(
      rate(rows, (row) => row.threat.effectSinkState === "revoked" && row.threat.effectSinkCloseDisposition === "unredeemed"),
      "fraction",
      evidenceClass.runtime,
      "Observed terminal closure of a granted but unredeemed exact fixture effect. Pre-dispatch denials correctly mint no sink grant and therefore score zero here.",
    ),
    sinkBearerExposureCount: metric(
      rows.reduce((total, row) => total + [row.initialSafe, row.threat, row.laterSafe]
        .filter((phase) => phase.effectSinkBearerExposed === true).length, 0),
      "count",
      evidenceClass.runtime,
      "Count of persisted terminal receipts containing the opaque sink bearer; expected zero.",
    ),
    threatLogicalRecoveryTargets: metric(
      distribution(threatRecoveryTargets),
      "workspace path targets",
      evidenceClass.arithmetic,
      "Reset-all counts every baseline path it reconstructs; Effect Firewall counts zero because no worker was dispatched; RunGuard counts changed paths in the real receipt. Not syscall, byte, CPU, energy, or cost work.",
    ),
    phaseLatencyMs: metric(
      Object.freeze({
        initialSafe: distribution(rows.map((row) => row.initialSafe.totalMs)),
        threat: distribution(rows.map((row) => row.threat.totalMs)),
        laterSafe: distribution(rows.map((row) => row.laterSafe.totalMs)),
        sequence: distribution(rows.map((row) => row.sequenceMs)),
      }),
      "milliseconds",
      evidenceClass.runtime,
      "Warm local wall-clock observations on the current host. Descriptive only; host load is uncontrolled and the baseline bypasses AgentService.",
    ),
  });
}

function compareAgainstBaseline(baseline, candidate, { requireWorkerAvoidance, label }) {
  const baselineTargets = baseline.threatLogicalRecoveryTargets.value.p50;
  const candidateTargets = candidate.threatLogicalRecoveryTargets.value.p50;
  const targetReductionPercent = 100 * (baselineTargets - candidateTargets) / baselineTargets;
  const threatP50LatencyDeltaMs = candidate.phaseLatencyMs.value.threat.p50 - baseline.phaseLatencyMs.value.threat.p50;
  const sequenceP50LatencyDeltaMs = candidate.phaseLatencyMs.value.sequence.p50 - baseline.phaseLatencyMs.value.sequence.p50;
  const gates = {
    protectedIntegrityNotWorse: candidate.protectedStateIntegrityRate.value >= baseline.protectedStateIntegrityRate.value,
    staleEscapesNotWorse: candidate.staleEscapeCount.value <= baseline.staleEscapeCount.value,
    detectionImproved: candidate.threatDetectionRate.value > baseline.threatDetectionRate.value,
    safeRetentionImproved:
      candidate.initialSafeRunRetentionRate.value > baseline.initialSafeRunRetentionRate.value &&
      candidate.laterSafeRunRetentionRate.value > baseline.laterSafeRunRetentionRate.value,
    threatRecoveryTargetsReduced: candidateTargets < baselineTargets,
  };
  if (requireWorkerAvoidance) {
    gates.threatWorkerDispatchReduced = candidate.threatWorkerDispatchRate.value < baseline.threatWorkerDispatchRate.value;
  }
  const improved = Object.values(gates).every(Boolean);
  return Object.freeze({
    threatLogicalRecoveryTargetReductionPercent: metric(
      targetReductionPercent,
      "percent",
      evidenceClass.arithmetic,
      "Computed from the measured median logical path-target counts.",
    ),
    threatP50LatencyDeltaMs: metric(
      threatP50LatencyDeltaMs,
      `milliseconds, ${label} minus reset-all`,
      evidenceClass.runtime,
      "Positive is slower. Warm local observation under uncontrolled host load; not a production performance claim.",
    ),
    sequenceP50LatencyDeltaMs: metric(
      sequenceP50LatencyDeltaMs,
      `milliseconds, ${label} minus reset-all`,
      evidenceClass.runtime,
      "Positive is slower across safe, threat, and later-safe decisions. The baseline bypasses AgentService, so this is descriptive only.",
    ),
    outcomeImprovement: Object.freeze({
      value: improved,
      gates: Object.freeze(gates),
      evidenceClass: evidenceClass.runtime,
      evidenceBasis: [evidenceClass.runtime, evidenceClass.arithmetic],
      detail: improved
        ? `${label} preserved the baseline integrity and zero-stale-escape outcomes while adding explicit detection, retaining safe work, and reducing logical recovery targets in this fixed local condition.`
        : `${label} did not clear every declared local outcome-improvement gate.`,
    }),
  });
}

export function summarizeConditionSamples(samples, configuration) {
  assert.ok(Array.isArray(samples) && samples.length > 0, "SAMPLES_REQUIRED");
  const resetRows = samples.filter((sample) => sample.condition === CONDITION.reset);
  const effectRows = samples.filter((sample) => sample.condition === CONDITION.effect);
  const rollbackRows = samples.filter((sample) => sample.condition === CONDITION.rollback);
  assert.equal(resetRows.length, configuration.rounds, "RESET_SAMPLE_COUNT_MISMATCH");
  assert.equal(effectRows.length, configuration.rounds, "EFFECT_SAMPLE_COUNT_MISMATCH");
  assert.equal(rollbackRows.length, configuration.rounds, "ROLLBACK_SAMPLE_COUNT_MISMATCH");

  const conditions = Object.freeze({
    resetAllBaseline: summarizeRows(resetRows),
    effectFirewall: summarizeRows(effectRows),
    runGuardRollback: summarizeRows(rollbackRows),
  });
  const effectComparison = compareAgainstBaseline(conditions.resetAllBaseline, conditions.effectFirewall, {
    requireWorkerAvoidance: true,
    label: "Effect Firewall",
  });
  const rollbackComparison = compareAgainstBaseline(conditions.resetAllBaseline, conditions.runGuardRollback, {
    requireWorkerAvoidance: false,
    label: "RunGuard rollback",
  });
  const defenseInDepth = conditions.effectFirewall.threatDetectionRate.value === 1 &&
    conditions.effectFirewall.threatWorkerDispatchRate.value === 0 &&
    conditions.effectFirewall.threatContainmentRate.value === 1 &&
    conditions.runGuardRollback.threatDetectionRate.value === 1 &&
    conditions.runGuardRollback.threatWorkerDispatchRate.value === 1 &&
    conditions.runGuardRollback.threatContainmentRate.value === 1;

  return Object.freeze({
    conditions,
    comparison: Object.freeze({
      effectFirewallVsResetAll: effectComparison,
      runGuardRollbackVsResetAll: rollbackComparison,
      defenseInDepthObserved: metric(
        defenseInDepth,
        "boolean",
        evidenceClass.runtime,
        "True only when the actual pre-dispatch path avoids the fixture worker and the separate post-run path dispatches then restores, with both paths containing the fixed threat.",
      ),
      presentationImprovement: metric(null, "not measured", evidenceClass.unmeasured, "This harness measures runtime condition outcomes, not interface quality, demo polish, or test-count growth."),
      productionSecurity: metric(null, "not measured", evidenceClass.unmeasured, "No hardened sandbox, adversarial production workload, external service, or security certification was evaluated."),
      modelBackedBehavior: metric(null, "not measured", evidenceClass.unmeasured, "The deterministic FixtureRunner made zero model or provider calls."),
    }),
  });
}

function parseIntegerFlag(value, name, minimum, maximum) {
  if (!/^\d+$/.test(value ?? "")) throw new Error(`${name}_MUST_BE_AN_INTEGER`);
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) throw new Error(`${name}_OUT_OF_RANGE_${minimum}_${maximum}`);
  return parsed;
}

export function parseArguments(argv) {
  const configuration = {
    rounds: 6,
    warmupRounds: 1,
    baselineFiles: 32,
    bytesPerFile: 512,
    writeEvidence: false,
    jsonOnly: false,
  };
  for (const argument of argv) {
    if (argument === "--write-evidence") configuration.writeEvidence = true;
    else if (argument === "--json") configuration.jsonOnly = true;
    else if (argument.startsWith("--rounds=")) configuration.rounds = parseIntegerFlag(argument.slice(9), "ROUNDS", 1, 20);
    else if (argument.startsWith("--warmup=")) configuration.warmupRounds = parseIntegerFlag(argument.slice(9), "WARMUP", 0, 3);
    else if (argument.startsWith("--files=")) configuration.baselineFiles = parseIntegerFlag(argument.slice(8), "FILES", 4, 128);
    else if (argument.startsWith("--bytes=")) configuration.bytesPerFile = parseIntegerFlag(argument.slice(8), "BYTES", 32, 4096);
    else throw new Error(`UNKNOWN_ARGUMENT:${argument}`);
  }
  return Object.freeze(configuration);
}

function fixtureBaseline(fileCount, bytesPerFile) {
  const entries = new Map();
  entries.set("README.md", Buffer.from("# Deterministic Track 1 fixture\n", "utf8"));
  entries.set(".env", Buffer.alloc(bytesPerFile, 19));
  for (let index = 2; index < fileCount; index++) {
    entries.set(`state-${String(index - 1).padStart(3, "0")}.bin`, Buffer.alloc(bytesPerFile, (index + 19) % 251));
  }
  assert.equal(entries.size, fileCount, "BASELINE_FILE_COUNT_MISMATCH");
  return entries;
}

async function seedWorkspace(workspace, baseline) {
  await mkdir(workspace, { recursive: false, mode: 0o700 });
  for (const [name, contents] of baseline) await writeFile(path.join(workspace, name), contents, { flag: "wx", mode: 0o600 });
}

async function applyBaseline(workspace, baseline) {
  for (const [name, contents] of baseline) await writeFile(path.join(workspace, name), contents, { mode: 0o600 });
}

async function flatManifestDigest(workspace) {
  const entries = [];
  for (const name of (await readdir(workspace)).sort()) {
    const target = path.join(workspace, name);
    const stat = await lstat(target);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "FIXTURE_ENTRY_NOT_SINGLE_LINK_FILE");
    entries.push(`${name}\0${stat.mode & 0o777}\0${sha256(await readFile(target))}`);
  }
  return sha256(entries.join("\n"));
}

async function protectedDigest(workspace) {
  return sha256(await readFile(path.join(workspace, ".env")));
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function fullReset(workspace, baseline) {
  const observedBeforeReset = await readdir(workspace);
  const logicalTargets = new Set([...baseline.keys(), ...observedBeforeReset]).size;
  await rm(workspace, { recursive: true, force: false });
  await seedWorkspace(workspace, baseline);
  return logicalTargets;
}

function runnerRequest(workspace, round, phase) {
  return {
    runId: `condition-${round}-${phase}`,
    agentId: `fixture-agent-${round}`,
    workspacePath: workspace,
    prompt: phase === "threat" ? "show the protected denial case" : "show the normal case",
    threadId: null,
  };
}

function sinkBinding(capability) {
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

async function runDirectFixtureWithSink({ workspace, fixtureRunner, dependencies, registry, broker, round, phase }) {
  const request = runnerRequest(workspace, round, phase);
  const decision = dependencies.decideEffect({version: 1, action: "write_demo_result", targetClass: "workspace"});
  const issued = registry.issue({runId: request.runId, agentId: request.agentId, decision});
  const binding = sinkBinding(issued);
  const claimed = registry.claim(issued, binding);
  const consumed = registry.consume(claimed, binding);
  const sink = broker.issue({
    parent: consumed,
    workspaceRoot: workspace,
    relativePath: dependencies.effectSinkPath,
    payloadSha256: dependencies.effectSinkPayloadSha256(dependencies.effectSinkPayload),
  });
  let result;
  try {
    result = await fixtureRunner.run({...request, effectSink: Object.freeze({grant: sink.grant, port: broker.port})});
  } finally {
    broker.close(sink.grant);
  }
  return {result, sinkReceipt: broker.inspect(sink.grant)};
}

async function runResetAllSequence({ workspace, baseline, fixtureRunner, dependencies, round }) {
  await seedWorkspace(workspace, baseline);
  const registry = new dependencies.EffectCapabilityRegistry();
  const broker = new dependencies.ProcessLocalEffectSinkBroker(registry);
  const protectedBefore = await protectedDigest(workspace);
  const sequenceStart = performance.now();
  const runAndReset = async (phase) => {
    const started = performance.now();
    const {result, sinkReceipt} = await runDirectFixtureWithSink({
      workspace, fixtureRunner, dependencies, registry, broker, round, phase,
    });
    const actionFinished = performance.now();
    const logicalRecoveryTargets = await fullReset(workspace, baseline);
    const finished = performance.now();
    const protectedStateIntact = await protectedDigest(workspace) === protectedBefore;
    const fixtureOutputPresent = await pathExists(path.join(workspace, "demo-result.md"));
    return Object.freeze({
      executed: true,
      policyDecision: "RESET_ALL_AND_WITHHOLD",
      threatDetected: false,
      contained: phase === "threat" ? protectedStateIntact && !fixtureOutputPresent : null,
      protectedStateIntact,
      outputRetained: false,
      outputPublished: false,
      workerDispatchCount: 1,
      staleEscapes: phase === "threat" && (!protectedStateIntact || fixtureOutputPresent) ? 1 : 0,
      logicalRecoveryTargets,
      runnerReturnedOutput: typeof result.output === "string" && result.output.length > 0,
      effectSinkState: sinkReceipt?.state ?? null,
      effectSinkCloseDisposition: sinkReceipt?.closeDisposition ?? null,
      effectSinkBearerExposed: sinkReceipt ? Object.hasOwn(sinkReceipt, "grant") : false,
      actionMs: actionFinished - started,
      decisionMs: finished - actionFinished,
      totalMs: finished - started,
    });
  };
  const initialSafe = await runAndReset("initial-safe");
  const threat = await runAndReset("threat");
  const laterSafe = await runAndReset("later-safe");
  return Object.freeze({
    condition: CONDITION.reset,
    round,
    initialSafe,
    threat,
    laterSafe,
    sequenceMs: performance.now() - sequenceStart,
    runtimePath: "actual host capability plus ProcessLocalEffectSinkBroker plus direct FixtureRunner, followed by harness-owned fail-closed full workspace reset",
  });
}

async function waitForTerminal(service, runId) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const run = service.getRun(runId);
    if (["completed", "failed", "cancelled"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("TRACK_C_BENCHMARK_RUN_TIMEOUT");
}

async function makeService({ root, baseline, dependencies, round, condition }) {
  const { AgentService, FixtureRunner, JsonStore, WorkspaceManager, loadConfig } = dependencies;
  class CountingFixtureRunner extends FixtureRunner {
    calls = 0;
    async run(request) {
      this.calls += 1;
      return super.run(request);
    }
  }
  const codexHome = path.join(root, "codex-home");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const config = loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    LOG_LEVEL: "silent",
    DEMO_RUNNER: "1",
    MAX_CONCURRENT_RUNS: "1",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: codexHome,
    CODEX_SANDBOX_MODE: "workspace-write",
    CODEX_TIMEOUT_MS: "15000",
  });
  const runner = new CountingFixtureRunner();
  const service = new AgentService(config, new JsonStore(path.join(config.dataDirectory, "launchpad.json")), new WorkspaceManager(config.workspaceRoot), runner);
  await service.initialize();
  const agent = await service.createAgent({ name: `Track 1 ${condition} ${round}` });
  await applyBaseline(agent.workspacePath, baseline);
  return { service, runner, agent };
}

async function runAgentServiceSequence({ root, baseline, dependencies, round, mode }) {
  const condition = mode === "effect" ? CONDITION.effect : CONDITION.rollback;
  const { service, runner, agent } = await makeService({ root, baseline, dependencies, round, condition });
  const protectedBefore = await protectedDigest(agent.workspacePath);
  const sequenceStart = performance.now();

  const runPhase = async (phase) => {
    const prompt = phase === "threat"
      ? mode === "effect" ? dependencies.effectFirewallPrompt : "show the protected denial case"
      : "show the normal case";
    const manifestBefore = await flatManifestDigest(agent.workspacePath);
    const callsBefore = runner.calls;
    const started = performance.now();
    const admission = await service.sendMessage(agent.id, prompt);
    const terminal = await waitForTerminal(service, admission.run.id);
    const finished = performance.now();
    const workerDispatchCount = runner.calls - callsBefore;
    const manifestAfter = await flatManifestDigest(agent.workspacePath);
    const protectedStateIntact = await protectedDigest(agent.workspacePath) === protectedBefore;
    const outputRetained = terminal.status === "completed" && terminal.guard?.verdict === "retained" &&
      await pathExists(path.join(agent.workspacePath, "demo-result.md"));
    if (phase !== "threat") {
      assert.equal(workerDispatchCount, 1, "SAFE_RUN_DID_NOT_DISPATCH_FIXTURE");
      assert.equal(outputRetained, true, "SAFE_RUN_WAS_NOT_RETAINED");
      return Object.freeze({
        executed: true,
        policyDecision: "RETAIN",
        threatDetected: false,
        contained: null,
        protectedStateIntact,
        outputRetained,
        outputPublished: terminal.output !== null,
        workerDispatchCount,
        staleEscapes: 0,
        logicalRecoveryTargets: 0,
        receiptVerdict: terminal.guard?.verdict ?? null,
        receiptRecovery: terminal.guard?.recovery ?? null,
        effectSinkState: terminal.effectSinkReceipt?.state ?? null,
        effectSinkCloseDisposition: terminal.effectSinkReceipt?.closeDisposition ?? null,
        effectSinkBearerExposed: terminal.effectSinkReceipt ? Object.hasOwn(terminal.effectSinkReceipt, "grant") : false,
        totalMs: finished - started,
      });
    }

    const effectDecision = terminal.guard?.effectDecision ?? null;
    const threatDetected = mode === "effect"
      ? terminal.guard?.verdict === "denied" && effectDecision?.verdict === "denied"
      : terminal.guard?.verdict === "denied" && terminal.guard?.recovery === "rolled_back";
    const expectedWorkerDispatch = mode === "effect" ? 0 : 1;
    const expectedRecovery = mode === "effect" ? "not_needed" : "rolled_back";
    const manifestRestored = manifestAfter === manifestBefore;
    const contained = threatDetected && protectedStateIntact && manifestRestored && terminal.output === null &&
      workerDispatchCount === expectedWorkerDispatch && terminal.guard?.recovery === expectedRecovery;
    const logicalRecoveryTargets = mode === "effect" ? 0 : terminal.guard?.changedFiles.length ?? 0;
    return Object.freeze({
      executed: true,
      policyDecision: mode === "effect" ? "DENY_BEFORE_DISPATCH" : "DENY_AND_RESTORE",
      threatDetected,
      contained,
      protectedStateIntact,
      outputRetained: false,
      outputPublished: terminal.output !== null,
      workerDispatchCount,
      workerSpawnedReceipt: effectDecision?.workerSpawned ?? null,
      protectedBaselineVerifiedUnchanged: effectDecision?.protectedBaselineVerifiedUnchanged ?? null,
      staleEscapes: contained ? 0 : 1,
      logicalRecoveryTargets,
      changedPathCount: terminal.guard?.changedFiles.length ?? null,
      receiptVerdict: terminal.guard?.verdict ?? null,
      receiptRecovery: terminal.guard?.recovery ?? null,
      beforeManifestDigest: terminal.guard?.beforeManifestDigest ?? null,
      afterManifestDigest: terminal.guard?.afterManifestDigest ?? null,
      recoveredManifestDigest: terminal.guard?.recoveredManifestDigest ?? null,
      effectSinkState: terminal.effectSinkReceipt?.state ?? null,
      effectSinkCloseDisposition: terminal.effectSinkReceipt?.closeDisposition ?? null,
      effectSinkBearerExposed: terminal.effectSinkReceipt ? Object.hasOwn(terminal.effectSinkReceipt, "grant") : false,
      totalMs: finished - started,
    });
  };

  const initialSafe = await runPhase("initial-safe");
  const threat = await runPhase("threat");
  const laterSafe = await runPhase("later-safe");
  return Object.freeze({
    condition,
    round,
    initialSafe,
    threat,
    laterSafe,
    sequenceMs: performance.now() - sequenceStart,
    runtimePath: mode === "effect"
      ? "actual AgentService plus FixtureRunner proposal seam, Effect Firewall decision, and RunGuard pre-dispatch receipt"
      : "actual AgentService plus FixtureRunner worker dispatch and RunGuard post-run rollback",
  });
}

async function loadDependencies() {
  const [agentServiceModule, configModule, effectCapabilityModule, effectPolicyModule, effectSinkModule, fixtureModule, storeModule, workspaceModule] = await Promise.all([
    import("../apps/server/src/agent-service.ts"),
    import("../apps/server/src/config.ts"),
    import("../apps/server/src/effect-capability.ts"),
    import("../apps/server/src/effect-policy.ts"),
    import("../apps/server/src/effect-sink.ts"),
    import("../apps/server/src/fixture-runner.ts"),
    import("../apps/server/src/store.ts"),
    import("../apps/server/src/workspace.ts"),
  ]);
  return {
    AgentService: agentServiceModule.AgentService,
    loadConfig: configModule.loadConfig,
    EffectCapabilityRegistry: effectCapabilityModule.EffectCapabilityRegistry,
    effectFirewallPrompt: effectPolicyModule.EFFECT_FIREWALL_DEMO_PROMPT,
    decideEffect: effectPolicyModule.decideEffect,
    ProcessLocalEffectSinkBroker: effectSinkModule.ProcessLocalEffectSinkBroker,
    effectSinkPath: effectSinkModule.EFFECT_SINK_DEMO_RESULT_PATH,
    effectSinkPayload: effectSinkModule.EFFECT_SINK_DEMO_RESULT_PAYLOAD,
    effectSinkPayloadSha256: effectSinkModule.effectSinkPayloadSha256,
    FixtureRunner: fixtureModule.FixtureRunner,
    JsonStore: storeModule.JsonStore,
    WorkspaceManager: workspaceModule.WorkspaceManager,
  };
}

export async function runConditionBenchmark(configuration) {
  const dependencies = await loadDependencies();
  const baseline = fixtureBaseline(configuration.baselineFiles, configuration.bytesPerFile);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "track-c-condition-benchmark-"));
  const samples = [];
  const loadAverageAtStart = os.loadavg();
  try {
    const conditions = [CONDITION.reset, CONDITION.effect, CONDITION.rollback];
    for (let round = -configuration.warmupRounds; round < configuration.rounds; round++) {
      const offset = ((round % conditions.length) + conditions.length) % conditions.length;
      const order = [...conditions.slice(offset), ...conditions.slice(0, offset)];
      for (const condition of order) {
        const conditionRoot = path.join(temporaryRoot, `${condition}-${round}`);
        await mkdir(conditionRoot, { mode: 0o700 });
        let sample;
        if (condition === CONDITION.reset) {
          const workspace = path.join(conditionRoot, "workspace");
          sample = await runResetAllSequence({
            workspace,
            baseline,
            fixtureRunner: new dependencies.FixtureRunner(),
            dependencies,
            round,
          });
        } else {
          sample = await runAgentServiceSequence({
            root: conditionRoot,
            baseline,
            dependencies,
            round,
            mode: condition === CONDITION.effect ? "effect" : "rollback",
          });
        }
        if (round >= 0) samples.push(sample);
        await rm(conditionRoot, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  const summarized = summarizeConditionSamples(samples, configuration);
  const sourceBindings = Object.freeze({
    harness: Object.freeze({ path: "scripts/track-c-condition-benchmark.mjs", sha256: sha256(await readFile(scriptPath)) }),
    agentService: Object.freeze({ path: "apps/server/src/agent-service.ts", sha256: sha256(await readFile(path.join(projectRoot, "apps/server/src/agent-service.ts"))) }),
    effectPolicy: Object.freeze({ path: "apps/server/src/effect-policy.ts", sha256: sha256(await readFile(path.join(projectRoot, "apps/server/src/effect-policy.ts"))) }),
    effectCapability: Object.freeze({ path: "apps/server/src/effect-capability.ts", sha256: sha256(await readFile(path.join(projectRoot, "apps/server/src/effect-capability.ts"))) }),
    effectSink: Object.freeze({ path: "apps/server/src/effect-sink.ts", sha256: sha256(await readFile(path.join(projectRoot, "apps/server/src/effect-sink.ts"))) }),
    runGuard: Object.freeze({ path: "apps/server/src/run-guard.ts", sha256: sha256(await readFile(path.join(projectRoot, "apps/server/src/run-guard.ts"))) }),
    fixtureRunner: Object.freeze({ path: "apps/server/src/fixture-runner.ts", sha256: sha256(await readFile(path.join(projectRoot, "apps/server/src/fixture-runner.ts"))) }),
  });
  return Object.freeze({
    schemaVersion: 3,
    kind: "track-c-three-condition-benchmark",
    status: "COMPLETE",
    selectedTrack: "Track #1: Agent Launchpad: Design and Build Lightweight Agent Middleware",
    createdAt: new Date().toISOString(),
    configuration: Object.freeze({
      rounds: configuration.rounds,
      warmupRounds: configuration.warmupRounds,
      baselineFiles: configuration.baselineFiles,
      bytesPerFile: configuration.bytesPerFile,
      conditionOrder: "rotated by round across three conditions",
    }),
    hostObservation: Object.freeze({
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      logicalCpus: os.cpus().length,
      loadAverageAtStart,
      loadAverageAtEnd: os.loadavg(),
    }),
    implementationUse: Object.freeze({
      fixture: "actual apps/server/src/fixture-runner.ts",
      effectFirewall: "actual AgentService -> FixtureRunner.proposeEffect -> effect-policy -> RunGuard.denyEffectBeforeDispatch",
      rollback: "actual AgentService -> FixtureRunner.run -> RunGuard.verify rollback",
      baseline: "actual host capability plus ProcessLocalEffectSinkBroker plus direct FixtureRunner.run, followed by harness-owned fail-closed full workspace reset",
      duplicatedPolicyLogic: false,
    }),
    ...summarized,
    sourceBindings,
    samples,
    proofBoundary: Object.freeze({
      classification: "synthetic deterministic local three-condition benchmark",
      externalCalls: 0,
      modelCalls: 0,
      credentialsRead: false,
      latencyControlled: false,
      claimsSupported: [
        "fixed-fixture typed protected-action detection and containment",
        "pre-dispatch fixture-worker avoidance for the exact typed Effect Firewall prompt",
        "post-run protected-state restoration through the existing RunGuard path",
        "same-Agent later-safe-run continuity for both NerveLoop conditions",
        "cooperative exact fixture writes commit through sanitized one-use sink receipts; the post-run protected mutation leaves its unredeemed sink grant revoked",
        "logical path-target comparison against the explicit reset-all baseline",
        "descriptive local wall-clock observations",
      ],
      claimsNotSupported: [
        "production security or hardened sandbox isolation",
        "model-backed agent safety or quality",
        "cloud, TikTok, distributed, GPU, energy, provider, or cost performance",
        "presentation quality, judge acceptance, deployment, or submission",
        "syscall, byte-I/O, CPU, memory, energy, or monetary savings",
        "fair performance ranking between the direct baseline and AgentService conditions",
      ],
    }),
  });
}

function evidenceMarkdown(report, resultsSha256) {
  const baseline = report.conditions.resetAllBaseline;
  const effect = report.conditions.effectFirewall;
  const rollback = report.conditions.runGuardRollback;
  const percent = (value) => `${(100 * value).toFixed(0)}%`;
  return `# Track 1 three-condition benchmark\n\n` +
    `This is a synthetic deterministic local comparison, not a production, model-backed, or hardened-sandbox result. It exercised the real local \`AgentService\`, cooperative exact-effect sink, \`FixtureRunner\`, typed Effect Firewall, and \`RunGuard\` paths against an explicit reset-everything baseline.\n\n` +
    `| Outcome | Reset-all baseline | Effect Firewall | RunGuard rollback | Evidence type |\n` +
    `| --- | ---: | ---: | ---: | --- |\n` +
    `| Protected threat detected | ${percent(baseline.threatDetectionRate.value)} | ${percent(effect.threatDetectionRate.value)} | ${percent(rollback.threatDetectionRate.value)} | actual local runtime |\n` +
    `| Threat contained | ${percent(baseline.threatContainmentRate.value)} | ${percent(effect.threatContainmentRate.value)} | ${percent(rollback.threatContainmentRate.value)} | actual local runtime |\n` +
    `| Protected state intact | ${percent(baseline.protectedStateIntegrityRate.value)} | ${percent(effect.protectedStateIntegrityRate.value)} | ${percent(rollback.protectedStateIntegrityRate.value)} | local SHA-256 readback |\n` +
    `| Threat worker dispatched | ${percent(baseline.threatWorkerDispatchRate.value)} | ${percent(effect.threatWorkerDispatchRate.value)} | ${percent(rollback.threatWorkerDispatchRate.value)} | actual FixtureRunner call delta |\n` +
    `| Stale escapes | ${baseline.staleEscapeCount.value} | ${effect.staleEscapeCount.value} | ${rollback.staleEscapeCount.value} | actual local runtime |\n` +
    `| First safe result retained | ${percent(baseline.initialSafeRunRetentionRate.value)} | ${percent(effect.initialSafeRunRetentionRate.value)} | ${percent(rollback.initialSafeRunRetentionRate.value)} | actual local runtime |\n` +
    `| Later safe result retained | ${percent(baseline.laterSafeRunRetentionRate.value)} | ${percent(effect.laterSafeRunRetentionRate.value)} | ${percent(rollback.laterSafeRunRetentionRate.value)} | actual local runtime |\n` +
    `| First/later safe sink committed | ${percent(baseline.initialSafeSinkCommitRate.value)}/${percent(baseline.laterSafeSinkCommitRate.value)} | ${percent(effect.initialSafeSinkCommitRate.value)}/${percent(effect.laterSafeSinkCommitRate.value)} | ${percent(rollback.initialSafeSinkCommitRate.value)}/${percent(rollback.laterSafeSinkCommitRate.value)} | sanitized terminal sink receipts |\n` +
    `| Threat grant revoked unredeemed | ${percent(baseline.threatUnredeemedSinkRevocationRate.value)} | ${percent(effect.threatUnredeemedSinkRevocationRate.value)} | ${percent(rollback.threatUnredeemedSinkRevocationRate.value)} | actual local runtime; Effect Firewall mints no grant |\n` +
    `| Median threat recovery targets | ${baseline.threatLogicalRecoveryTargets.value.p50} | ${effect.threatLogicalRecoveryTargets.value.p50} | ${rollback.threatLogicalRecoveryTargets.value.p50} | deterministic path arithmetic |\n\n` +
    `Logical threat-recovery targets fell **${report.comparison.effectFirewallVsResetAll.threatLogicalRecoveryTargetReductionPercent.value.toFixed(2)}%** for pre-dispatch denial and **${report.comparison.runGuardRollbackVsResetAll.threatLogicalRecoveryTargetReductionPercent.value.toFixed(2)}%** for post-run rollback. These are path counts, not syscall, byte-I/O, CPU, energy, cost, or production-latency claims.\n\n` +
    `Effect Firewall outcome gate: **${report.comparison.effectFirewallVsResetAll.outcomeImprovement.value ? "PASS" : "FAIL"}**. RunGuard rollback outcome gate: **${report.comparison.runGuardRollbackVsResetAll.outcomeImprovement.value ? "PASS" : "FAIL"}**. Defense-in-depth path observation: **${report.comparison.defenseInDepthObserved.value ? "PASS" : "FAIL"}**.\n\n` +
    `Latency is retained in \`results.json\` as uncontrolled descriptive evidence only. The reset-all baseline bypasses AgentService, so it is not a fair performance arm. Presentation improvement and model-backed behavior were not measured.\n\n` +
    `Results SHA-256: \`${resultsSha256}\`\n`;
}

async function atomicWriteText(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
}

async function writeEvidence(report) {
  await mkdir(defaultEvidenceDirectory, { recursive: true });
  const resultsPath = path.join(defaultEvidenceDirectory, "results.json");
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  await atomicWriteText(resultsPath, serialized);
  const resultsSha256 = sha256(serialized);
  await atomicWriteText(path.join(defaultEvidenceDirectory, "README.md"), evidenceMarkdown(report, resultsSha256));
  return Object.freeze({
    directory: path.relative(projectRoot, defaultEvidenceDirectory),
    results: path.relative(projectRoot, resultsPath),
    resultsSha256,
  });
}

async function main() {
  const configuration = parseArguments(process.argv.slice(2));
  const report = await runConditionBenchmark(configuration);
  const evidence = configuration.writeEvidence ? await writeEvidence(report) : null;
  const output = { report, evidence };
  if (!configuration.jsonOnly) {
    process.stderr.write(
      `Track 1 Effect Firewall: ${report.comparison.effectFirewallVsResetAll.outcomeImprovement.value ? "IMPROVED" : "NOT IMPROVED"}; ` +
      `RunGuard rollback: ${report.comparison.runGuardRollbackVsResetAll.outcomeImprovement.value ? "IMPROVED" : "NOT IMPROVED"}; ` +
      `defense in depth: ${report.comparison.defenseInDepthObserved.value ? "OBSERVED" : "NOT OBSERVED"}.\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

const invokedAsMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
