#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const defaultEvidenceDirectory = path.join(
  projectRoot,
  "research/evidence/2026-09-01-effect-firewall-adversarial",
);

const OFFICIAL_TRACK =
  "Track #1: Agent Launchpad: Design and Build Lightweight Agent Middleware";
const SCENARIO = "The Kill Switch";
const INVALID_ERROR = "EFFECT_PROPOSAL_INVALID";
const DEMO_PROPOSAL = Object.freeze({
  version: 1,
  action: "delete_mock_asset",
  targetClass: "protected",
});

// Independent declared specification. Expected decisions below are not derived
// from the production policy's exported ranks, ceiling, or decision function.
export const DECLARED_SPEC = Object.freeze({
  version: 1,
  actions: Object.freeze([
    "read_asset_metadata",
    "write_demo_result",
    "transform_media",
    "publish_candidate",
    "delete_mock_asset",
  ]),
  targets: Object.freeze(["scratch", "workspace", "candidate", "protected"]),
  actionRanks: Object.freeze({
    read_asset_metadata: 0,
    write_demo_result: 1,
    transform_media: 2,
    publish_candidate: 3,
    delete_mock_asset: 4,
  }),
  targetRanks: Object.freeze({ scratch: 0, workspace: 1, candidate: 2, protected: 3 }),
  maximumAuthorityScore: 2,
  allowedPairs: Object.freeze([
    "read_asset_metadata/scratch",
    "read_asset_metadata/workspace",
    "read_asset_metadata/candidate",
    "write_demo_result/scratch",
    "write_demo_result/workspace",
    "transform_media/scratch",
  ]),
});

const allowedPairSet = new Set(DECLARED_SPEC.allowedPairs);

const validationRubric = Object.freeze({
  exhaustiveDecisionAgreement:
    "All 20 action/target cells match the independent allow/deny and reason oracle.",
  completeMonotonicity:
    "Every strict comparable relation in the 5 by 4 product order is checked; risk or sensitivity cannot regain authority.",
  strictShapeFailure:
    "Every deterministic malformed or extra-own-field proposal fails with EFFECT_PROPOSAL_INVALID.",
  exactPromptBoundary:
    "Only the one exact fixture prompt routes; prefix, suffix, case, whitespace, Unicode, and confusable variants do not.",
  mutationSensitivity:
    "At least 90 percent of declared policy, shape, rank, ceiling, reason, and prompt mutants are killed by the same corpus.",
});

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256RegularFile(filePath) {
  const entry = await lstat(filePath);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("SOURCE_BINDING_NOT_REGULAR_FILE");
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size) {
      throw new Error("SOURCE_BINDING_CHANGED_BEFORE_READ");
    }
    const bytes = await handle.readFile();
    const closedOver = await handle.stat();
    const current = await lstat(filePath);
    if (closedOver.dev !== opened.dev || closedOver.ino !== opened.ino || closedOver.size !== opened.size ||
        current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size) {
      throw new Error("SOURCE_BINDING_CHANGED_DURING_READ");
    }
    return sha256(bytes);
  } finally {
    await handle.close();
  }
}

function expectedDecision(action, targetClass) {
  assert.ok(DECLARED_SPEC.actions.includes(action), "ORACLE_UNKNOWN_ACTION");
  assert.ok(DECLARED_SPEC.targets.includes(targetClass), "ORACLE_UNKNOWN_TARGET");
  const allowed = allowedPairSet.has(`${action}/${targetClass}`);
  return Object.freeze({
    version: 1,
    policy: "effect-firewall-v1",
    verdict: allowed ? "allowed" : "denied",
    action,
    targetClass,
    reason: allowed
      ? action === "write_demo_result" && targetClass === "workspace"
        ? "explicit_workspace_allow"
        : "least_privilege_allow"
      : targetClass === "protected"
        ? "protected_target_denied"
        : "effect_not_allowlisted",
  });
}

