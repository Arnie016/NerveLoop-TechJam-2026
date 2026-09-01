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
  computeReceiptPayloadSha256,
  DECLARED_SPEC,
  parseArguments,
  runAdversarialMatrix,
  validateReceipt,
} from "./effect-firewall-adversarial-matrix.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const scriptPath = path.join(scriptDirectory, "effect-firewall-adversarial-matrix.mjs");
const tsx = path.join(projectRoot, "node_modules/.bin/tsx");
let receipt;
let temporaryRoot;

before(async () => {
  receipt = await runAdversarialMatrix();
  temporaryRoot = await mkdtemp(path.join(tmpdir(), "effect-firewall-adversarial-test-"));
});

after(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

test("uses an explicit independent 5 by 4 oracle", () => {
  assert.equal(DECLARED_SPEC.actions.length, 5);
  assert.equal(DECLARED_SPEC.targets.length, 4);
  assert.equal(DECLARED_SPEC.allowedPairs.length, 6);
  assert.deepEqual(DECLARED_SPEC.allowedPairs, [
    "read_asset_metadata/scratch",
    "read_asset_metadata/workspace",
    "read_asset_metadata/candidate",
    "write_demo_result/scratch",
    "write_demo_result/workspace",
    "transform_media/scratch",
  ]);
  assert.equal(receipt.results.declarationAlignment.actionOrder, true);
  assert.equal(receipt.results.declarationAlignment.targetOrder, true);
  assert.equal(receipt.results.declarationAlignment.actionRanks, true);
  assert.equal(receipt.results.declarationAlignment.targetRanks, true);
  assert.equal(receipt.results.declarationAlignment.maximumAuthorityScore, true);
});

test("matches all 20 decisions and all 130 strict comparable relations", () => {
  const lattice = receipt.results.lattice;
  assert.equal(lattice.totalCells, 20);
  assert.equal(lattice.expectedAllowed, 6);
  assert.equal(lattice.expectedDenied, 14);
  assert.equal(lattice.falseAllows, 0);
  assert.equal(lattice.falseDenies, 0);
  assert.equal(lattice.reasonMismatches, 0);
  assert.equal(lattice.cases.every((testCase) => testCase.matches), true);
  assert.equal(receipt.results.monotonicity.comparableRelationsChecked, 130);
  assert.equal(receipt.results.monotonicity.deniedOriginRelationsChecked, 51);
  assert.deepEqual(receipt.results.monotonicity.violations, []);
});

test("fails closed across malformed shape and exact-prompt boundary corpora", () => {
  const malformed = receipt.results.malformed;
  assert.equal(malformed.total, 30);
  assert.equal(malformed.rejected, 30);
  assert.deepEqual(malformed.unexpectedAccepts, []);
  assert.equal(malformed.wrongErrorCount, 0);
  assert.equal(malformed.cases.every((testCase) =>
    testCase.rejected && testCase.error === "EFFECT_PROPOSAL_INVALID"), true);

  const prompts = receipt.results.prompts;
  assert.equal(prompts.total, 24);
  assert.equal(prompts.expectedMatches, 1);
  assert.equal(prompts.actualMatches, 1);
  assert.deepEqual(prompts.falseMatches, []);
  assert.deepEqual(prompts.missedMatches, []);
  for (const required of [
    "prefix",
    "suffix",
    "lowercase",
    "uppercase",
    "zero-width-prefix",
    "fullwidth-r",
    "cyrillic-a",
    "nonbreaking-hyphen",
  ]) {
    assert.equal(prompts.cases.some((testCase) => testCase.id === required), true, required);
  }
});

test("kills every declared ceiling, rank, formula, shape, reason, and prompt mutant", () => {
  const mutations = receipt.results.mutations;
  assert.equal(mutations.total, 20);
  assert.equal(mutations.killed, 20);
  assert.equal(mutations.surviving, 0);
  assert.equal(mutations.scorePercent, 100);
  assert.equal(mutations.requiredScorePercent, 90);
  assert.deepEqual(Object.keys(mutations.byCategory), [
    "ceiling",
    "formula",
    "prompt",
    "rank",
    "reason",
    "shape",
  ]);
  assert.equal(mutations.mutants.every((mutant) =>
    mutant.status === "killed" && typeof mutant.killedBy === "string" && mutant.mismatchCount > 0), true);
});

test("seals the receipt, binds current sources, and rejects a re-sealed false result", async () => {
  assert.equal(receipt.verdict, "PASS");
  assert.equal(receipt.officialTrack,
    "Track #1: Agent Launchpad: Design and Build Lightweight Agent Middleware");
  assert.equal(receipt.scenario, "The Kill Switch");
  assert.equal(validateReceipt(receipt), receipt);
  for (const binding of Object.values(receipt.sourceBindings)) {
    const actual = createHash("sha256")
      .update(await readFile(path.join(projectRoot, binding.path)))
      .digest("hex");
    assert.equal(binding.sha256, actual, binding.path);
  }

  const tampered = structuredClone(receipt);
  tampered.results.lattice.falseAllows = 1;
  tampered.receiptPayloadSha256 = computeReceiptPayloadSha256(tampered);
  assert.throws(() => validateReceipt(tampered), /ADVERSARIAL_LATTICE_RESULT_INVALID/);
});

test("argument parser is bounded", () => {
  assert.deepEqual(parseArguments(["--write-evidence", "--json", "--output-dir", "/tmp/example"]), {
    writeEvidence: true,
    jsonOnly: true,
    outputDirectory: "/tmp/example",
    verifyReceiptPath: null,
  });
  assert.throws(() => parseArguments(["--rounds=10"]), /UNKNOWN_ARGUMENT/);
  assert.throws(() => parseArguments(["--output-dir"]), /--output-dir_REQUIRES_VALUE/);
});

test("CLI writes human and machine receipts and verifies them against current sources", async () => {
  const outputDirectory = path.join(temporaryRoot, "evidence");
  const completed = await execFileAsync(tsx, [
    scriptPath,
    "--write-evidence",
    "--output-dir",
    outputDirectory,
    "--json",
  ], {
    cwd: projectRoot,
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const output = JSON.parse(completed.stdout);
  assert.equal(output.receipt.verdict, "PASS");
  assert.equal(output.evidence.resultsPath, path.join(outputDirectory, "results.json"));
  const written = JSON.parse(await readFile(path.join(outputDirectory, "results.json"), "utf8"));
  assert.equal(validateReceipt(written), written);
  const readme = await readFile(path.join(outputDirectory, "README.md"), "utf8");
  assert.match(readme, /Track #1: Agent Launchpad: Design and Build Lightweight Agent Middleware/);
  assert.match(readme, /Scenario: \*\*The Kill Switch\*\*/);
  assert.doesNotMatch(readme, /Track C/);

  const verified = await execFileAsync(tsx, [
    scriptPath,
    "--verify-receipt",
    path.join(outputDirectory, "results.json"),
  ], { cwd: projectRoot, timeout: 20_000 });
  assert.deepEqual(JSON.parse(verified.stdout), {
    verdict: "PASS",
    mode: "verify-receipt",
    receiptPayloadSha256: written.receiptPayloadSha256,
    sourceBindingsCurrent: true,
  });

  const tamperedPath = path.join(outputDirectory, "tampered.json");
  written.results.prompts.actualMatches = 2;
  await writeFile(tamperedPath, `${JSON.stringify(written, null, 2)}\n`, "utf8");
  await assert.rejects(
    execFileAsync(tsx, [scriptPath, "--verify-receipt", tamperedPath], {
      cwd: projectRoot,
      timeout: 20_000,
    }),
    /ADVERSARIAL_RECEIPT_PAYLOAD_HASH_INVALID/,
  );
});
