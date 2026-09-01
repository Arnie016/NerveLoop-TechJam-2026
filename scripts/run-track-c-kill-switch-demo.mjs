#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const scriptPath = fileURLToPath(import.meta.url);
const scriptRoot = path.dirname(scriptPath);
const launchpadRoot = path.resolve(scriptRoot, "..");
const evidenceRoot = path.join(launchpadRoot, "research", "evidence", "2026-09-01-track-c-functional-flow");
const defaultOutput = path.join(evidenceRoot, "current.json");
const stableFallbackRelative = "docs/demo/nerveloop-submission-draft.mp4";
const stableFallbackPath = path.join(launchpadRoot, stableFallbackRelative);
const officialTrack = "Track #1: Agent Launchpad: Design and Build Lightweight Agent Middleware";
const protectedFixtureBytes = Buffer.from("fixture-only protected baseline; contains no credential\n", "utf8");
const scratchName = "attack-scratch.tmp";
const effectSinkDemoResultPath = "demo-result.md";
const effectSinkDemoResultPayload = "# RunGuard demo result\n\nA controlled local fixture completed a workspace-scoped Run.\n";
const normalPrompt = "Complete one normal bounded workspace Run for the Track 1 fixture.";
const rollbackAttackPrompt = "Attempt the controlled protected workspace mutation for the Track 1 rollback fixture.";
const laterSafePrompt = "Complete one later fresh bounded workspace Run after both denials.";

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(filePath) {
  const entry = await lstat(filePath);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("TRACK_C_EXPECTED_REGULAR_FILE");
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size) {
      throw new Error("TRACK_C_FILE_CHANGED_BEFORE_HASH");
    }
    const digest = createHash("sha256");
    const chunk = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (position < opened.size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, opened.size - position), position);
      if (bytesRead === 0) throw new Error("TRACK_C_FILE_SHORT_READ");
      digest.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const closedOver = await handle.stat();
    const current = await lstat(filePath);
    if (closedOver.dev !== opened.dev || closedOver.ino !== opened.ino || closedOver.size !== opened.size ||
        current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size) {
      throw new Error("TRACK_C_FILE_CHANGED_DURING_HASH");
    }
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

function withoutPayloadHash(receipt) {
  const { receiptPayloadSha256: _ignored, ...payload } = receipt;
  return payload;
}

export function computeReceiptPayloadSha256(receipt) {
  return sha256Bytes(Buffer.from(canonicalJson(withoutPayloadHash(receipt)), "utf8"));
}

function exactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
    throw new Error(code);
  }
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function assertBoundary(receipt) {
  const boundary = receipt.proofBoundary;
  exactKeys(boundary, ["ambientFilesystemAuthorityRemoved", "cooperativeFixtureSinkMediation", "hardenedSandbox", "localOnly", "modelExecuted", "productionIsolation", "providerCalls", "tiktokAccess"], "TRACK_C_BOUNDARY_SHAPE_INVALID");
  if (boundary.localOnly !== true || boundary.modelExecuted !== false || boundary.providerCalls !== false ||
      boundary.cooperativeFixtureSinkMediation !== true || boundary.ambientFilesystemAuthorityRemoved !== false ||
      boundary.hardenedSandbox !== false || boundary.productionIsolation !== false || boundary.tiktokAccess !== false) {
    throw new Error("TRACK_C_BOUNDARY_OVERCLAIM");
  }
}

function assertOrdinaryRetainedRun(run, code) {
  if (run.status !== "completed" || run.outputPublished !== true || run.guardVerdict !== "retained" ||
      run.recovery !== "not_needed" || run.providerDispatch !== false || run.workerDispatchDelta !== 1 ||
      run.effectDecision !== null || !validConsumedCapability(run.effectCapability, run.runId) ||
      !validSinkReceipt(run.effectSinkReceipt, run.effectCapability, "committed")) {
    throw new Error(code);
  }
}

