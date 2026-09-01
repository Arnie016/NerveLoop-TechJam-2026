import { describe, expect, it } from "vitest";
import {
  EFFECT_FIREWALL_POLICY_DIGEST,
  EffectCapabilityError,
  EffectCapabilityRegistry,
  bindingFromCapability,
} from "./effect-capability.js";
import { decideEffect } from "./effect-policy.js";
import type { EffectCapabilityBinding, EffectCapabilityReceipt } from "./types.js";

const allowed = () => decideEffect({
  version: 1,
  action: "write_demo_result",
  targetClass: "workspace",
});

function errorCode(operation: () => unknown): string | undefined {
  try {
    operation();
  } catch (error) {
    return error instanceof EffectCapabilityError ? error.code : undefined;
  }
  return undefined;
}

type ModelOperation = "claim_valid" | "claim_binding_drift" | "consume_valid";
type ModelState = EffectCapabilityReceipt["state"];

function operationTraces(
  alphabet: readonly ModelOperation[],
  maximumLength: number,
): ModelOperation[][] {
  const traces: ModelOperation[][] = [];
  let frontier: ModelOperation[][] = [[]];
  for (let length = 1; length <= maximumLength; length++) {
    frontier = frontier.flatMap((prefix) =>
      alphabet.map((operation) => [...prefix, operation]));
    traces.push(...frontier);
  }
  return traces;
}

/** Deliberately tiny and independent from the registry implementation. */
function oracleStep(
  state: ModelState,
  operation: ModelOperation,
): {state: ModelState; error?: string} {
  if (operation === "claim_binding_drift") {
    return {state, error: "EFFECT_CAPABILITY_BINDING_MISMATCH"};
  }
  if (operation === "claim_valid") {
    return state === "issued"
      ? {state: "claimed"}
      : {state, error: "EFFECT_CAPABILITY_ALREADY_CLAIMED"};
  }
  if (state === "issued") {
    return {state, error: "EFFECT_CAPABILITY_NOT_CLAIMED"};
  }
  return state === "claimed"
    ? {state: "consumed"}
    : {state, error: "EFFECT_CAPABILITY_ALREADY_CONSUMED"};
}