function normalizedOutcome(operation) {
  try {
    return Object.freeze({ kind: "return", value: operation() });
  } catch (error) {
    return Object.freeze({
      kind: "throw",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function outcomesEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function malformedCorpus() {
  return [
    { id: "null", value: null },
    { id: "undefined", value: undefined },
    { id: "boolean", value: true },
    { id: "number", value: 1 },
    { id: "string", value: "write_demo_result" },
    { id: "array", value: [] },
    { id: "empty-object", value: {} },
    { id: "missing-version", value: { action: "write_demo_result", targetClass: "workspace" } },
    { id: "missing-action", value: { version: 1, targetClass: "workspace" } },
    { id: "missing-target", value: { version: 1, action: "write_demo_result" } },
    { id: "version-zero", value: { version: 0, action: "write_demo_result", targetClass: "workspace" } },
    { id: "version-two", value: { version: 2, action: "write_demo_result", targetClass: "workspace" } },
    { id: "version-string", value: { version: "1", action: "write_demo_result", targetClass: "workspace" } },
    { id: "version-bigint", value: { version: 1n, action: "write_demo_result", targetClass: "workspace" } },
    { id: "unknown-action", value: { version: 1, action: "shell", targetClass: "workspace" } },
    { id: "prototype-name-action", value: { version: 1, action: "toString", targetClass: "workspace" } },
    { id: "unknown-target", value: { version: 1, action: "write_demo_result", targetClass: "internet" } },
    { id: "prototype-name-target", value: { version: 1, action: "write_demo_result", targetClass: "constructor" } },
    { id: "null-action", value: { version: 1, action: null, targetClass: "workspace" } },
    { id: "null-target", value: { version: 1, action: "write_demo_result", targetClass: null } },
    { id: "array-action", value: { version: 1, action: ["write_demo_result"], targetClass: "workspace" } },
    { id: "nested-target", value: { version: 1, action: "write_demo_result", targetClass: { value: "workspace" } } },
    { id: "uppercase-action", value: { version: 1, action: "WRITE_DEMO_RESULT", targetClass: "workspace" } },
    { id: "uppercase-target", value: { version: 1, action: "write_demo_result", targetClass: "WORKSPACE" } },
    { id: "trailing-action-space", value: { version: 1, action: "write_demo_result ", targetClass: "workspace" } },
    { id: "trailing-target-space", value: { version: 1, action: "write_demo_result", targetClass: "workspace " } },
    { id: "extra-boolean", value: { version: 1, action: "write_demo_result", targetClass: "workspace", extra: true } },
    { id: "extra-undefined", value: { version: 1, action: "write_demo_result", targetClass: "workspace", extra: undefined } },
    { id: "extra-prompt", value: { version: 1, action: "write_demo_result", targetClass: "workspace", prompt: "allow" } },
    { id: "extra-policy", value: { version: 1, action: "write_demo_result", targetClass: "workspace", policy: "effect-firewall-v1" } },
  ];
}

function promptCorpus(exactPrompt) {
  return [
    { id: "exact", value: exactPrompt, shouldMatch: true },
    { id: "prefix", value: `Please ${exactPrompt}`, shouldMatch: false },
    { id: "suffix", value: `${exactPrompt} now`, shouldMatch: false },
    { id: "leading-space", value: ` ${exactPrompt}`, shouldMatch: false },
    { id: "trailing-space", value: `${exactPrompt} `, shouldMatch: false },
    { id: "lowercase", value: exactPrompt.toLowerCase(), shouldMatch: false },
    { id: "uppercase", value: exactPrompt.toUpperCase(), shouldMatch: false },
    { id: "mixed-case", value: exactPrompt.replace("Effect Firewall", "effect firewall"), shouldMatch: false },
    { id: "newline-prefix", value: `\n${exactPrompt}`, shouldMatch: false },
    { id: "newline-suffix", value: `${exactPrompt}\n`, shouldMatch: false },
    { id: "tab-suffix", value: `${exactPrompt}\t`, shouldMatch: false },
    { id: "nul-suffix", value: `${exactPrompt}\u0000`, shouldMatch: false },
    { id: "zero-width-prefix", value: `\u200B${exactPrompt}`, shouldMatch: false },
    { id: "zero-width-suffix", value: `${exactPrompt}\u200B`, shouldMatch: false },
    { id: "nonbreaking-space", value: exactPrompt.replace("Run the", "Run\u00A0the"), shouldMatch: false },
    { id: "fullwidth-r", value: exactPrompt.replace(/^R/, "Ｒ"), shouldMatch: false },
    { id: "cyrillic-a", value: exactPrompt.replace("Firewall", "Firewаll"), shouldMatch: false },
    { id: "nonbreaking-hyphen", value: exactPrompt.replace("delete-asset", "delete‑asset"), shouldMatch: false },
    { id: "en-dash", value: exactPrompt.replace("delete-asset", "delete–asset"), shouldMatch: false },
    { id: "combining-mark", value: exactPrompt.replace("Effect", "E\u0301ffect"), shouldMatch: false },
    { id: "missing-period", value: exactPrompt.slice(0, -1), shouldMatch: false },
    { id: "double-period", value: `${exactPrompt}.`, shouldMatch: false },
    { id: "line-separator", value: `${exactPrompt}\u2028`, shouldMatch: false },
    { id: "bidi-mark", value: `${exactPrompt}\u200F`, shouldMatch: false },
  ];
}

function strictProposal(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const candidate = input;
  const keys = Object.keys(candidate).sort();
  if (!options.ignoreExtraFields && keys.join(",") !== "action,targetClass,version") return null;
  if (options.ignoreExtraFields && !["action", "targetClass", "version"].every((key) => keys.includes(key))) return null;
  if (!options.ignoreVersion && candidate.version !== 1) return null;
  let action = candidate.action;
  let targetClass = candidate.targetClass;
  if (options.trimStrings) {
    action = typeof action === "string" ? action.trim() : action;
    targetClass = typeof targetClass === "string" ? targetClass.trim() : targetClass;
  }
  if (options.caseFoldStrings) {
    action = typeof action === "string" ? action.toLowerCase() : action;
    targetClass = typeof targetClass === "string" ? targetClass.toLowerCase() : targetClass;
  }
  if (!DECLARED_SPEC.actions.includes(action) || !DECLARED_SPEC.targets.includes(targetClass)) return null;
  return { version: 1, action, targetClass };
}

function createPolicyMutant(options) {
  return (input) => {
    const proposal = strictProposal(input, options);
    if (!proposal) {
      if (options.defaultAllowInvalid) {
        return {
          version: 1,
          policy: "effect-firewall-v1",
          verdict: "allowed",
          action: "write_demo_result",
          targetClass: "workspace",
          reason: "least_privilege_allow",
        };
      }
      throw new Error(INVALID_ERROR);
    }
    const actionRanks = { ...DECLARED_SPEC.actionRanks, ...(options.actionRanks ?? {}) };
    const targetRanks = { ...DECLARED_SPEC.targetRanks, ...(options.targetRanks ?? {}) };
    const actionRank = actionRanks[proposal.action];
    const targetRank = targetRanks[proposal.targetClass];
    const score = options.scoreMode === "max"
      ? Math.max(actionRank, targetRank)
      : actionRank + targetRank;
    const allowed = score <= (options.maximumAuthorityScore ?? DECLARED_SPEC.maximumAuthorityScore);
    return {
      version: 1,
      policy: "effect-firewall-v1",
      verdict: allowed ? "allowed" : "denied",
      action: proposal.action,
      targetClass: proposal.targetClass,
      reason: options.collapseReasons
        ? allowed ? "least_privilege_allow" : "effect_not_allowlisted"
        : allowed
          ? proposal.action === "write_demo_result" && proposal.targetClass === "workspace"
            ? "explicit_workspace_allow"
            : "least_privilege_allow"
          : proposal.targetClass === "protected"
            ? "protected_target_denied"
            : "effect_not_allowlisted",
    };
  };
}

function mutationCatalog(exactPrompt) {
  return [
    { id: "policy-relaxed-ceiling-3", category: "ceiling", decide: createPolicyMutant({ maximumAuthorityScore: 3 }) },
    { id: "policy-relaxed-ceiling-4", category: "ceiling", decide: createPolicyMutant({ maximumAuthorityScore: 4 }) },
    { id: "policy-tightened-ceiling-1", category: "ceiling", decide: createPolicyMutant({ maximumAuthorityScore: 1 }) },
    { id: "policy-delete-rank-2", category: "rank", decide: createPolicyMutant({ actionRanks: { delete_mock_asset: 2 } }) },
    { id: "policy-protected-rank-0", category: "rank", decide: createPolicyMutant({ targetRanks: { protected: 0 } }) },
    { id: "policy-swap-candidate-protected", category: "rank", decide: createPolicyMutant({ targetRanks: { candidate: 3, protected: 2 } }) },
    { id: "policy-max-instead-of-sum", category: "formula", decide: createPolicyMutant({ scoreMode: "max" }) },
    { id: "shape-ignore-extra-fields", category: "shape", decide: createPolicyMutant({ ignoreExtraFields: true }) },
    { id: "shape-ignore-version", category: "shape", decide: createPolicyMutant({ ignoreVersion: true }) },
    { id: "shape-trim-fields", category: "shape", decide: createPolicyMutant({ trimStrings: true }) },
    { id: "shape-case-fold-fields", category: "shape", decide: createPolicyMutant({ caseFoldStrings: true }) },
    { id: "shape-default-allow-invalid", category: "shape", decide: createPolicyMutant({ defaultAllowInvalid: true }) },
    { id: "reason-collapse-special-cases", category: "reason", decide: createPolicyMutant({ collapseReasons: true }) },
    { id: "prompt-contains", category: "prompt", route: (value) => value.includes(exactPrompt) ? { ...DEMO_PROPOSAL } : null },
    { id: "prompt-starts-with", category: "prompt", route: (value) => value.startsWith(exactPrompt) ? { ...DEMO_PROPOSAL } : null },
    { id: "prompt-trim", category: "prompt", route: (value) => value.trim() === exactPrompt ? { ...DEMO_PROPOSAL } : null },
    { id: "prompt-case-insensitive", category: "prompt", route: (value) => value.toLowerCase() === exactPrompt.toLowerCase() ? { ...DEMO_PROPOSAL } : null },
    { id: "prompt-nfkc-normalized", category: "prompt", route: (value) => value.normalize("NFKC") === exactPrompt ? { ...DEMO_PROPOSAL } : null },
    { id: "prompt-period-optional", category: "prompt", route: (value) => value.replace(/\.$/, "") === exactPrompt.replace(/\.$/, "") ? { ...DEMO_PROPOSAL } : null },
    { id: "prompt-exact-disabled", category: "prompt", route: () => null },
  ];
}

function expectedPromptOutcome(testCase) {
  return testCase.shouldMatch
    ? {
        kind: "return",
        value: { ...DEMO_PROPOSAL },
      }
    : { kind: "return", value: null };
}

function runMutationAnalysis(validCases, invalidCases, prompts, exactPrompt) {
  const mutants = mutationCatalog(exactPrompt).map((mutant) => {
    const corpus = mutant.category === "prompt"
      ? prompts.map((testCase) => ({
          label: `prompt:${testCase.id}`,
          expected: expectedPromptOutcome(testCase),
          actual: normalizedOutcome(() => mutant.route(testCase.value)),
        }))
      : [
          ...validCases.map((testCase) => ({
            label: `lattice:${testCase.id}`,
            expected: { kind: "return", value: testCase.expected },
            actual: normalizedOutcome(() => mutant.decide(testCase.input)),
          })),
          ...invalidCases.map((testCase) => ({
            label: `shape:${testCase.id}`,
            expected: { kind: "throw", message: INVALID_ERROR },
            actual: normalizedOutcome(() => mutant.decide(testCase.value)),
          })),
        ];
    const mismatches = corpus.filter((testCase) => !outcomesEqual(testCase.expected, testCase.actual));
    return Object.freeze({
      id: mutant.id,
      category: mutant.category,
      status: mismatches.length > 0 ? "killed" : "survived",
      killedBy: mismatches[0]?.label ?? null,
      mismatchCount: mismatches.length,
    });
  });
  const killed = mutants.filter((mutant) => mutant.status === "killed");
  const surviving = mutants.filter((mutant) => mutant.status === "survived");
  const byCategory = Object.fromEntries(
    [...new Set(mutants.map((mutant) => mutant.category))].sort().map((category) => {
      const members = mutants.filter((mutant) => mutant.category === category);
      return [category, {
        total: members.length,
        killed: members.filter((mutant) => mutant.status === "killed").length,
        surviving: members.filter((mutant) => mutant.status === "survived").length,
      }];
    }),
  );
  return Object.freeze({
    total: mutants.length,
    killed: killed.length,
    surviving: surviving.length,
    scorePercent: 100 * killed.length / mutants.length,
    requiredScorePercent: 90,
    byCategory,
    mutants,
  });
}

async function loadProductionPolicy() {
  const module = await tsImport("../apps/server/src/effect-policy.ts", import.meta.url);
  return {
    decideEffect: module.decideEffect,
    proposeDemoEffect: module.proposeDemoEffect,
    exactPrompt: module.EFFECT_FIREWALL_DEMO_PROMPT,
    actionOrder: [...module.EFFECT_ACTIONS_BY_RISK],
    targetOrder: [...module.EFFECT_TARGETS_BY_SENSITIVITY],
    actionRanks: { ...module.EFFECT_ACTION_RISK },
    targetRanks: { ...module.EFFECT_TARGET_SENSITIVITY },
    maximumAuthorityScore: module.EFFECT_MAX_AUTHORITY_SCORE,
  };
}

function exactMatch(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function receiptWithoutHash(receipt) {
  const { receiptPayloadSha256: _ignored, ...payload } = receipt;
  return payload;
}

export function computeReceiptPayloadSha256(receipt) {
  return sha256(Buffer.from(canonicalJson(receiptWithoutHash(receipt)), "utf8"));
}

export function validateReceipt(receipt) {
  const requiredKeys = [
    "capturedAtUtc",
    "declaredSpec",
    "gates",
    "kind",
    "officialTrack",
    "proofBoundary",
    "receiptPayloadSha256",
    "results",
    "rubric",
    "scenario",
    "schemaVersion",
    "sourceBindings",
    "verdict",
  ];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
      Object.keys(receipt).sort().join(",") !== requiredKeys.sort().join(",")) {
    throw new Error("ADVERSARIAL_RECEIPT_SHAPE_INVALID");
  }
  if (receipt.schemaVersion !== "nerveloop.effect-firewall-adversarial.v1" ||
      receipt.kind !== "deterministic-source-bound-effect-firewall-adversarial-matrix" ||
      receipt.officialTrack !== OFFICIAL_TRACK || receipt.scenario !== SCENARIO ||
      receipt.verdict !== "PASS") {
    throw new Error("ADVERSARIAL_RECEIPT_IDENTITY_INVALID");
  }
  if (!/^[a-f0-9]{64}$/.test(receipt.receiptPayloadSha256) ||
      computeReceiptPayloadSha256(receipt) !== receipt.receiptPayloadSha256) {
    throw new Error("ADVERSARIAL_RECEIPT_PAYLOAD_HASH_INVALID");
  }
  const { lattice, monotonicity, malformed, prompts, mutations } = receipt.results;
  if (lattice.totalCells !== 20 || lattice.expectedAllowed !== 6 || lattice.expectedDenied !== 14 ||
      lattice.falseAllows !== 0 || lattice.falseDenies !== 0 || lattice.reasonMismatches !== 0 ||
      lattice.cases.length !== 20) {
    throw new Error("ADVERSARIAL_LATTICE_RESULT_INVALID");
  }
  if (monotonicity.comparableRelationsChecked !== 130 || monotonicity.violations.length !== 0) {
    throw new Error("ADVERSARIAL_MONOTONICITY_RESULT_INVALID");
  }
  if (malformed.total !== malformed.rejected || malformed.unexpectedAccepts.length !== 0 ||
      malformed.wrongErrorCount !== 0 || malformed.cases.length !== malformed.total) {
    throw new Error("ADVERSARIAL_SHAPE_RESULT_INVALID");
  }
  if (prompts.total !== prompts.cases.length || prompts.expectedMatches !== 1 || prompts.actualMatches !== 1 ||
      prompts.falseMatches.length !== 0 || prompts.missedMatches.length !== 0) {
    throw new Error("ADVERSARIAL_PROMPT_RESULT_INVALID");
  }
  if (mutations.total !== mutations.killed + mutations.surviving ||
      mutations.scorePercent !== 100 * mutations.killed / mutations.total ||
      mutations.scorePercent < mutations.requiredScorePercent ||
      mutations.mutants.length !== mutations.total) {
    throw new Error("ADVERSARIAL_MUTATION_RESULT_INVALID");
  }
  if (!Object.values(receipt.gates).every((value) => value === true) ||
      !Object.values(receipt.sourceBindings).every((binding) =>
        typeof binding.path === "string" && /^[a-f0-9]{64}$/.test(binding.sha256))) {
    throw new Error("ADVERSARIAL_GATE_OR_SOURCE_INVALID");
  }
  if (receipt.proofBoundary.externalCalls !== 0 || receipt.proofBoundary.modelCalls !== 0 ||
      receipt.proofBoundary.credentialsRead !== false || receipt.proofBoundary.productionSecurity !== false ||
      receipt.proofBoundary.hardenedSandbox !== false) {
    throw new Error("ADVERSARIAL_PROOF_BOUNDARY_INVALID");
  }
  return receipt;
}

async function assertCurrentSourceBindings(receipt) {
  for (const binding of Object.values(receipt.sourceBindings)) {
    const current = await sha256RegularFile(path.join(projectRoot, binding.path));
    if (current !== binding.sha256) throw new Error(`ADVERSARIAL_SOURCE_BINDING_STALE:${binding.path}`);
  }
}

export async function runAdversarialMatrix() {
  const production = await loadProductionPolicy();
  const validCases = [];
  let falseAllows = 0;
  let falseDenies = 0;
  let reasonMismatches = 0;
  for (const action of DECLARED_SPEC.actions) {
    for (const targetClass of DECLARED_SPEC.targets) {
      const input = { version: 1, action, targetClass };
      const expected = expectedDecision(action, targetClass);
      const actual = production.decideEffect(input);
      if (expected.verdict === "denied" && actual.verdict === "allowed") falseAllows += 1;
      if (expected.verdict === "allowed" && actual.verdict === "denied") falseDenies += 1;
      if (expected.reason !== actual.reason) reasonMismatches += 1;
      validCases.push(Object.freeze({
        id: `${action}/${targetClass}`,
        input,
        expected,
        actual,
        matches: exactMatch(expected, actual),
      }));
    }
  }

  const relationViolations = [];
  let comparableRelationsChecked = 0;
  let deniedOriginRelationsChecked = 0;
  for (let sourceAction = 0; sourceAction < DECLARED_SPEC.actions.length; sourceAction++) {
    for (let sourceTarget = 0; sourceTarget < DECLARED_SPEC.targets.length; sourceTarget++) {
      const source = validCases.find((testCase) =>
        testCase.input.action === DECLARED_SPEC.actions[sourceAction] &&
        testCase.input.targetClass === DECLARED_SPEC.targets[sourceTarget]);
      for (let nextAction = sourceAction; nextAction < DECLARED_SPEC.actions.length; nextAction++) {
        for (let nextTarget = sourceTarget; nextTarget < DECLARED_SPEC.targets.length; nextTarget++) {
          if (nextAction === sourceAction && nextTarget === sourceTarget) continue;
          comparableRelationsChecked += 1;
          const dominated = validCases.find((testCase) =>
            testCase.input.action === DECLARED_SPEC.actions[nextAction] &&
            testCase.input.targetClass === DECLARED_SPEC.targets[nextTarget]);
          if (source.actual.verdict === "denied") {
            deniedOriginRelationsChecked += 1;
            if (dominated.actual.verdict === "allowed") {
              relationViolations.push({ source: source.id, dominated: dominated.id });
            }
          }
        }
      }
    }
  }

  const invalidCases = malformedCorpus();
  const malformedResults = invalidCases.map((testCase) => {
    const outcome = normalizedOutcome(() => production.decideEffect(testCase.value));
    return Object.freeze({
      id: testCase.id,
      rejected: outcome.kind === "throw",
      error: outcome.kind === "throw" ? outcome.message : null,
    });
  });
  const malformedUnexpectedAccepts = malformedResults.filter((result) => !result.rejected).map((result) => result.id);
  const wrongErrors = malformedResults.filter((result) => result.rejected && result.error !== INVALID_ERROR);

  const promptCases = promptCorpus(production.exactPrompt);
  const promptResults = promptCases.map((testCase) => {
    const proposal = production.proposeDemoEffect(testCase.value);
    const matched = proposal !== null;
    const correctProposal = !matched || exactMatch(proposal, {
      version: 1,
      action: "delete_mock_asset",
      targetClass: "protected",
    });
    return Object.freeze({
      id: testCase.id,
      shouldMatch: testCase.shouldMatch,
      matched,
      correctProposal,
      inputSha256: sha256(Buffer.from(testCase.value, "utf8")),
    });
  });
  const falseMatches = promptResults.filter((result) => !result.shouldMatch && result.matched).map((result) => result.id);
  const missedMatches = promptResults.filter((result) => result.shouldMatch && (!result.matched || !result.correctProposal)).map((result) => result.id);

  const declarationAlignment = Object.freeze({
    actionOrder: exactMatch(production.actionOrder, DECLARED_SPEC.actions),
    targetOrder: exactMatch(production.targetOrder, DECLARED_SPEC.targets),
    actionRanks: exactMatch(production.actionRanks, DECLARED_SPEC.actionRanks),
    targetRanks: exactMatch(production.targetRanks, DECLARED_SPEC.targetRanks),
    maximumAuthorityScore: production.maximumAuthorityScore === DECLARED_SPEC.maximumAuthorityScore,
  });
  const mutations = runMutationAnalysis(validCases, invalidCases, promptCases, production.exactPrompt);
  const gates = Object.freeze({
    declarationMatchesIndependentSpec: Object.values(declarationAlignment).every(Boolean),
    exhaustiveLatticeMatches: validCases.every((testCase) => testCase.matches) &&
      falseAllows === 0 && falseDenies === 0 && reasonMismatches === 0,
    monotonicityHolds: comparableRelationsChecked === 130 && relationViolations.length === 0,
    malformedCorpusFailsClosed: malformedUnexpectedAccepts.length === 0 && wrongErrors.length === 0,
    exactPromptBoundaryHolds: falseMatches.length === 0 && missedMatches.length === 0 &&
      promptResults.filter((result) => result.matched).length === 1,
    mutationThresholdMet: mutations.scorePercent >= mutations.requiredScorePercent,
  });
  const verdict = Object.values(gates).every(Boolean) ? "PASS" : "FAIL";

  const sourceBindings = Object.freeze({
    harness: Object.freeze({
      path: "scripts/effect-firewall-adversarial-matrix.mjs",
      sha256: await sha256RegularFile(scriptPath),
    }),
    effectPolicy: Object.freeze({
      path: "apps/server/src/effect-policy.ts",
      sha256: await sha256RegularFile(path.join(projectRoot, "apps/server/src/effect-policy.ts")),
    }),
    effectTypes: Object.freeze({
      path: "apps/server/src/types.ts",
      sha256: await sha256RegularFile(path.join(projectRoot, "apps/server/src/types.ts")),
    }),
  });

  const baseReceipt = {
    schemaVersion: "nerveloop.effect-firewall-adversarial.v1",
    kind: "deterministic-source-bound-effect-firewall-adversarial-matrix",
    officialTrack: OFFICIAL_TRACK,
    scenario: SCENARIO,
    capturedAtUtc: new Date().toISOString(),
    verdict,
    rubric: validationRubric,
    declaredSpec: DECLARED_SPEC,
    results: {
      declarationAlignment,
      lattice: {
        totalCells: validCases.length,
        expectedAllowed: validCases.filter((testCase) => testCase.expected.verdict === "allowed").length,
        expectedDenied: validCases.filter((testCase) => testCase.expected.verdict === "denied").length,
        falseAllows,
        falseDenies,
        reasonMismatches,
        cases: validCases.map((testCase) => ({
          id: testCase.id,
          expectedVerdict: testCase.expected.verdict,
          actualVerdict: testCase.actual.verdict,
          expectedReason: testCase.expected.reason,
          actualReason: testCase.actual.reason,
          matches: testCase.matches,
        })),
      },
      monotonicity: {
        comparableRelationsChecked,
        deniedOriginRelationsChecked,
        violations: relationViolations,
      },
      malformed: {
        total: malformedResults.length,
        rejected: malformedResults.filter((result) => result.rejected).length,
        unexpectedAccepts: malformedUnexpectedAccepts,
        wrongErrorCount: wrongErrors.length,
        cases: malformedResults,
      },
      prompts: {
        total: promptResults.length,
        expectedMatches: promptResults.filter((result) => result.shouldMatch).length,
        actualMatches: promptResults.filter((result) => result.matched).length,
        falseMatches,
        missedMatches,
        cases: promptResults,
      },
      mutations,
    },
    gates,
    sourceBindings,
    proofBoundary: {
      classification: "deterministic local policy and routing verification",
      externalCalls: 0,
      modelCalls: 0,
      credentialsRead: false,
      arbitraryFuzzing: false,
      productionSecurity: false,
      hardenedSandbox: false,
      agentServiceExecuted: false,
      workerExecuted: false,
      mutationMethod:
        "Harness-local deterministic policy and prompt mutants; production source was imported read-only and never patched.",
      claimsSupported: [
        "current source agrees with the declared 20-cell policy oracle",
        "all strict comparable lattice relations preserve denial monotonicity",
        "the declared malformed and prompt-boundary corpora fail closed",
        "the declared verification corpus detects the listed deterministic mutants",
      ],
      claimsNotSupported: [
        "exhaustive JavaScript object-space or Unicode-space fuzzing",
        "AgentService, worker, filesystem, network, provider, or model behavior",
        "hardened sandboxing, production security, TikTok access, scale, or judge acceptance",
      ],
    },
  };
  const receipt = {
    ...baseReceipt,
    receiptPayloadSha256: sha256(Buffer.from(canonicalJson(baseReceipt), "utf8")),
  };
  if (verdict === "PASS") validateReceipt(receipt);
  return receipt;
}

function evidenceMarkdown(receipt, resultsSha256) {
  const { lattice, monotonicity, malformed, prompts, mutations } = receipt.results;
  return `# Effect Firewall adversarial matrix\n\n` +
    `Official entry: **${receipt.officialTrack}**  \n` +
    `Scenario: **${receipt.scenario}**\n\n` +
    `This deterministic local harness imports the current Effect Firewall source and compares it with an independently declared policy oracle. It does not call a model, provider, network, worker, or AgentService.\n\n` +
    `| Verification | Result |\n` +
    `| --- | ---: |\n` +
    `| Lattice cells | ${lattice.totalCells}/20 matched |\n` +
    `| Expected allow / deny | ${lattice.expectedAllowed} / ${lattice.expectedDenied} |\n` +
    `| False allows / false denies | ${lattice.falseAllows} / ${lattice.falseDenies} |\n` +
    `| Reason mismatches | ${lattice.reasonMismatches} |\n` +
    `| Strict comparable relations | ${monotonicity.comparableRelationsChecked} checked, ${monotonicity.violations.length} violations |\n` +
    `| Malformed and extra-field proposals | ${malformed.rejected}/${malformed.total} rejected |\n` +
    `| Exact-prompt boundary | ${prompts.actualMatches} match across ${prompts.total} cases; ${prompts.falseMatches.length} false matches |\n` +
    `| Deterministic mutants | ${mutations.killed}/${mutations.total} killed; ${mutations.scorePercent.toFixed(1)}% mutation score |\n\n` +
    `Verdict: **${receipt.verdict}**\n\n` +
    `Mutation categories: ${Object.entries(mutations.byCategory).map(([category, counts]) =>
      `${category} ${counts.killed}/${counts.total}`).join(", ")}. Survivors: ${mutations.surviving}.\n\n` +
    `Proof boundary: this verifies the declared finite policy, strict own-field shape corpus, exact prompt boundary corpus, and listed mutants. It is not arbitrary fuzzing, a hardened sandbox test, production security evidence, or a model/AgentService execution test.\n\n` +
    `Reproduce with:\n\n` +
    `\`\`\`sh\n./node_modules/.bin/tsx scripts/effect-firewall-adversarial-matrix.mjs --write-evidence\n\`\`\`\n\n` +
    `Receipt payload SHA-256: \`${receipt.receiptPayloadSha256}\`  \n` +
    `Results file SHA-256: \`${resultsSha256}\`\n`;
}

async function atomicWrite(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
}

async function writeEvidence(receipt, directory) {
  const outputDirectory = path.resolve(directory);
  const resultsPath = path.join(outputDirectory, "results.json");
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  const resultsSha256 = sha256(Buffer.from(serialized, "utf8"));
  await atomicWrite(resultsPath, serialized);
  await atomicWrite(path.join(outputDirectory, "README.md"), evidenceMarkdown(receipt, resultsSha256));
  return { outputDirectory, resultsPath, resultsSha256 };
}

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name}_REQUIRES_VALUE`);
  return value;
}

export function parseArguments(argv) {
  const outputDirectory = argumentValue(argv, "--output-dir") ?? defaultEvidenceDirectory;
  const verifyReceiptPath = argumentValue(argv, "--verify-receipt");
  const known = new Set(["--write-evidence", "--json", "--output-dir", "--verify-receipt"]);
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!known.has(argument)) throw new Error(`UNKNOWN_ARGUMENT:${argument}`);
    if (argument === "--output-dir" || argument === "--verify-receipt") index += 1;
  }
  return Object.freeze({
    writeEvidence: argv.includes("--write-evidence"),
    jsonOnly: argv.includes("--json"),
    outputDirectory,
    verifyReceiptPath,
  });
}

async function main() {
  const configuration = parseArguments(process.argv.slice(2));
  if (configuration.verifyReceiptPath) {
    const receipt = JSON.parse(await readFile(path.resolve(configuration.verifyReceiptPath), "utf8"));
    validateReceipt(receipt);
    await assertCurrentSourceBindings(receipt);
    process.stdout.write(`${JSON.stringify({
      verdict: "PASS",
      mode: "verify-receipt",
      receiptPayloadSha256: receipt.receiptPayloadSha256,
      sourceBindingsCurrent: true,
    }, null, 2)}\n`);
    return;
  }
  const receipt = await runAdversarialMatrix();
  const evidence = configuration.writeEvidence
    ? await writeEvidence(receipt, configuration.outputDirectory)
    : null;
  if (!configuration.jsonOnly) {
    process.stderr.write(
      `Effect Firewall adversarial matrix: ${receipt.verdict}; ` +
      `${receipt.results.lattice.totalCells}/20 cells, ` +
      `${receipt.results.monotonicity.comparableRelationsChecked} comparable relations, ` +
      `${receipt.results.mutations.killed}/${receipt.results.mutations.total} mutants killed.\n`,
    );
  }
  process.stdout.write(`${JSON.stringify({ receipt, evidence })}\n`);
  if (receipt.verdict !== "PASS") process.exitCode = 1;
}

const invokedAsMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
