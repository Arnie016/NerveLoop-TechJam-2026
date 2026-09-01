import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import {
  computeSinkLabReceiptSha256,
  parseSinkLabArguments,
  runSinkRedemptionLab,
  validateSinkLabReceipt,
} from "./effect-sink-redemption-lab.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const scriptPath = path.join(scriptDirectory, "effect-sink-redemption-lab.mjs");
let receipt;
let temporaryRoot;

before(async () => {
  receipt = await runSinkRedemptionLab();
  temporaryRoot = await mkdtemp(path.join(tmpdir(), "nerveloop-sink-lab-test-"));
});

after(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

test("attenuates the current 20-cell lattice to one exact filesystem sink scope", () => {
  const lattice = receipt.results.lattice;
  assert.equal(lattice.totalCells, 20);
  assert.equal(lattice.allowed, 6);
  assert.equal(lattice.denied, 14);
  assert.equal(lattice.deniedCapabilitiesIssued, 0);
  assert.equal(lattice.allowedCapabilitiesConsumed, 6);
  assert.equal(lattice.sinkMintable, 1);
  assert.equal(lattice.broaderAllowedScopesRejectedBySink, 5);
  assert.equal(lattice.outcomes.filter((item) => item.sinkResult === "minted").length, 1);
  assert.deepEqual(
    lattice.outcomes.find((item) => item.sinkResult === "minted"),
    {
      action: "write_demo_result",
      targetClass: "workspace",
      decision: "allowed",
      capabilityState: "consumed",
      sinkResult: "minted",
    },
  );
});

test("rejects every declared envelope and request-context mutation without spending the valid grant", () => {
  const matrix = receipt.results.tamperMatrix;
  assert.equal(matrix.envelopeFieldsMutated, 15);
  assert.equal(matrix.envelopeMutationCombinations, 32_767);
  assert.equal(matrix.envelopeMutationsRejected, 32_767);
  assert.equal(matrix.envelopeMutationEscapes, 0);
  assert.equal(matrix.contextualFieldsMutated, 6);
  assert.equal(matrix.contextualMutationCombinations, 63);
  assert.equal(matrix.contextualMutationsRejected, 63);
  assert.equal(matrix.contextualMutationEscapes, 0);
  assert.equal(matrix.stateBeforeValid, "dispatch_ready");
  assert.equal(matrix.validWrite.bytesWritten, 55);
  assert.equal(matrix.finalState, "redeemed");
  assert.equal(matrix.replayError, "SINK_CAPABILITY_ALREADY_REDEEMED");
});

test("has one linearization winner across 64 concurrent redemptions", () => {
  const concurrency = receipt.results.concurrency;
  assert.equal(concurrency.attempts, 64);
  assert.equal(concurrency.successes, 1);
  assert.equal(concurrency.rejections, 63);
  assert.deepEqual(concurrency.rejectionCodes, {
    SINK_CAPABILITY_ALREADY_REDEEMED: 63,
  });
  assert.equal(concurrency.finalState, "redeemed");
});

test("fails closed at the expiry boundary and on a pre-existing symlink", () => {
  assert.deepEqual(receipt.results.expiry, {
    exactBoundaryRejected: true,
    error: "SINK_CAPABILITY_EXPIRED",
    fileCreated: false,
    state: "dispatch_ready",
    sinkExpiresNoLaterThanParent: true,
    sinkTtlMs: 10,
  });
  assert.deepEqual(receipt.results.symlinkFault, {
    effectError: "SINK_EFFECT_FAILED",
    externalSentinelUnchanged: true,
    destinationStillSymlink: true,
    stateAfterFault: "failed_closed",
    retryError: "SINK_CAPABILITY_ALREADY_REDEEMED",
    failStopSpentGrant: true,
  });
});

test("derives one child per parent and rejects deterministic workspace-root replacement", () => {
  assert.deepEqual(receipt.results.parentDerivation, {
    firstChildState: "dispatch_ready",
    secondMintError: "SINK_PARENT_ALREADY_DERIVED",
    oneParentOneChild: true,
  });
  assert.deepEqual(receipt.results.rootReplacement, {
    error: "SINK_ROOT_CHANGED",
    externalFileCreated: false,
    stateAfterFault: "failed_closed",
    retryError: "SINK_CAPABILITY_ALREADY_REDEEMED",
    deterministicReplacementRejected: true,
  });
});

test("snapshots mutable caller bytes before the first asynchronous boundary", () => {
  const result = receipt.results.mutablePayload;
  assert.notEqual(result.mutatedCallerSha256, result.originalSha256);
  assert.equal(result.writtenSha256, result.originalSha256);
  assert.equal(result.receiptSha256, result.originalSha256);
  assert.equal(result.callerMutationDidNotChangeWrite, true);
});

test("seals the independent capability lifecycle oracle counts", () => {
  assert.deepEqual(receipt.results.capabilityLifecycle, {
    alphabet: ["claim_valid", "claim_binding_drift", "consume_valid"],
    maximumTraceLength: 4,
    traces: 120,
    operations: 426,
    mismatches: 0,
    maximumSuccessfulClaims: 1,
    maximumSuccessfulConsumes: 1,
  });
  assert.equal(receipt.gates.capabilityLifecycleMatchesIndependentOracle, true);
});

test("seals the receipt, binds current sources, and rejects re-sealed false evidence", async () => {
  assert.equal(validateSinkLabReceipt(receipt), receipt);
  assert.equal(receipt.verdict, "PASS");
  assert.equal(receipt.schemaVersion, "nerveloop.effect-sink-redemption-lab.v3");
  assert.equal(receipt.officialTrack,
    "Track #1: Agent Launchpad: Design and Build Lightweight Agent Middleware");
  for (const binding of Object.values(receipt.sourceBindings)) {
    const actual = createHash("sha256")
      .update(await readFile(path.join(projectRoot, binding.path)))
      .digest("hex");
    assert.equal(binding.sha256, actual, binding.path);
  }

  const tampered = structuredClone(receipt);
  tampered.results.concurrency.successes = 2;
  tampered.receiptPayloadSha256 = computeSinkLabReceiptSha256(tampered);
  assert.throws(() => validateSinkLabReceipt(tampered), /SINK_LAB_CONCURRENCY_INVALID/);
});

test("keeps the CLI bounded", () => {
  assert.deepEqual(parseSinkLabArguments([
    "--write-evidence",
    "--json",
    "--output-dir",
    "/tmp/nerveloop-sink-evidence",
  ]), {
    writeEvidence: true,
    jsonOnly: true,
    outputDirectory: "/tmp/nerveloop-sink-evidence",
  });
  assert.throws(() => parseSinkLabArguments(["--rounds", "100"]), /UNKNOWN_ARGUMENT/);
  assert.throws(() => parseSinkLabArguments(["--output-dir"]), /--output-dir_REQUIRES_VALUE/);
});

test("writes a human research receipt and machine-verifiable evidence", async () => {
  const outputDirectory = path.join(temporaryRoot, "evidence");
  const completed = await execFileAsync(process.execPath, [
    scriptPath,
    "--write-evidence",
    "--output-dir",
    outputDirectory,
    "--json",
  ], {
    cwd: projectRoot,
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const output = JSON.parse(completed.stdout);
  assert.equal(validateSinkLabReceipt(output.receipt), output.receipt);
  assert.equal(output.evidence.outputDirectory, outputDirectory);
  const written = JSON.parse(await readFile(path.join(outputDirectory, "results.json"), "utf8"));
  assert.equal(validateSinkLabReceipt(written), written);
  const readme = await readFile(path.join(outputDirectory, "README.md"), "utf8");
  assert.match(readme, /sink-side effect redemption/i);
  assert.match(readme, /32767\/32767 rejected/);
  assert.match(readme, /lab harness does \*\*not execute the product broker\*\*/i);
  assert.match(readme, /ambient Node filesystem authority/i);
  assert.match(readme, /https:\/\/arxiv\.org\/abs\/2608\.27646/);
  assert.match(readme, /https:\/\/www\.usenix\.org\/conference\/usenixsecurity10/);
  assert.match(readme, /https:\/\/www\.ndss-symposium\.org\/ndss2014/);
  assert.match(readme, /https:\/\/www\.microsoft\.com\/en-us\/research/);

  const falseReceipt = structuredClone(written);
  falseReceipt.results.tamperMatrix.envelopeMutationEscapes = 1;
  falseReceipt.receiptPayloadSha256 = computeSinkLabReceiptSha256(falseReceipt);
  const falsePath = path.join(outputDirectory, "false.json");
  await writeFile(falsePath, `${JSON.stringify(falseReceipt, null, 2)}\n`, "utf8");
  const reloadedFalseReceipt = JSON.parse(await readFile(falsePath, "utf8"));
  assert.throws(() => validateSinkLabReceipt(reloadedFalseReceipt),
    /SINK_LAB_TAMPER_MATRIX_INVALID/);
});
