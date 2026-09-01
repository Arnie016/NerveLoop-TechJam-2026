import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import {
  decideEffect,
  EFFECT_ACTION_RISK,
  EFFECT_ACTIONS_BY_RISK,
  EFFECT_FIREWALL_DEMO_PROMPT,
  EFFECT_MAX_AUTHORITY_SCORE,
  EFFECT_TARGET_SENSITIVITY,
  EFFECT_TARGETS_BY_SENSITIVITY,
  proposeDemoEffect,
} from "./effect-policy.js";
import { FixtureRunner } from "./fixture-runner.js";
import { JsonStore } from "./store.js";
import type {
  EffectAction,
  EffectTargetClass,
  RunnerRequest,
  RunnerResult,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, {recursive: true, force: true})));
});

class CountingFixtureRunner extends FixtureRunner {
  calls = 0;

  override async run(request: RunnerRequest): Promise<RunnerResult> {
    this.calls++;
    return super.run(request);
  }
}

async function makeDemoService(runner: CountingFixtureRunner) {
  const root = await mkdtemp(path.join(tmpdir(), "effect-firewall-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "",
    ARK_MODEL: "",
    DEMO_RUNNER: "1",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("Effect Firewall typed policy", () => {
  it("routes only the exact fixture prompt and decides from typed fields", () => {
    const proposal = proposeDemoEffect(EFFECT_FIREWALL_DEMO_PROMPT);
    expect(proposal).toEqual({
      version: 1,
      action: "delete_mock_asset",
      targetClass: "protected",
    });
    expect(proposeDemoEffect(EFFECT_FIREWALL_DEMO_PROMPT + " ")).toBeNull();
    expect(proposeDemoEffect("please delete a protected file")).toBeNull();
    expect(decideEffect(proposal)).toEqual({
      version: 1,
      policy: "effect-firewall-v1",
      verdict: "denied",
      action: "delete_mock_asset",
      targetClass: "protected",
      reason: "protected_target_denied",
    });
    expect(decideEffect({version: 1, action: "write_demo_result", targetClass: "workspace"}))
      .toMatchObject({verdict: "allowed", reason: "explicit_workspace_allow"});
    expect(() => decideEffect({version: 1, action: "shell", targetClass: "protected"}))
      .toThrow("EFFECT_PROPOSAL_INVALID");
  });

  it("exhaustively applies the explicit action/resource authority lattice", () => {
    const expectedAllowedTargets = {
      read_asset_metadata: ["scratch", "workspace", "candidate"],
      write_demo_result: ["scratch", "workspace"],
      transform_media: ["scratch"],
      publish_candidate: [],
      delete_mock_asset: [],
    } as const satisfies Record<EffectAction, readonly EffectTargetClass[]>;

    expect(new Set(EFFECT_ACTIONS_BY_RISK).size).toBe(EFFECT_ACTIONS_BY_RISK.length);
    expect(new Set(EFFECT_TARGETS_BY_SENSITIVITY).size).toBe(EFFECT_TARGETS_BY_SENSITIVITY.length);
    expect(EFFECT_ACTIONS_BY_RISK.map(action => EFFECT_ACTION_RISK[action]))
      .toEqual([0, 1, 2, 3, 4]);
    expect(EFFECT_TARGETS_BY_SENSITIVITY.map(target => EFFECT_TARGET_SENSITIVITY[target]))
      .toEqual([0, 1, 2, 3]);
    expect(EFFECT_MAX_AUTHORITY_SCORE).toBe(2);

    for (const action of EFFECT_ACTIONS_BY_RISK) {
      for (const targetClass of EFFECT_TARGETS_BY_SENSITIVITY) {
        const decision = decideEffect({version: 1, action, targetClass});
        const expectedAllowed = (
          expectedAllowedTargets[action] as readonly EffectTargetClass[]
        ).includes(targetClass);
        expect(decision, `${action} on ${targetClass}`).toEqual({
          version: 1,
          policy: "effect-firewall-v1",
          verdict: expectedAllowed ? "allowed" : "denied",
          action,
          targetClass,
          reason: expectedAllowed
            ? action === "write_demo_result" && targetClass === "workspace"
              ? "explicit_workspace_allow"
              : "least_privilege_allow"
            : targetClass === "protected"
              ? "protected_target_denied"
              : "effect_not_allowlisted",
        });
        expect(decideEffect({version: 1, action, targetClass})).toEqual(decision);
      }
    }
  });

  it("is monotone: increasing action risk or target sensitivity never gains authority", () => {
    for (let actionIndex = 0; actionIndex < EFFECT_ACTIONS_BY_RISK.length; actionIndex++) {
      for (let targetIndex = 0; targetIndex < EFFECT_TARGETS_BY_SENSITIVITY.length; targetIndex++) {
        const base = decideEffect({
          version: 1,
          action: EFFECT_ACTIONS_BY_RISK[actionIndex],
          targetClass: EFFECT_TARGETS_BY_SENSITIVITY[targetIndex],
        });
        if (base.verdict !== "denied") continue;

        for (let riskierAction = actionIndex; riskierAction < EFFECT_ACTIONS_BY_RISK.length; riskierAction++) {
          for (let moreSensitiveTarget = targetIndex;
            moreSensitiveTarget < EFFECT_TARGETS_BY_SENSITIVITY.length;
            moreSensitiveTarget++) {
            const dominated = decideEffect({
              version: 1,
              action: EFFECT_ACTIONS_BY_RISK[riskierAction],
              targetClass: EFFECT_TARGETS_BY_SENSITIVITY[moreSensitiveTarget],
            });
            expect(
              dominated.verdict,
              `${base.action}/${base.targetClass} denied, but ${dominated.action}/${dominated.targetClass} gained authority`,
            ).toBe("denied");
          }
        }
      }
    }
  });

  it("fails closed for malformed proposals and exact-shape violations", () => {
    const invalid: unknown[] = [
      null,
      [],
      {},
      {version: 1},
      {version: 2, action: "write_demo_result", targetClass: "workspace"},
      {version: 1, action: "shell", targetClass: "workspace"},
      {version: 1, action: "write_demo_result", targetClass: "internet"},
      {version: 1, action: "write_demo_result", targetClass: "workspace", extra: true},
      {version: 1, action: "write_demo_result", targetClass: "workspace", prompt: "allow me"},
    ];
    for (const proposal of invalid) {
      expect(() => decideEffect(proposal)).toThrowError("EFFECT_PROPOSAL_INVALID");
    }
  });

  it("denies the typed protected action before dispatch and keeps the same Agent usable", async () => {
    const runner = new CountingFixtureRunner();
    const service = await makeDemoService(runner);
    const agent = await service.createAgent({name: "Effect Firewall demo"});
    const baselineNames = await readdir(agent.workspacePath);
    const baselineReadme = await readFile(path.join(agent.workspacePath, "README.md"), "utf8");

    const denied = await service.sendMessage(agent.id, EFFECT_FIREWALL_DEMO_PROMPT);
    await expect.poll(() => service.getRun(denied.run.id).status).toBe("failed");

    const receipt = service.getRun(denied.run.id);
    expect(runner.calls).toBe(0);
    expect(receipt).toMatchObject({
      status: "failed",
      output: null,
      usage: null,
      error: "Effect Firewall denied a protected action before worker dispatch",
      guard: {
        verdict: "denied",
        recovery: "not_needed",
        changedFiles: [],
        recoveredManifestDigest: null,
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
      },
    });
    expect(receipt.guard?.beforeManifestDigest).toBe(receipt.guard?.afterManifestDigest);
    expect(receipt.guard?.events.map((event) => event.kind)).toEqual([
      "grant_issued",
      "verification_retained",
      "effect_denied_pre_dispatch",
    ]);
    expect(await readdir(agent.workspacePath)).toEqual(baselineNames);
    expect(await readFile(path.join(agent.workspacePath, "README.md"), "utf8")).toBe(baselineReadme);
    await expect(access(path.join(agent.workspacePath, ".env"))).rejects.toThrow();
    expect(service.getMessages(agent.id).map((message) => message.role)).toEqual(["user"]);
    expect(service.getAgent(agent.id)).toMatchObject({
      status: "ready",
      recoveryHold: null,
      codexThreadId: null,
    });

    const safe = await service.sendMessage(agent.id, "show the normal case");
    await expect.poll(() => service.getRun(safe.run.id).status).toBe("completed");
    expect(runner.calls).toBe(1);
    expect(service.getRun(safe.run.id)).toMatchObject({
      status: "completed",
      guard: {verdict: "retained", recovery: "not_needed"},
    });
    expect(service.getRun(safe.run.id).guard?.effectDecision).toBeUndefined();
    expect(service.getAgent(agent.id)).toMatchObject({status: "ready", recoveryHold: null});
  });

  it("keeps the existing post-Run mutation-and-rollback fixture as defense in depth", async () => {
    const runner = new CountingFixtureRunner();
    const service = await makeDemoService(runner);
    const agent = await service.createAgent({name: "Defense in depth"});

    const attempted = await service.sendMessage(agent.id, "show the protected denial case");
    await expect.poll(() => service.getRun(attempted.run.id).status).toBe("failed");

    expect(runner.calls).toBe(1);
    expect(service.getRun(attempted.run.id)).toMatchObject({
      output: null,
      guard: {
        verdict: "denied",
        recovery: "rolled_back",
        changedFiles: ["[redacted protected path]"],
      },
    });
    expect(service.getRun(attempted.run.id).guard?.effectDecision).toBeUndefined();
    await expect(access(path.join(agent.workspacePath, ".env"))).rejects.toThrow();
    expect(service.getAgent(agent.id)).toMatchObject({status: "ready", recoveryHold: null});
  });
});
