import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const childScript = path.join(here, "child-stubborn.mjs");
const receiptPath = path.join(here, "receipt.jsonl");
const nonce = `procproof-${crypto.randomUUID()}`;
const startedAt = new Date().toISOString();
const escalationWindowMs = 350;
const exitTimeoutMs = 1_500;

const receipt = {
  schemaVersion: 1,
  experiment: "owned-child-bounded-termination",
  scope: "standalone process-lifecycle evidence only",
  startedAt,
  invocation: {
    shellCommand: "node ./run-process-termination-proof.mjs",
    execPath: process.execPath,
    argv: process.argv,
  },
  limits: {
    spawnedTargetChildren: 1,
    escalationWindowMs,
    exitTimeoutMs,
    childSelfExitBackstopMs: 5_000,
    network: false,
    credentials: false,
    provider: false,
    servicePort: false,
  },
  relatedProductHarnessEvidence: {
    source: "independent parent-run result; not executed by this experiment",
    label: "product fake-CLI process cleanup evidence",
    command:
      "npm run test -w @launchpad/server -- src/crash-recovery.test.ts",
    observedAt: "2026-09-01T11:41:14+08:00",
    exitCode: 0,
    testFiles: "1/1",
    tests: "3/3",
    durationSeconds: 10.68,
    testDurationSeconds: 10.57,
    boundary: "not Ark or provider-backed evidence",
  },
  events: [],
};

let child;
let targetPid;
let exitPromise;
let exitResult;
const messages = [];
let stdout = "";
let stderr = "";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function record(type, fields = {}) {
  receipt.events.push({ at: new Date().toISOString(), type, ...fields });
}

