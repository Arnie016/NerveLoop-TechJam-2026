import {readFile} from "node:fs/promises";
import {describe, expect, it} from "vitest";
import {
  computeEffectReceiptChainHead,
  EffectReceiptAutomatonError,
  type EffectReceiptAutomatonErrorCode,
  type EffectReceiptValidationOptions,
  validateEffectReceiptHistory,
} from "./effect-receipt-automaton.js";
import type {RunGuardEventKind, RunGuardReceipt} from "./types.js";

const before = "11".repeat(32);
const after = "22".repeat(32);
const recoveredWrong = "33".repeat(32);

function event(index: number, kind: RunGuardEventKind, detail = `${kind} detail`) {
  return {
    at: `2026-09-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    kind,
    detail,
  } as const;
}

function base(events: RunGuardReceipt["events"]): RunGuardReceipt {
  return {
    version: 1,
    agentId: "agent-a",
    runId: "run-a",
    grantedScope: "agent-workspace-only",
    sandboxMode: "workspace-write",
    verdict: "retained",
    denialReason: null,
    beforeManifestDigest: before,
    afterManifestDigest: after,
    recoveredManifestDigest: null,
    recovery: "not_needed",
    changedFiles: ["result.txt"],
    events,
  };
}

function safeReceipt(): RunGuardReceipt {
  return base([
    event(0, "grant_issued"),
    event(1, "verification_retained"),
  ]);
}

function promotedSafeReceipt(): RunGuardReceipt {
  return base([
    event(0, "grant_issued"),
    event(1, "verification_retained"),
    event(2, "candidate_promoted"),
    event(3, "verification_retained", "promoted candidate verified"),
  ]);
}

function preDispatchReceipt(): RunGuardReceipt {
  return {
    ...base([
      event(0, "grant_issued"),
      event(1, "verification_retained"),
      event(2, "effect_denied_pre_dispatch"),
    ]),
    verdict: "denied",
    denialReason: "Effect Firewall denied a protected action before worker dispatch",
    afterManifestDigest: before,
    changedFiles: [],
    effectDecision: {
      version: 1,
      policy: "effect-firewall-v1",
      verdict: "denied",
      action: "delete_mock_asset",
      targetClass: "protected",
      reason: "protected_target_denied",
      workerSpawned: false,
      protectedBaselineVerifiedUnchanged: true,
    },
  };
}

function rolledBackReceipt(): RunGuardReceipt {
  return {
    ...base([
      event(0, "grant_issued"),
      event(1, "verification_denied"),
      event(2, "rollback_applied"),
    ]),
    verdict: "denied",
    denialReason: "RunGuard blocked a protected workspace-path mutation",
    recoveredManifestDigest: before,
    recovery: "rolled_back",
    changedFiles: ["[redacted protected path]"],
  };
}

function failedRecoveryReceipt(includeRequiredEvent = false): RunGuardReceipt {
  return {
    ...base([
      event(0, "grant_issued"),
      event(1, "verification_denied"),
      event(2, "rollback_failed"),
      ...(includeRequiredEvent ? [event(3, "recovery_required")] : []),
    ]),
    verdict: "denied",
    denialReason: "RunGuard blocked a protected workspace-path mutation",
    recoveredManifestDigest: null,
    recovery: "failed",
    changedFiles: ["[redacted protected path]"],
  };
}

function grantDeniedReceipt(): RunGuardReceipt {
  return {
    ...base([
      event(0, "grant_issued"),
      event(1, "grant_denied"),
    ]),
    verdict: "denied",
    denialReason: "RunGuard requires workspace-write sandbox mode",
    beforeManifestDigest: null,
    afterManifestDigest: null,
    recoveredManifestDigest: null,
    recovery: "not_needed",
    changedFiles: [],
    sandboxMode: "read-only",
  };
}

function expectCode(
  value: unknown,
  code: EffectReceiptAutomatonErrorCode,
  options: EffectReceiptValidationOptions = {},
): void {
  try {
    validateEffectReceiptHistory(value, options);
  } catch (error) {
    expect(error).toBeInstanceOf(EffectReceiptAutomatonError);
    expect((error as EffectReceiptAutomatonError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("Effect receipt terminal families", () => {
  it.each([
    ["safe retained", safeReceipt(), {}, "safe_retained", false],
    ["promoted safe", promotedSafeReceipt(), {}, "safe_retained", false],
    ["grant denied", grantDeniedReceipt(), {}, "grant_denied", false],
    ["pre-dispatch denial", preDispatchReceipt(), {}, "effect_denied_pre_dispatch", true],
    ["post-run rollback", rolledBackReceipt(), {}, "post_run_rolled_back", false],
    [
      "failed rollback with hold",
      failedRecoveryReceipt(),
      {recoveryHold: {runId: "run-a", reason: "rollback_failed", since: "2026-09-01T00:00:04.000Z"}},
      "recovery_failed_hold",
      false,
    ],
    [
      "failed rollback with explicit recovery-required event",
      failedRecoveryReceipt(true),
      {recoveryHold: {runId: "run-a", reason: "rollback_failed", since: "2026-09-01T00:00:04.000Z"}},
      "recovery_failed_hold",
      false,
    ],
  ] as const)("accepts %s", (_label, receipt, options, family, dispatchAbsent) => {
    const result = validateEffectReceiptHistory(receipt, options);
    expect(result.family).toBe(family);
    expect(result.workerDispatchProvedAbsent).toBe(dispatchAbsent);
    expect(result.chainHead).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires the persisted same-Run rollback hold for failed recovery", () => {
    expectCode(failedRecoveryReceipt(), "RECOVERY_HOLD_REQUIRED");
    expectCode(failedRecoveryReceipt(), "RECOVERY_HOLD_REQUIRED", {
      recoveryHold: {runId: "another-run", reason: "rollback_failed", since: "2026-09-01T00:00:04.000Z"},
    });
    expectCode(failedRecoveryReceipt(), "RECOVERY_HOLD_REQUIRED", {
      recoveryHold: {runId: "run-a", reason: "interrupted_run", since: "2026-09-01T00:00:04.000Z"},
    });
  });
});

describe("Effect receipt event automaton", () => {
  it.each([
    ["missing history", {...safeReceipt(), events: []}, "RECEIPT_INVALID"],
    [
      "missing terminal verification",
      {...safeReceipt(), events: [event(0, "grant_issued")]},
      "EVENT_SEQUENCE_INVALID",
    ],
    [
      "duplicate event",
      {...safeReceipt(), events: [event(0, "grant_issued"), event(1, "verification_retained"),
        event(1, "verification_retained")]},
      "EVENT_SEQUENCE_INVALID",
    ],
    [
      "reordered grant",
      {...safeReceipt(), events: [event(0, "verification_retained"), event(1, "grant_issued")]},
      "EVENT_SEQUENCE_INVALID",
    ],
    [
      "decreasing event time",
      {...safeReceipt(), events: [event(2, "grant_issued"), event(1, "verification_retained")]},
      "EVENT_SEQUENCE_INVALID",
    ],
    [
      "unknown event",
      {...safeReceipt(), events: [event(0, "grant_issued"),
        {...event(1, "verification_retained"), kind: "worker_claimed"}]},
      "EVENT_INVALID",
    ],
    [
      "non-canonical timestamp",
      {...safeReceipt(), events: [{...event(0, "grant_issued"), at: "2026-09-01 00:00:00Z"},
        event(1, "verification_retained")]},
      "EVENT_INVALID",
    ],
    [
      "promotion before verification",
      {...safeReceipt(), events: [event(0, "grant_issued"), event(1, "candidate_promoted"),
        event(2, "verification_retained")]},
      "EVENT_SEQUENCE_INVALID",
    ],
    [
      "promotion without re-verification",
      {...safeReceipt(), events: [event(0, "grant_issued"), event(1, "verification_retained"),
        event(2, "candidate_promoted")]},
      "EVENT_SEQUENCE_INVALID",
    ],
    [
      "rollback before denial",
      {...rolledBackReceipt(), events: [event(0, "grant_issued"), event(1, "rollback_applied")]},
      "EVENT_SEQUENCE_INVALID",
    ],
    [
      "denial missing recovery terminal",
      {...rolledBackReceipt(), events: [event(0, "grant_issued"), event(1, "verification_denied")]},
      "EVENT_SEQUENCE_INVALID",
    ],
    [
      "effect denial before unchanged verification",
      {...preDispatchReceipt(), events: [event(0, "grant_issued"),
        event(1, "effect_denied_pre_dispatch")]},
      "EVENT_SEQUENCE_INVALID",
    ],
    [
      "event after terminal rollback",
      {...rolledBackReceipt(), events: [...rolledBackReceipt().events,
        event(3, "verification_retained")]},
      "EVENT_SEQUENCE_INVALID",
    ],
  ] as const)("rejects %s", (_label, receipt, code) => {
    expectCode(receipt, code);
  });
});

describe("Effect receipt terminal contradictions", () => {
  it.each([
    ["pending terminal", {...safeReceipt(), verdict: "pending"}],
    ["retained under a non-write sandbox", {...safeReceipt(), sandboxMode: "read-only"}],
    ["retained denial reason", {...safeReceipt(), denialReason: "not actually safe"}],
    ["retained recovery", {...safeReceipt(), recovery: "rolled_back", recoveredManifestDigest: before}],
    ["pre-dispatch changed file", {...preDispatchReceipt(), changedFiles: ["surprise.txt"]}],
    ["pre-dispatch manifest drift", {...preDispatchReceipt(), afterManifestDigest: after}],
    [
      "pre-dispatch worker spawned",
      {...preDispatchReceipt(), effectDecision: {...preDispatchReceipt().effectDecision!, workerSpawned: true}},
    ],
    ["rollback did not converge", {...rolledBackReceipt(), recoveredManifestDigest: recoveredWrong}],
    ["rollback missing denial reason", {...rolledBackReceipt(), denialReason: null}],
    ["rollback carries pre-dispatch decision", {
      ...rolledBackReceipt(), effectDecision: preDispatchReceipt().effectDecision,
    }],
    ["grant denial claims a baseline", {...grantDeniedReceipt(), beforeManifestDigest: before}],
  ])("rejects %s", (_label, receipt) => {
    expectCode(receipt, "TERMINAL_CONTRADICTION");
  });
});

describe("Deterministic canonical chain", () => {
  it("is independent of object insertion order", () => {
    const receipt = safeReceipt();
    const reordered = {
      events: receipt.events,
      changedFiles: receipt.changedFiles,
      recovery: receipt.recovery,
      recoveredManifestDigest: receipt.recoveredManifestDigest,
      afterManifestDigest: receipt.afterManifestDigest,
      beforeManifestDigest: receipt.beforeManifestDigest,
      denialReason: receipt.denialReason,
      verdict: receipt.verdict,
      sandboxMode: receipt.sandboxMode,
      grantedScope: receipt.grantedScope,
      runId: receipt.runId,
      agentId: receipt.agentId,
      version: receipt.version,
    } satisfies RunGuardReceipt;
    expect(computeEffectReceiptChainHead(receipt)).toBe(computeEffectReceiptChainHead(reordered));
    expect(validateEffectReceiptHistory(receipt).chainHead)
      .toBe(validateEffectReceiptHistory(reordered).chainHead);
  });

  it("detects valid-looking event and terminal tampering against a trusted head", () => {
    const original = safeReceipt();
    const trustedChainHead = validateEffectReceiptHistory(original).chainHead;
    const eventTamper = structuredClone(original);
    eventTamper.events[1]!.detail = "plausible but altered detail";
    expectCode(eventTamper, "CHAIN_HEAD_MISMATCH", {trustedChainHead});

    const terminalTamper = structuredClone(original);
    terminalTamper.changedFiles.push("another-safe-looking-file.txt");
    expectCode(terminalTamper, "CHAIN_HEAD_MISMATCH", {trustedChainHead});
  });

  it("rejects an invalid trusted head instead of silently ignoring it", () => {
    expectCode(safeReceipt(), "CHAIN_HEAD_MISMATCH", {trustedChainHead: "not-a-digest"});
  });
});

describe("Current functional receipt projection", () => {
  it("accepts the three current Track #1 terminal summaries when projected with their legal event sequences", async () => {
    const path = new URL(
      "../../../research/evidence/2026-09-01-track-c-functional-flow/current.json",
      import.meta.url,
    );
    const document = JSON.parse(await readFile(path, "utf8")) as {
      track: string;
      sequence: Record<string, {
        runId: string;
        guardVerdict: "retained" | "denied";
        recovery: "not_needed" | "rolled_back";
        changedFiles: string[];
        beforeManifestDigest: string;
        afterManifestDigest: string;
        recoveredManifestDigest: string | null;
        effectDecision: RunGuardReceipt["effectDecision"] | null;
      }>;
    };
    expect(document.track).toContain("Track #1");

    const project = (
      key: string,
      events: RunGuardReceipt["events"],
      denialReason: string | null,
    ): RunGuardReceipt => {
      const row = document.sequence[key];
      if (!row) throw new Error(`missing functional row ${key}`);
      return {
        version: 1,
        agentId: "current-functional-fixture",
        runId: row.runId,
        grantedScope: "agent-workspace-only",
        sandboxMode: "workspace-write",
        verdict: row.guardVerdict,
        denialReason,
        beforeManifestDigest: row.beforeManifestDigest,
        afterManifestDigest: row.afterManifestDigest,
        recoveredManifestDigest: row.recoveredManifestDigest,
        recovery: row.recovery,
        changedFiles: row.changedFiles,
        ...(row.effectDecision ? {effectDecision: row.effectDecision} : {}),
        events,
      };
    };

    expect(validateEffectReceiptHistory(project("normalRun", [
      event(0, "grant_issued"), event(1, "verification_retained"),
    ], null)).family).toBe("safe_retained");
    expect(validateEffectReceiptHistory(project("effectFirewallDeniedRun", [
      event(0, "grant_issued"), event(1, "verification_retained"),
      event(2, "effect_denied_pre_dispatch"),
    ], "Effect Firewall denied a protected action before worker dispatch")).family)
      .toBe("effect_denied_pre_dispatch");
    expect(validateEffectReceiptHistory(project("postRunMaliciousRun", [
      event(0, "grant_issued"), event(1, "verification_denied"), event(2, "rollback_applied"),
    ], "RunGuard blocked a protected workspace-path mutation")).family)
      .toBe("post_run_rolled_back");
  });
});