describe("process-local Effect Capability registry", () => {
  it("moves one exact Run-bound grant through issued, claimed, and consumed", () => {
    let milliseconds = 1_700_000_000_000;
    const registry = new EffectCapabilityRegistry({
      now: () => milliseconds,
      grantId: () => "grant_one",
    });
    const issued = registry.issue({
      runId: "run_one",
      agentId: "agent_one",
      decision: allowed(),
      ttlMs: 1_000,
    });
    expect(issued).toMatchObject({
      version: 1,
      registry: "process-local",
      grantId: "grant_one",
      state: "issued",
      runId: "run_one",
      agentId: "agent_one",
      action: "write_demo_result",
      targetClass: "workspace",
      policy: "effect-firewall-v1",
      policyVersion: 1,
      policyDigest: EFFECT_FIREWALL_POLICY_DIGEST,
      claimedAt: null,
      consumedAt: null,
      useBudget: 1,
      usesClaimed: 0,
    });
    expect(issued.boundary).toContain("not authentication");
    const binding = bindingFromCapability(issued);

    milliseconds++;
    const claimed = registry.claim(issued, binding);
    expect(claimed).toMatchObject({state: "claimed", usesClaimed: 1, consumedAt: null});
    expect(claimed.claimedAt).not.toBeNull();

    milliseconds++;
    const consumed = registry.consume(claimed, binding);
    expect(consumed).toMatchObject({state: "consumed", usesClaimed: 1});
    expect(consumed.consumedAt).not.toBeNull();
    expect(registry.inspect(consumed.grantId)).toEqual(consumed);
    expect(errorCode(() => registry.claim(consumed, binding)))
      .toBe("EFFECT_CAPABILITY_ALREADY_CLAIMED");
    expect(errorCode(() => registry.consume(consumed, binding)))
      .toBe("EFFECT_CAPABILITY_ALREADY_CONSUMED");
  });

  it.each([
    ["different Run", {runId: "run_other"}],
    ["different Agent", {agentId: "agent_other"}],
    ["action drift", {action: "read_asset_metadata"}],
    ["target drift", {targetClass: "scratch"}],
    ["policy-name drift", {policy: "effect-firewall-v2"}],
    ["policy-version drift", {policyVersion: 2}],
    ["policy-digest drift", {policyDigest: "f".repeat(64)}],
  ] as const)("fails closed on %s before spending the grant", (_label, drift) => {
    const registry = new EffectCapabilityRegistry({grantId: () => "binding_grant"});
    const issued = registry.issue({runId: "run_one", agentId: "agent_one", decision: allowed()});
    const expected = {...bindingFromCapability(issued), ...drift} as EffectCapabilityBinding;
    expect(errorCode(() => registry.claim(issued, expected)))
      .toBe("EFFECT_CAPABILITY_BINDING_MISMATCH");
    expect(registry.inspect(issued.grantId)?.state).toBe("issued");
    expect(registry.inspect(issued.grantId)?.usesClaimed).toBe(0);
  });

  it("rejects altered grant snapshots and unknown grant identifiers", () => {
    const registry = new EffectCapabilityRegistry({grantId: () => "unaltered_grant"});
    const issued = registry.issue({runId: "run_one", agentId: "agent_one", decision: allowed()});
    const binding = bindingFromCapability(issued);
    const altered = {...issued, expiresAt: new Date(Date.parse(issued.expiresAt) + 1).toISOString()};
    expect(errorCode(() => registry.claim(altered, binding)))
      .toBe("EFFECT_CAPABILITY_INVALID");
    expect(errorCode(() => registry.claim({...issued, grantId: "unknown_grant"}, binding)))
      .toBe("EFFECT_CAPABILITY_INVALID");
    expect(registry.inspect(issued.grantId)?.state).toBe("issued");
  });

  it("never issues authority for a denied effect", () => {
    const registry = new EffectCapabilityRegistry({grantId: () => "must_not_exist"});
    const denied = decideEffect({
      version: 1,
      action: "delete_mock_asset",
      targetClass: "protected",
    });
    expect(errorCode(() => registry.issue({runId: "run_one", agentId: "agent_one", decision: denied})))
      .toBe("EFFECT_CAPABILITY_DECISION_DENIED");
    expect(registry.size).toBe(0);
    expect(registry.inspect("must_not_exist")).toBeNull();
  });

  it("spends only one claim under concurrent attempts", async () => {
    const registry = new EffectCapabilityRegistry({grantId: () => "race_grant"});
    const issued = registry.issue({runId: "run_one", agentId: "agent_one", decision: allowed()});
    const binding = bindingFromCapability(issued);
    const attempts = await Promise.allSettled([
      Promise.resolve().then(() => registry.claim(issued, binding)),
      Promise.resolve().then(() => registry.claim(issued, binding)),
      Promise.resolve().then(() => registry.claim(issued, binding)),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(2);
    expect(registry.inspect(issued.grantId)).toMatchObject({state: "claimed", usesClaimed: 1});
  });

  it("expires before claim or dispatch and does not reopen the budget", () => {
    let milliseconds = 1_700_000_000_000;
    const expiredBeforeClaim = new EffectCapabilityRegistry({
      now: () => milliseconds,
      grantId: () => "expired_claim",
    });
    const issued = expiredBeforeClaim.issue({
      runId: "run_one", agentId: "agent_one", decision: allowed(), ttlMs: 10,
    });
    milliseconds += 10;
    expect(errorCode(() => expiredBeforeClaim.claim(issued, bindingFromCapability(issued))))
      .toBe("EFFECT_CAPABILITY_EXPIRED");
    expect(expiredBeforeClaim.inspect(issued.grantId)).toMatchObject({state: "issued", usesClaimed: 0});

    milliseconds = 1_700_000_000_000;
    const expiredBeforeConsume = new EffectCapabilityRegistry({
      now: () => milliseconds,
      grantId: () => "expired_consume",
    });
    const fresh = expiredBeforeConsume.issue({
      runId: "run_two", agentId: "agent_one", decision: allowed(), ttlMs: 10,
    });
    const binding = bindingFromCapability(fresh);
    milliseconds++;
    const claimed = expiredBeforeConsume.claim(fresh, binding);
    milliseconds += 9;
    expect(errorCode(() => expiredBeforeConsume.consume(claimed, binding)))
      .toBe("EFFECT_CAPABILITY_EXPIRED");
    expect(expiredBeforeConsume.inspect(fresh.grantId)).toMatchObject({state: "claimed", usesClaimed: 1});
  });

  it("rejects duplicate grant identifiers and invalid use budgets", () => {
    const registry = new EffectCapabilityRegistry({grantId: () => "duplicate_grant"});
    registry.issue({runId: "run_one", agentId: "agent_one", decision: allowed()});
    expect(errorCode(() => registry.issue({runId: "run_two", agentId: "agent_one", decision: allowed()})))
      .toBe("EFFECT_CAPABILITY_INVALID");
    const ttlRegistry = new EffectCapabilityRegistry({grantId: () => "ttl_grant"});
    for (const ttlMs of [0, -1, 15_001, 1.5, Number.NaN]) {
      expect(errorCode(() => ttlRegistry.issue({
        runId: "run_one", agentId: "agent_one", decision: allowed(), ttlMs,
      }))).toBe("EFFECT_CAPABILITY_INVALID");
    }
  });

  it("does not trust a claimed receipt reconstructed outside its host registry", () => {
    const registry = new EffectCapabilityRegistry({grantId: () => "host_grant"});
    const issued = registry.issue({runId: "run_one", agentId: "agent_one", decision: allowed()});
    const forged = {
      ...issued,
      state: "claimed",
      claimedAt: issued.issuedAt,
      usesClaimed: 1,
    } as EffectCapabilityReceipt;
    expect(errorCode(() => registry.consume(forged, bindingFromCapability(forged))))
      .toBe("EFFECT_CAPABILITY_INVALID");
    expect(registry.inspect(issued.grantId)?.state).toBe("issued");
  });

  it("matches an independent one-use lifecycle oracle across all 120 bounded traces", () => {
    const alphabet = [
      "claim_valid",
      "claim_binding_drift",
      "consume_valid",
    ] as const satisfies readonly ModelOperation[];
    const traces = operationTraces(alphabet, 4);
    expect(traces).toHaveLength(3 + 9 + 27 + 81);

    for (const [traceIndex, trace] of traces.entries()) {
      let milliseconds = 1_700_000_000_000;
      const registry = new EffectCapabilityRegistry({
        now: () => milliseconds,
        grantId: () => `model_grant_${traceIndex}`,
      });
      let latest = registry.issue({
        runId: "run_model",
        agentId: "agent_model",
        decision: allowed(),
      });
      const binding = bindingFromCapability(latest);
      const driftedBinding = {
        ...binding,
        action: "read_asset_metadata",
      } as EffectCapabilityBinding;
      let oracleState: ModelState = "issued";
      let successfulClaims = 0;
      let successfulConsumes = 0;

      for (const [stepIndex, operation] of trace.entries()) {
        milliseconds++;
        const expected = oracleStep(oracleState, operation);
        let actualError: string | undefined;
        try {
          if (operation === "claim_valid") {
            latest = registry.claim(latest, binding);
          } else if (operation === "claim_binding_drift") {
            latest = registry.claim(latest, driftedBinding);
          } else {
            latest = registry.consume(latest, binding);
          }
        } catch (error) {
          if (!(error instanceof EffectCapabilityError)) throw error;
          actualError = error.code;
        }

        if (actualError === undefined && operation === "claim_valid") successfulClaims++;
        if (actualError === undefined && operation === "consume_valid") successfulConsumes++;
        oracleState = expected.state;
        const observed = registry.inspect(latest.grantId);
        const traceLabel = `${trace.join(" -> ")} @ ${stepIndex + 1}`;

        expect({trace: traceLabel, error: actualError})
          .toEqual({trace: traceLabel, error: expected.error});
        expect({trace: traceLabel, state: observed?.state})
          .toEqual({trace: traceLabel, state: oracleState});
        expect({trace: traceLabel, usesClaimed: observed?.usesClaimed})
          .toEqual({trace: traceLabel, usesClaimed: oracleState === "issued" ? 0 : 1});
        expect(observed).toEqual(latest);
        expect(successfulClaims).toBeLessThanOrEqual(1);
        expect(successfulConsumes).toBeLessThanOrEqual(1);
        expect(successfulConsumes).toBeLessThanOrEqual(successfulClaims);
      }
    }
  });
});