function validConsumedCapability(capability, runId) {
  if (!capability || capability.registry !== "process-local" || capability.state !== "consumed" ||
      capability.runId !== runId || typeof capability.agentId !== "string" || capability.agentId.length === 0 ||
      capability.action !== "write_demo_result" || capability.targetClass !== "workspace" ||
      capability.policy !== "effect-firewall-v1" || capability.policyVersion !== 1 ||
      !isSha256(capability.policyDigest) || capability.useBudget !== 1 || capability.usesClaimed !== 1 ||
      typeof capability.grantId !== "string" || capability.grantId.length === 0 ||
      !/not authentication, durable authority, provider interception, or kernel isolation/i.test(capability.boundary)) {
    return false;
  }
  const issuedAt = Date.parse(capability.issuedAt);
  const expiresAt = Date.parse(capability.expiresAt);
  const claimedAt = Date.parse(capability.claimedAt);
  const consumedAt = Date.parse(capability.consumedAt);
  return [issuedAt, expiresAt, claimedAt, consumedAt].every(Number.isFinite) &&
    expiresAt - issuedAt === 5_000 && issuedAt <= claimedAt && claimedAt <= consumedAt &&
    consumedAt < expiresAt;
}

function validSinkReceipt(receipt, capability, expectedState) {
  const expectedKeys = [
    "action", "agentId", "boundary", "broker", "bytesCommitted", "closeDisposition", "closedAt",
    "committedAt", "errorCode", "expiresAt", "failedAt", "grantSha256", "issuedAt", "parentGrantSha256",
    "payloadSha256", "policy", "policyDigest", "policyVersion", "relativePath", "runId", "spentAt", "state",
    "targetClass", "version", "workspaceRootIdentitySha256",
  ];
  if (!receipt || !capability || typeof receipt !== "object" || Array.isArray(receipt) ||
      Object.keys(receipt).sort().join(",") !== expectedKeys.sort().join(",") ||
      receipt.version !== 1 || receipt.broker !== "process-local" || receipt.state !== expectedState ||
      receipt.runId !== capability.runId || receipt.agentId !== capability.agentId ||
      receipt.action !== capability.action || receipt.targetClass !== capability.targetClass ||
      receipt.policy !== capability.policy || receipt.policyVersion !== capability.policyVersion ||
      receipt.policyDigest !== capability.policyDigest || receipt.relativePath !== effectSinkDemoResultPath ||
      receipt.payloadSha256 !== sha256Bytes(Buffer.from(effectSinkDemoResultPayload, "utf8")) ||
      receipt.parentGrantSha256 !== sha256Bytes(`nerveloop.effect-sink.parent.v1\0${capability.grantId}`) ||
      !isSha256(receipt.grantSha256) || !isSha256(receipt.parentGrantSha256) ||
      !isSha256(receipt.workspaceRootIdentitySha256) || Object.hasOwn(receipt, "grant") ||
      !/not durable, cross-process, kernel-confined, or proof against a concurrent ancestor-swap TOCTOU/i.test(receipt.boundary)) {
    return false;
  }
  const issuedAt = Date.parse(receipt.issuedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > 5_000) {
    return false;
  }
  if (expectedState === "committed") {
    const spentAt = Date.parse(receipt.spentAt);
    const committedAt = Date.parse(receipt.committedAt);
    return Number.isFinite(spentAt) && Number.isFinite(committedAt) &&
      issuedAt <= spentAt && spentAt <= committedAt && committedAt < expiresAt &&
      receipt.failedAt === null && receipt.closedAt === null && receipt.closeDisposition === null &&
      receipt.bytesCommitted === Buffer.byteLength(effectSinkDemoResultPayload, "utf8") && receipt.errorCode === null;
  }
  if (expectedState === "revoked") {
    const closedAt = Date.parse(receipt.closedAt);
    return receipt.spentAt === null && receipt.committedAt === null && receipt.failedAt === null &&
      Number.isFinite(closedAt) && closedAt >= issuedAt && receipt.closeDisposition === "unredeemed" &&
      receipt.bytesCommitted === null && receipt.errorCode === "EFFECT_SINK_CLOSED";
  }
  return false;
}