function waitForMessage(predicate, timeoutMs, label) {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", onMessage);
      reject(new Error(`${label} timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    function onMessage(message) {
      if (!predicate(message)) return;
      clearTimeout(timer);
      child.off("message", onMessage);
      resolve(message);
    }

    child.on("message", onMessage);
  });
}

function sendIpc(message) {
  return new Promise((resolve, reject) => {
    child.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

async function verifyIdentity(stage) {
  assert(Number.isSafeInteger(targetPid) && targetPid > 1, `${stage}: invalid PID`);
  assert(child.pid === targetPid, `${stage}: ChildProcess PID changed`);
  assert(child.spawnfile === process.execPath, `${stage}: spawnfile mismatch`);
  assert(child.spawnargs[1] === childScript, `${stage}: child script mismatch`);
  assert(child.spawnargs[2] === nonce, `${stage}: nonce argv mismatch`);
  assert(child.exitCode === null, `${stage}: child already has an exit code`);
  assert(child.signalCode === null, `${stage}: child already has a signal code`);
  assert(child.connected, `${stage}: IPC ownership channel is closed`);

  process.kill(targetPid, 0);

  const challengeId = crypto.randomUUID();
  await sendIpc({ type: "identity_challenge", challengeId, nonce });
  const response = await waitForMessage(
    (message) =>
      message?.type === "identity_response" &&
      message.challengeId === challengeId,
    250,
    `${stage} identity response`,
  );

  assert(response.nonce === nonce, `${stage}: response nonce mismatch`);
  assert(response.pid === targetPid, `${stage}: response PID mismatch`);
  assert(response.ppid === process.pid, `${stage}: response parent PID mismatch`);

  const result = {
    stage,
    targetPid,
    reportedParentPid: response.ppid,
    expectedParentPid: process.pid,
    nonceMatched: true,
    spawnfileMatched: true,
    spawnargsMatched: true,
    ipcChallengeMatched: true,
    killZeroAliveCheck: true,
    sigtermCount: response.sigtermCount,
  };
  record("identity_verified", result);
  return result;
}

function appendReceipt() {
  fs.appendFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, {
    encoding: "utf8",
    flag: "a",
  });
}

async function main() {
  child = spawn(process.execPath, [childScript, nonce], {
    detached: false,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  targetPid = child.pid;
  assert(Number.isSafeInteger(targetPid), "spawn did not return a numeric PID");

  receipt.parent = { pid: process.pid, ppid: process.ppid };
  receipt.childSpawn = {
    api: "spawn(process.execPath, [childScript, nonce], { detached: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })",
    execPath: process.execPath,
    childScript,
    nonce,
    pid: targetPid,
    expectedParentPid: process.pid,
  };

  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.on("message", (message) => messages.push(message));
  exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exitResult = { code, signal, at: new Date().toISOString() };
      resolve(exitResult);
    });
  });

  const ready = await waitForMessage(
    (message) => message?.type === "ready",
    1_000,
    "child ready",
  );
  assert(ready.nonce === nonce, "ready nonce mismatch");
  assert(ready.pid === targetPid, "ready PID mismatch");
  assert(ready.ppid === process.pid, "ready parent PID mismatch");
  record("child_ready", {
    targetPid,
    reportedParentPid: ready.ppid,
    expectedParentPid: process.pid,
  });

  receipt.identityBeforeSigterm = await verifyIdentity("before_sigterm");

  const sigtermAtMs = Date.now();
  const sigtermAccepted = child.kill("SIGTERM");
  assert(sigtermAccepted, "child.kill(SIGTERM) returned false");
  record("signal_sent", {
    api: "child.kill('SIGTERM')",
    signal: "SIGTERM",
    targetPid,
  });

  const sigtermObserved = await waitForMessage(
    (message) =>
      message?.type === "sigterm_observed" &&
      message.nonce === nonce &&
      message.pid === targetPid,
    250,
    "SIGTERM observation",
  );
  assert(sigtermObserved.ppid === process.pid, "SIGTERM observer parent mismatch");
  record("sigterm_observed_by_child", {
    targetPid,
    reportedParentPid: sigtermObserved.ppid,
    sigtermCount: sigtermObserved.sigtermCount,
  });

  const remainingWindowMs = Math.max(0, escalationWindowMs - (Date.now() - sigtermAtMs));
  const earlyExit = await Promise.race([
    exitPromise,
    delay(remainingWindowMs).then(() => null),
  ]);

  receipt.escalation = {
    waitedMs: escalationWindowMs,
    childExitedWithinWindow: Boolean(earlyExit),
    needed: !earlyExit,
  };

  if (!earlyExit) {
    receipt.identityBeforeSigkill = await verifyIdentity("before_sigkill");
    const sigkillAccepted = child.kill("SIGKILL");
    assert(sigkillAccepted, "child.kill(SIGKILL) returned false");
    record("signal_sent", {
      api: "child.kill('SIGKILL')",
      signal: "SIGKILL",
      targetPid,
      reason: `child remained alive after ${escalationWindowMs} ms`,
    });
  }

  const finalExit =
    earlyExit ??
    (await Promise.race([
      exitPromise,
      delay(exitTimeoutMs).then(() => {
        throw new Error(`child exit timed out after ${exitTimeoutMs} ms`);
      }),
    ]));

  await delay(25);
  let pidStillAlive = false;
  let killZeroError;
  try {
    process.kill(targetPid, 0);
    pidStillAlive = true;
  } catch (error) {
    killZeroError = error?.code ?? String(error);
  }

  assert(!pidStillAlive, "exact child PID still exists after observed exit");
  assert(killZeroError === "ESRCH", `expected ESRCH, received ${killZeroError}`);
  assert(finalExit === exitResult, "exit event identity mismatch");
  if (receipt.escalation.needed) {
    assert(finalExit.signal === "SIGKILL", `expected SIGKILL exit, got ${finalExit.signal}`);
  }

  receipt.result = {
    verdict: "PASS",
    targetPid,
    exit: finalExit,
    expectedEscalationSignal: receipt.escalation.needed ? "SIGKILL" : null,
    exactPidAliveAfterExit: pidStillAlive,
    killZeroAfterExitError: killZeroError,
    orphanCheck: "exit event observed and exact PID returned ESRCH",
    stdout,
    stderr,
  };
  receipt.completedAt = new Date().toISOString();
  receipt.proofBoundary =
    "One owned local child only; process lifecycle evidence, not Ark, product integration, sandbox strength, or production security.";
  appendReceipt();
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

main().catch(async (error) => {
  receipt.result = {
    verdict: "FAIL",
    error: error?.stack ?? String(error),
    targetPid,
    identityAmbiguous: /mismatch|invalid PID|ownership|identity/i.test(
      error?.message ?? "",
    ),
    signalPolicy:
      "No SIGKILL is sent after an identity-check failure; the child self-exits on IPC disconnect or its five-second backstop.",
  };
  receipt.completedAt = new Date().toISOString();

  if (child?.connected) child.disconnect();
  if (exitPromise) {
    await Promise.race([exitPromise, delay(5_500)]);
  }

  appendReceipt();
  process.stderr.write(`${JSON.stringify(receipt, null, 2)}\n`);
  process.exitCode = 1;
});