export function validateTrackCReceipt(receipt) {
  exactKeys(receipt, ["capturedAtUtc", "implementation", "kind", "proofBoundary", "receiptPayloadSha256", "schemaVersion", "sequence", "stableFallback", "track", "verdict"], "TRACK_C_RECEIPT_SHAPE_INVALID");
  if (receipt.schemaVersion !== "nerveloop.track-c-functional-flow.v3" ||
      receipt.kind !== "local-no-model-effect-firewall-and-runguard-flow" ||
      receipt.track !== officialTrack || receipt.verdict !== "PASS" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(receipt.capturedAtUtc)) {
    throw new Error("TRACK_C_RECEIPT_IDENTITY_INVALID");
  }
  assertBoundary(receipt);
  if (!isSha256(receipt.receiptPayloadSha256) || computeReceiptPayloadSha256(receipt) !== receipt.receiptPayloadSha256) {
    throw new Error("TRACK_C_RECEIPT_PAYLOAD_HASH_INVALID");
  }

  const implementation = receipt.implementation;
  if (implementation.service !== "AgentService" ||
      implementation.fixture !== "TrackCKillSwitchFixture extends FixtureRunner" ||
      implementation.guard !== "RunGuard" || implementation.effectPolicy !== "Effect Firewall v1" ||
      implementation.effectSink !== "ProcessLocalEffectSinkBroker" ||
      implementation.sandboxMode !== "workspace-write" || implementation.sameAgentSequence !== true ||
      implementation.providerDispatch !== false ||
      JSON.stringify(implementation.enforcementPhases) !== JSON.stringify(["pre-dispatch typed effect denial", "cooperative exact sink redemption", "post-run verification and rollback"]) ||
      Object.keys(implementation.sourceSha256).sort().join(",") !== "agentService,effectCapability,effectPolicy,effectSink,fixtureRunner,harness,runGuard" ||
      !Object.values(implementation.sourceSha256).every(isSha256)) {
    throw new Error("TRACK_C_IMPLEMENTATION_INVALID");
  }

  const { normalRun, effectFirewallDeniedRun, postRunMaliciousRun, boundedRollbackCleanup, laterFreshSafeRun, protectedState, workerDispatch } = receipt.sequence;
  assertOrdinaryRetainedRun(normalRun, "TRACK_C_NORMAL_RUN_INVALID");
  const effect = effectFirewallDeniedRun.effectDecision;
  if (effectFirewallDeniedRun.status !== "failed" || effectFirewallDeniedRun.outputPublished !== false ||
      effectFirewallDeniedRun.guardVerdict !== "denied" || effectFirewallDeniedRun.recovery !== "not_needed" ||
      effectFirewallDeniedRun.providerDispatch !== false || effectFirewallDeniedRun.workerDispatchDelta !== 0 ||
      effectFirewallDeniedRun.changedFiles.length !== 0 ||
      effectFirewallDeniedRun.beforeManifestDigest !== effectFirewallDeniedRun.afterManifestDigest ||
      effectFirewallDeniedRun.recoveredManifestDigest !== null || !effect || effect.policy !== "effect-firewall-v1" ||
      effect.verdict !== "denied" || effect.action !== "delete_mock_asset" || effect.targetClass !== "protected" ||
      effect.reason !== "protected_target_denied" || effect.workerSpawned !== false ||
      effect.protectedBaselineVerifiedUnchanged !== true || effectFirewallDeniedRun.effectCapability !== null ||
      effectFirewallDeniedRun.effectSinkReceipt !== null) {
    throw new Error("TRACK_C_EFFECT_FIREWALL_RUN_INVALID");
  }

  if (postRunMaliciousRun.status !== "failed" || postRunMaliciousRun.outputPublished !== false ||
      postRunMaliciousRun.guardVerdict !== "denied" || postRunMaliciousRun.recovery !== "rolled_back" ||
      postRunMaliciousRun.providerDispatch !== false || postRunMaliciousRun.workerDispatchDelta !== 1 ||
      postRunMaliciousRun.effectDecision !== null || postRunMaliciousRun.changedFiles.includes(".env") ||
      !postRunMaliciousRun.changedFiles.includes("[redacted protected path]") ||
      !postRunMaliciousRun.changedFiles.includes(scratchName) ||
      !validConsumedCapability(postRunMaliciousRun.effectCapability, postRunMaliciousRun.runId) ||
      !validSinkReceipt(postRunMaliciousRun.effectSinkReceipt, postRunMaliciousRun.effectCapability, "revoked")) {
    throw new Error("TRACK_C_POST_RUN_ROLLBACK_INVALID");
  }
  if (boundedRollbackCleanup.checkpointRestored !== true || boundedRollbackCleanup.protectedBytesRestored !== true ||
      boundedRollbackCleanup.scratchArtifactRemoved !== true || boundedRollbackCleanup.agentReturnedReady !== true ||
      boundedRollbackCleanup.recoveryHoldPresent !== false || boundedRollbackCleanup.childProcessesStarted !== 0 ||
      boundedRollbackCleanup.processCleanupRequired !== false) {
    throw new Error("TRACK_C_CLEANUP_INVALID");
  }
  assertOrdinaryRetainedRun(laterFreshSafeRun, "TRACK_C_LATER_SAFE_RUN_INVALID");
  if (new Set([
    normalRun.effectCapability.grantId,
    postRunMaliciousRun.effectCapability.grantId,
    laterFreshSafeRun.effectCapability.grantId,
  ]).size !== 3) {
    throw new Error("TRACK_C_EFFECT_CAPABILITY_REUSED");
  }
  if (new Set([
    normalRun.effectSinkReceipt.grantSha256,
    postRunMaliciousRun.effectSinkReceipt.grantSha256,
    laterFreshSafeRun.effectSinkReceipt.grantSha256,
  ]).size !== 3) {
    throw new Error("TRACK_C_EFFECT_SINK_GRANT_REUSED");
  }
  if (new Set([normalRun.runId, effectFirewallDeniedRun.runId, postRunMaliciousRun.runId, laterFreshSafeRun.runId]).size !== 4) {
    throw new Error("TRACK_C_RUN_IDS_NOT_FRESH");
  }
  if (!isSha256(protectedState.beforeSha256) || protectedState.beforeSha256 !== protectedState.afterEffectDenialSha256 ||
      protectedState.beforeSha256 !== protectedState.afterRollbackSha256 || protectedState.beforeSha256 !== protectedState.finalSha256 ||
      protectedState.bytesIdenticalAfterEffectDenial !== true || protectedState.bytesIdenticalAfterRollback !== true ||
      protectedState.bytesIdenticalAtEnd !== true || protectedState.contentsRecorded !== false) {
    throw new Error("TRACK_C_PROTECTED_STATE_INVALID");
  }
  if (workerDispatch.initialCount !== 0 || workerDispatch.afterNormal !== 1 || workerDispatch.afterEffectDenial !== 1 ||
      workerDispatch.afterPostRunRollback !== 2 || workerDispatch.afterLaterSafe !== 3 ||
      workerDispatch.effectDenialDispatchDelta !== 0) {
    throw new Error("TRACK_C_WORKER_DISPATCH_COUNTER_INVALID");
  }
  if (receipt.stableFallback.path !== stableFallbackRelative || !isSha256(receipt.stableFallback.beforeSha256) ||
      receipt.stableFallback.beforeSha256 !== receipt.stableFallback.afterSha256 || receipt.stableFallback.unchanged !== true ||
      receipt.stableFallback.overwritten !== false) {
    throw new Error("TRACK_C_STABLE_FALLBACK_CHANGED");
  }
  return receipt;
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
}

async function pathAbsent(filePath) {
  try {
    await access(filePath);
    return false;
  } catch (error) {
    if (error && error.code === "ENOENT") return true;
    throw error;
  }
}

async function waitForTerminal(service, runId, agentId) {
  const deadline = Date.now() + 15_000;
  let terminalRun = null;
  while (Date.now() < deadline) {
    const run = service.getRun(runId);
    if (["completed", "failed", "cancelled"].includes(run.status)) {
      terminalRun = run;
    }
    if (terminalRun && service.getAgent(agentId).status !== "busy" && service.runCapacity().inUse === 0) {
      return terminalRun;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("TRACK_C_RUN_TIMEOUT");
}

function summarizedRun(run, workerDispatchDelta) {
  return {
    runId: run.id,
    status: run.status,
    outputPublished: run.output !== null,
    providerDispatch: false,
    workerDispatchDelta,
    guardVerdict: run.guard?.verdict ?? null,
    recovery: run.guard?.recovery ?? null,
    changedFiles: run.guard?.changedFiles ?? [],
    beforeManifestDigest: run.guard?.beforeManifestDigest ?? null,
    afterManifestDigest: run.guard?.afterManifestDigest ?? null,
    recoveredManifestDigest: run.guard?.recoveredManifestDigest ?? null,
    effectDecision: run.guard?.effectDecision ?? null,
    effectCapability: run.effectCapability ?? null,
    effectSinkReceipt: run.effectSinkReceipt ?? null,
    acceptance: run.acceptance,
  };
}

function requireRun(run, expected) {
  if (run.status !== expected.status || run.guard?.verdict !== expected.verdict ||
      run.guard?.recovery !== expected.recovery || (run.output !== null) !== expected.outputPublished) {
    throw new Error(`TRACK_C_RUN_ASSERTION_FAILED:${JSON.stringify(summarizedRun(run, -1))}`);
  }
}

async function dependencies() {
  const [agentServiceModule, configModule, effectPolicyModule, fixtureModule, storeModule, workspaceModule] = await Promise.all([
    tsImport("../apps/server/src/agent-service.ts", import.meta.url),
    tsImport("../apps/server/src/config.ts", import.meta.url),
    tsImport("../apps/server/src/effect-policy.ts", import.meta.url),
    tsImport("../apps/server/src/fixture-runner.ts", import.meta.url),
    tsImport("../apps/server/src/store.ts", import.meta.url),
    tsImport("../apps/server/src/workspace.ts", import.meta.url),
  ]);
  return {
    AgentService: agentServiceModule.AgentService,
    loadConfig: configModule.loadConfig,
    effectFirewallPrompt: effectPolicyModule.EFFECT_FIREWALL_DEMO_PROMPT,
    FixtureRunner: fixtureModule.FixtureRunner,
    JsonStore: storeModule.JsonStore,
    WorkspaceManager: workspaceModule.WorkspaceManager,
  };
}

export async function runTrackCKillSwitchDemo({ output = defaultOutput } = {}) {
  const stableBefore = await sha256File(stableFallbackPath);
  const sourceSha256 = {
    harness: await sha256File(scriptPath),
    agentService: await sha256File(path.join(launchpadRoot, "apps/server/src/agent-service.ts")),
    effectCapability: await sha256File(path.join(launchpadRoot, "apps/server/src/effect-capability.ts")),
    effectPolicy: await sha256File(path.join(launchpadRoot, "apps/server/src/effect-policy.ts")),
    effectSink: await sha256File(path.join(launchpadRoot, "apps/server/src/effect-sink.ts")),
    fixtureRunner: await sha256File(path.join(launchpadRoot, "apps/server/src/fixture-runner.ts")),
    runGuard: await sha256File(path.join(launchpadRoot, "apps/server/src/run-guard.ts")),
  };
  const temporaryRoot = await realpath(await mkdtemp(path.join(tmpdir(), "nerveloop-track-c-")));
  try {
    const { AgentService, loadConfig, effectFirewallPrompt, FixtureRunner, JsonStore, WorkspaceManager } = await dependencies();
    class TrackCKillSwitchFixture extends FixtureRunner {
      calls = 0;
      safeOrdinal = 0;

      async run(request) {
        this.calls += 1;
        const isRollbackAttack = request.prompt === rollbackAttackPrompt;
        const result = await super.run(request);
        if (isRollbackAttack) {
          await writeFile(path.join(request.workspacePath, scratchName), "fixture-only disposable output; rollback must remove this file\n", { encoding: "utf8", mode: 0o600 });
          return { ...result, output: "Fixture output must be withheld after policy denial." };
        }
        this.safeOrdinal += 1;
        await writeFile(path.join(request.workspacePath, `safe-run-${this.safeOrdinal}.txt`), `bounded local fixture Run ${this.safeOrdinal}\n`, { encoding: "utf8", mode: 0o600 });
        return { ...result, output: `Bounded local fixture Run ${this.safeOrdinal} completed.` };
      }
    }

    const codexHome = path.join(temporaryRoot, "codex-home");
    await mkdir(codexHome, { mode: 0o700 });
    const config = loadConfig({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      LOG_LEVEL: "silent",
      DEMO_RUNNER: "1",
      MAX_CONCURRENT_RUNS: "1",
      APP_DATA_DIR: path.join(temporaryRoot, "data"),
      AGENT_WORKSPACE_ROOT: path.join(temporaryRoot, "workspaces"),
      CODEX_HOME: codexHome,
      CODEX_SANDBOX_MODE: "workspace-write",
      CODEX_TIMEOUT_MS: "15000",
    });
    const runner = new TrackCKillSwitchFixture();
    const service = new AgentService(config, new JsonStore(path.join(config.dataDirectory, "launchpad.json")), new WorkspaceManager(config.workspaceRoot), runner);
    await service.initialize();
    const agent = await service.createAgent({
      name: "Track 1 deterministic fixture",
      description: "Local no-model pre-dispatch denial and rollback sequence.",
      instructions: "Execute only the fixed local fixture sequence.",
    });
    const protectedFixturePath = path.join(agent.workspacePath, ".env");
    const scratchPath = path.join(agent.workspacePath, scratchName);
    await writeFile(protectedFixturePath, protectedFixtureBytes, { mode: 0o600 });
    const protectedBefore = await readFile(protectedFixturePath);
    const protectedBeforeSha256 = sha256Bytes(protectedBefore);
    const dispatch = { initialCount: runner.calls };

    const normalBeforeCalls = runner.calls;
    const normalAdmission = await service.sendMessage(agent.id, normalPrompt);
    const normalRun = await waitForTerminal(service, normalAdmission.run.id, agent.id);
    requireRun(normalRun, { status: "completed", verdict: "retained", recovery: "not_needed", outputPublished: true });
    dispatch.afterNormal = runner.calls;

    const effectBeforeCalls = runner.calls;
    const effectAdmission = await service.sendMessage(agent.id, effectFirewallPrompt);
    const effectFirewallDeniedRun = await waitForTerminal(service, effectAdmission.run.id, agent.id);
    requireRun(effectFirewallDeniedRun, { status: "failed", verdict: "denied", recovery: "not_needed", outputPublished: false });
    dispatch.afterEffectDenial = runner.calls;
    const protectedAfterEffectDenial = await readFile(protectedFixturePath);
    if (runner.calls !== effectBeforeCalls || effectFirewallDeniedRun.guard?.effectDecision?.workerSpawned !== false ||
        effectFirewallDeniedRun.guard?.effectDecision?.protectedBaselineVerifiedUnchanged !== true ||
        effectFirewallDeniedRun.guard?.beforeManifestDigest !== effectFirewallDeniedRun.guard?.afterManifestDigest ||
        !protectedAfterEffectDenial.equals(protectedBefore)) {
      throw new Error("TRACK_C_PRE_DISPATCH_EFFECT_DENIAL_FAILED");
    }

    const rollbackBeforeCalls = runner.calls;
    const rollbackAdmission = await service.sendMessage(agent.id, rollbackAttackPrompt);
    const postRunMaliciousRun = await waitForTerminal(service, rollbackAdmission.run.id, agent.id);
    requireRun(postRunMaliciousRun, { status: "failed", verdict: "denied", recovery: "rolled_back", outputPublished: false });
    dispatch.afterPostRunRollback = runner.calls;
    if (runner.calls - rollbackBeforeCalls !== 1 || postRunMaliciousRun.guard?.changedFiles.includes(".env") ||
        !postRunMaliciousRun.guard?.changedFiles.includes("[redacted protected path]") ||
        !postRunMaliciousRun.guard?.changedFiles.includes(scratchName)) {
      throw new Error("TRACK_C_DENIAL_REDACTION_OR_CLEANUP_EVIDENCE_MISSING");
    }
    const protectedAfterRollback = await readFile(protectedFixturePath);
    const scratchRemoved = await pathAbsent(scratchPath);
    const agentAfterRollback = service.getAgent(agent.id);
    if (!protectedAfterRollback.equals(protectedBefore) || !scratchRemoved || agentAfterRollback.status !== "ready" ||
        agentAfterRollback.recoveryHold !== null ||
        postRunMaliciousRun.guard.recoveredManifestDigest !== postRunMaliciousRun.guard.beforeManifestDigest) {
      throw new Error("TRACK_C_BOUNDED_RESTORATION_FAILED");
    }

    const laterSafeBeforeCalls = runner.calls;
    const safeAdmission = await service.sendMessage(agent.id, laterSafePrompt);
    const laterFreshSafeRun = await waitForTerminal(service, safeAdmission.run.id, agent.id);
    requireRun(laterFreshSafeRun, { status: "completed", verdict: "retained", recovery: "not_needed", outputPublished: true });
    dispatch.afterLaterSafe = runner.calls;
    dispatch.effectDenialDispatchDelta = dispatch.afterEffectDenial - effectBeforeCalls;
    if (runner.calls - laterSafeBeforeCalls !== 1 || runner.calls - normalBeforeCalls !== 3) {
      throw new Error("TRACK_C_WORKER_DISPATCH_COUNT_MISMATCH");
    }
    const protectedFinal = await readFile(protectedFixturePath);
    if (!protectedFinal.equals(protectedBefore) || !(await pathAbsent(scratchPath))) {
      throw new Error("TRACK_C_FINAL_PROTECTED_STATE_CHANGED");
    }

    const stableAfter = await sha256File(stableFallbackPath);
    if (stableAfter !== stableBefore) throw new Error("TRACK_C_STABLE_FALLBACK_CHANGED");
    const baseReceipt = {
      schemaVersion: "nerveloop.track-c-functional-flow.v3",
      kind: "local-no-model-effect-firewall-and-runguard-flow",
      track: officialTrack,
      capturedAtUtc: new Date().toISOString(),
      verdict: "PASS",
      implementation: {
        service: "AgentService",
        fixture: "TrackCKillSwitchFixture extends FixtureRunner",
        guard: "RunGuard",
        effectPolicy: "Effect Firewall v1",
        effectSink: "ProcessLocalEffectSinkBroker",
        sandboxMode: "workspace-write",
        enforcementPhases: ["pre-dispatch typed effect denial", "cooperative exact sink redemption", "post-run verification and rollback"],
        sameAgentSequence: true,
        providerDispatch: false,
        sourceSha256,
      },
      sequence: {
        normalRun: summarizedRun(normalRun, dispatch.afterNormal - normalBeforeCalls),
        effectFirewallDeniedRun: summarizedRun(effectFirewallDeniedRun, dispatch.afterEffectDenial - effectBeforeCalls),
        postRunMaliciousRun: summarizedRun(postRunMaliciousRun, dispatch.afterPostRunRollback - rollbackBeforeCalls),
        boundedRollbackCleanup: {
          checkpointRestored: postRunMaliciousRun.guard.recoveredManifestDigest === postRunMaliciousRun.guard.beforeManifestDigest,
          protectedBytesRestored: protectedAfterRollback.equals(protectedBefore),
          scratchArtifactRemoved: scratchRemoved,
          agentReturnedReady: agentAfterRollback.status === "ready",
          recoveryHoldPresent: agentAfterRollback.recoveryHold !== null,
          childProcessesStarted: 0,
          processCleanupRequired: false,
        },
        laterFreshSafeRun: summarizedRun(laterFreshSafeRun, dispatch.afterLaterSafe - laterSafeBeforeCalls),
        protectedState: {
          label: "credential-like protected fixture",
          beforeSha256: protectedBeforeSha256,
          afterEffectDenialSha256: sha256Bytes(protectedAfterEffectDenial),
          afterRollbackSha256: sha256Bytes(protectedAfterRollback),
          finalSha256: sha256Bytes(protectedFinal),
          bytesIdenticalAfterEffectDenial: protectedAfterEffectDenial.equals(protectedBefore),
          bytesIdenticalAfterRollback: protectedAfterRollback.equals(protectedBefore),
          bytesIdenticalAtEnd: protectedFinal.equals(protectedBefore),
          contentsRecorded: false,
        },
        workerDispatch: dispatch,
      },
      stableFallback: {
        path: stableFallbackRelative,
        beforeSha256: stableBefore,
        afterSha256: stableAfter,
        unchanged: stableBefore === stableAfter,
        overwritten: false,
      },
      proofBoundary: {
        localOnly: true,
        modelExecuted: false,
        providerCalls: false,
        cooperativeFixtureSinkMediation: true,
        ambientFilesystemAuthorityRemoved: false,
        hardenedSandbox: false,
        productionIsolation: false,
        tiktokAccess: false,
      },
    };
    const receipt = { ...baseReceipt, receiptPayloadSha256: sha256Bytes(Buffer.from(canonicalJson(baseReceipt), "utf8")) };
    validateTrackCReceipt(receipt);
    const serialized = JSON.stringify(receipt);
    if (serialized.includes(temporaryRoot) || serialized.includes(agent.workspacePath)) throw new Error("TRACK_C_TEMPORARY_PATH_LEAK");
    await atomicWriteJson(path.resolve(output), receipt);
    return { receipt, output: path.resolve(output) };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function verifyReceipt(filePath) {
  const receipt = JSON.parse(await readFile(path.resolve(filePath), "utf8"));
  validateTrackCReceipt(receipt);
  return receipt;
}

function argumentValue(name) {
  const marker = process.argv.indexOf(name);
  if (marker === -1) return null;
  const value = process.argv[marker + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

async function main() {
  const verifyPath = argumentValue("--verify-receipt");
  if (verifyPath) {
    const receipt = await verifyReceipt(verifyPath);
    process.stdout.write(`${JSON.stringify({ verdict: "PASS", mode: "verify-receipt", receiptPayloadSha256: receipt.receiptPayloadSha256, boundary: "local no-model receipt verification; not deployment or hardened isolation" }, null, 2)}\n`);
    return;
  }
  const output = argumentValue("--output") ?? defaultOutput;
  const result = await runTrackCKillSwitchDemo({ output });
  process.stdout.write(`${JSON.stringify({
    verdict: "PASS",
    track: result.receipt.track,
    output: result.output,
    runs: {
      normal: result.receipt.sequence.normalRun.status,
      effectFirewallDenied: result.receipt.sequence.effectFirewallDeniedRun.status,
      postRunRollback: result.receipt.sequence.postRunMaliciousRun.status,
      laterSafe: result.receipt.sequence.laterFreshSafeRun.status,
    },
    effectFirewall: result.receipt.sequence.effectFirewallDeniedRun.effectDecision,
    rollback: result.receipt.sequence.boundedRollbackCleanup,
    effectSink: {
      normal: result.receipt.sequence.normalRun.effectSinkReceipt.state,
      effectFirewallDenied: result.receipt.sequence.effectFirewallDeniedRun.effectSinkReceipt,
      postRunRollback: result.receipt.sequence.postRunMaliciousRun.effectSinkReceipt.state,
      laterSafe: result.receipt.sequence.laterFreshSafeRun.effectSinkReceipt.state,
    },
    stableFallbackSha256: result.receipt.stableFallback.afterSha256,
    receiptPayloadSha256: result.receipt.receiptPayloadSha256,
    boundary: "local no-model AgentService fixture; not a hardened sandbox, production isolation, or TikTok access",
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) await main();
