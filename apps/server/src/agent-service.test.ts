import { access, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import {
  EFFECT_SINK_DEMO_RESULT_PATH,
  EFFECT_SINK_DEMO_RESULT_PAYLOAD,
} from "./effect-sink.js";
import { EFFECT_FIREWALL_DEMO_PROMPT } from "./effect-policy.js";
import { EFFECT_FIREWALL_ALLOWED_DEMO_PROMPT, FixtureRunner } from "./fixture-runner.js";
import { JsonStore } from "./store.js";
import type { AgentRun, AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(
  runner: AgentRunner = new FakeRunner(),
  overrides: NodeJS.ProcessEnv = {},
  effectSinkOptions: {
    beforeIo?: () => void | Promise<void>;
    beforeInitialReceiptPersist?: () => void | Promise<void>;
    onIssued?: (authority: NonNullable<RunnerRequest["effectSink"]>) => void;
    onClosed?: (receipt: NonNullable<AgentRun["effectSinkReceipt"]>) => void;
  } = {},
): Promise<AgentService> {
  return (await makeServiceHarness(runner, overrides, effectSinkOptions)).service;
}

async function makeServiceHarness(
  runner: AgentRunner = new FakeRunner(),
  overrides: NodeJS.ProcessEnv = {},
  effectSinkOptions: {
    beforeIo?: () => void | Promise<void>;
    beforeInitialReceiptPersist?: () => void | Promise<void>;
    onIssued?: (authority: NonNullable<RunnerRequest["effectSink"]>) => void;
    onClosed?: (receipt: NonNullable<AgentRun["effectSinkReceipt"]>) => void;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    ...overrides,
  });
  const reopen = async () => {
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const service = new AgentService(
      config, store, new WorkspaceManager(path.join(root, "workspaces")), runner,
      null, null, effectSinkOptions,
    );
    await service.initialize();
    return { service, store };
  };
  return { ...await reopen(), reopen, config };
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("retains a Run only after a workspace-scoped evidence receipt verifies", async () => {
    const runner: AgentRunner = {
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "result.txt"), "verified output", "utf8");
        return { output: "done", threadId: "thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Guarded" });
    const { run } = await service.sendMessage(agent.id, "write a bounded result");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(service.getRun(run.id).guard).toMatchObject({
      verdict: "retained",
      grantedScope: "agent-workspace-only",
      changedFiles: ["result.txt"],
    });
  });

  it("denies a protected workspace mutation and keeps the Agent controllable", async () => {
    const runner: AgentRunner = {
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, ".env"), "not retained", "utf8");
        return { output: "do not promote", threadId: "thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Guarded" });
    const { run } = await service.sendMessage(agent.id, "write a prohibited file");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    expect(service.getRun(run.id).guard).toMatchObject({
      verdict: "denied",
      recovery: "rolled_back",
      changedFiles: ["[redacted protected path]"],
    });
    await expect(access(path.join(agent.workspacePath, ".env"))).rejects.toThrow();
    expect(service.getRun(run.id).error).toContain("protected workspace-path mutation");
    expect(service.getAgent(agent.id).status).toBe("ready");
    expect(service.getMessages(agent.id).map((message) => message.role)).toEqual(["user"]);
  });

  it("denies a modification to a protected file that predates the Run", async () => {
    const runner: AgentRunner = {
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, ".env"), "rotated fixture value", "utf8");
        return { output: "do not retain this change", threadId: "thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Existing protected file" });
    await writeFile(path.join(agent.workspacePath, ".env"), "baseline fixture value", "utf8");

    const { run } = await service.sendMessage(agent.id, "modify an existing protected file");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    expect(service.getRun(run.id).guard).toMatchObject({
      verdict: "denied",
      recovery: "rolled_back",
      changedFiles: ["[redacted protected path]"],
    });
    await expect(readFile(path.join(agent.workspacePath, ".env"), "utf8")).resolves.toBe(
      "baseline fixture value",
    );
    expect(service.getMessages(agent.id).map((message) => message.role)).toEqual(["user"]);
  });

  it("denies and removes a symbolic-link escape attempt without following its target", async () => {
    const runner: AgentRunner = {
      run: async (request) => {
        await symlink("../../outside-target", path.join(request.workspacePath, "escape-link"));
        return { output: "do not retain this symlink", threadId: "thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Symlink attacker" });

    const { run } = await service.sendMessage(agent.id, "create a workspace link");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    expect(service.getRun(run.id).guard).toMatchObject({
      verdict: "denied",
      recovery: "rolled_back",
      changedFiles: ["[redacted unsafe symlink path]"],
    });
    await expect(lstat(path.join(agent.workspacePath, "escape-link"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(service.getMessages(agent.id).map((message) => message.role)).toEqual(["user"]);
  });

  it.skipIf(process.platform === "win32")("withholds output for a hard-link swap without overwriting the outside fixture", async () => {
    let external = "";
    const service = await makeService({
      run: async (request) => {
        const target = path.join(request.workspacePath, ".env");
        await rm(target);
        await link(external, target);
        return { output: "must not promote this result", threadId: "unsafe-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Hard-link fixture" });
    external = path.join(path.dirname(agent.workspacePath), "outside-fixture.txt");
    await writeFile(external, "outside sentinel");
    await writeFile(path.join(agent.workspacePath, ".env"), "baseline fixture");
    const { run } = await service.sendMessage(agent.id, "controlled hard-link swap");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    expect(service.getRun(run.id)).toMatchObject({
      output: null, guard: { verdict: "denied", recovery: "rolled_back" },
    });
    expect(await readFile(external, "utf8")).toBe("outside sentinel");
    expect(await readFile(path.join(agent.workspacePath, ".env"), "utf8")).toBe("baseline fixture");
    expect(service.getMessages(agent.id).map((message) => message.role)).toEqual(["user"]);
    expect(service.getAgent(agent.id)).toMatchObject({ status: "ready", recoveryHold: null, codexThreadId: null });
  });

  it("denies a workspace-root symlink swap without writing through its target", async () => {
    let outsideRoot = "";
    let outsideSentinel = "";
    const runner: AgentRunner = {
      run: async (request) => {
        outsideRoot = path.join(path.dirname(request.workspacePath), "outside-root");
        outsideSentinel = path.join(outsideRoot, "sentinel.txt");
        await mkdir(outsideRoot);
        await writeFile(outsideSentinel, "do not alter", "utf8");
        await rm(request.workspacePath, { recursive: true, force: true });
        await symlink(outsideRoot, request.workspacePath);
        return { output: "do not retain this root swap", threadId: "thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Root swap attacker" });

    const { run } = await service.sendMessage(agent.id, "replace the workspace root");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    expect(service.getRun(run.id).guard).toMatchObject({
      verdict: "denied",
      recovery: "rolled_back",
      changedFiles: ["[redacted unsafe workspace root]"],
    });
    await expect(readFile(outsideSentinel, "utf8")).resolves.toBe("do not alter");
    const restoredRoot = await lstat(agent.workspacePath);
    expect(restoredRoot.isDirectory()).toBe(true);
    expect(restoredRoot.isSymbolicLink()).toBe(false);
    expect(service.getMessages(agent.id).map((message) => message.role)).toEqual(["user"]);
  });

  it("quarantines an unverifiable workspace and restores the checkpoint without error leakage", async () => {
    const runner: AgentRunner = {
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, ".env"), "not retained", "utf8");
        await writeFile(
          path.join(request.workspacePath, "oversized.bin"),
          Buffer.alloc(1_000_001),
        );
        return { output: "do not retain this unverifiable Run", threadId: "thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Unverifiable workspace" });

    const { run } = await service.sendMessage(agent.id, "create an oversized workspace artifact");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    expect(service.getRun(run.id).guard).toMatchObject({
      verdict: "denied",
      recovery: "rolled_back",
      changedFiles: ["[redacted unverifiable workspace]"],
    });
    await expect(access(path.join(agent.workspacePath, ".env"))).rejects.toThrow();
    await expect(access(path.join(agent.workspacePath, "oversized.bin"))).rejects.toThrow();
    expect(service.getRun(run.id).guard?.events.map((event) => event.detail).join(" ")).not.toContain(
      "oversized.bin",
    );
    expect(service.getMessages(agent.id).map((message) => message.role)).toEqual(["user"]);
  });

  it("does not silently retain a protected payload in a formerly ignored workspace directory", async () => {
    const runner: AgentRunner = {
      run: async (request) => {
        const runtimeDirectory = path.join(request.workspacePath, ".codex");
        await mkdir(runtimeDirectory);
        await writeFile(path.join(runtimeDirectory, "secret-payload"), "not retained", "utf8");
        return { output: "do not retain this hidden payload", threadId: "thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Ignored directory attacker" });

    const { run } = await service.sendMessage(agent.id, "write into an ignored directory");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    expect(service.getRun(run.id).guard).toMatchObject({
      verdict: "denied",
      recovery: "rolled_back",
      changedFiles: ["[redacted protected path]"],
    });
    await expect(access(path.join(agent.workspacePath, ".codex", "secret-payload"))).rejects.toThrow();
    await expect(access(path.join(agent.workspacePath, ".codex"))).rejects.toThrow();
    expect(service.getMessages(agent.id).map((message) => message.role)).toEqual(["user"]);
  });

  it("binds each allowed demo effect to one Run grant while protected denial dispatches nothing", async () => {
    class TrackingFixtureRunner extends FixtureRunner {
      readonly requests: Array<{
        runId: string;
        agentId: string;
        opaqueGrant: string | null;
        hasRedeemPort: boolean;
        receivedParentCapability: boolean;
      }> = [];
      override async run(request: RunnerRequest): Promise<RunnerResult> {
        this.requests.push({
          runId: request.runId,
          agentId: request.agentId,
          opaqueGrant: request.effectSink?.grant ?? null,
          hasRedeemPort: typeof request.effectSink?.port.redeem === "function",
          receivedParentCapability: "effectCapability" in request,
        });
        return super.run(request);
      }
    }
    const runner = new TrackingFixtureRunner();
    const service = await makeService(runner, {
      ARK_API_KEY: "",
      ARK_MODEL: "",
      DEMO_RUNNER: "1",
    });
    await expect(service.systemInfo()).resolves.toMatchObject({
      arkConfigured: false,
      demoRunner: true,
      runtime: "RunGuard controlled fixture",
    });
    const agent = await service.createAgent({ name: "Demo" });

    const retained = await service.sendMessage(agent.id, EFFECT_FIREWALL_ALLOWED_DEMO_PROMPT);
    await expect.poll(() => service.getRun(retained.run.id).status).toBe("completed");
    expect(service.getRun(retained.run.id)).toMatchObject({
      guard: {verdict: "retained", recovery: "not_needed"},
      effectCapability: {
        state: "consumed",
        runId: retained.run.id,
        agentId: agent.id,
        action: "write_demo_result",
        targetClass: "workspace",
        useBudget: 1,
        usesClaimed: 1,
      },
      effectSinkReceipt: {
        state: "committed",
        runId: retained.run.id,
        agentId: agent.id,
        action: "write_demo_result",
        targetClass: "workspace",
        relativePath: "demo-result.md",
        bytesCommitted: 85,
        errorCode: null,
      },
    });
    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]).toMatchObject({
      runId: retained.run.id,
      agentId: agent.id,
      hasRedeemPort: true,
      receivedParentCapability: false,
    });
    expect(runner.requests[0]?.opaqueGrant).toEqual(expect.any(String));
    expect(JSON.stringify(service.getRun(retained.run.id).effectSinkReceipt))
      .not.toContain(runner.requests[0]?.opaqueGrant);

    const denied = await service.sendMessage(agent.id, EFFECT_FIREWALL_DEMO_PROMPT);
    await expect.poll(() => service.getRun(denied.run.id).status).toBe("failed");
    expect(service.getRun(denied.run.id)).toMatchObject({
      output: null,
      guard: {
        verdict: "denied",
        recovery: "not_needed",
        effectDecision: {verdict: "denied", workerSpawned: false},
      },
    });
    expect(service.getRun(denied.run.id).effectCapability).toBeUndefined();
    expect(service.getRun(denied.run.id).effectSinkReceipt).toBeUndefined();
    expect(runner.requests).toHaveLength(1);

    const violated = await service.sendMessage(
      agent.id,
      "Run the protected post-dispatch RunGuard fixture.",
    );
    await expect.poll(() => service.getRun(violated.run.id).status).toBe("failed");
    expect(service.getRun(violated.run.id)).toMatchObject({
      guard: {verdict: "denied", recovery: "rolled_back"},
      effectCapability: {
        state: "consumed",
        runId: violated.run.id,
        agentId: agent.id,
        action: "write_demo_result",
        targetClass: "workspace",
        useBudget: 1,
        usesClaimed: 1,
      },
      effectSinkReceipt: {
        state: "revoked",
        runId: violated.run.id,
        agentId: agent.id,
        spentAt: null,
        committedAt: null,
        failedAt: null,
        closeDisposition: "unredeemed",
        errorCode: "EFFECT_SINK_CLOSED",
      },
    });
    expect(runner.requests).toHaveLength(2);
    expect(runner.requests[1]).toMatchObject({
      runId: violated.run.id,
      agentId: agent.id,
      hasRedeemPort: true,
      receivedParentCapability: false,
    });

    const laterSafe = await service.sendMessage(agent.id, EFFECT_FIREWALL_ALLOWED_DEMO_PROMPT);
    await expect.poll(() => service.getRun(laterSafe.run.id).status).toBe("completed");
    expect(service.getRun(laterSafe.run.id).effectCapability).toMatchObject({
      state: "consumed",
      runId: laterSafe.run.id,
      agentId: agent.id,
      action: "write_demo_result",
      targetClass: "workspace",
      useBudget: 1,
      usesClaimed: 1,
    });
    expect(service.getRun(laterSafe.run.id).effectSinkReceipt).toMatchObject({
      state: "committed",
      runId: laterSafe.run.id,
      agentId: agent.id,
      relativePath: "demo-result.md",
      errorCode: null,
    });
    expect(runner.requests).toHaveLength(3);
    expect(runner.requests[2]).toMatchObject({
      runId: laterSafe.run.id,
      agentId: agent.id,
      hasRedeemPort: true,
      receivedParentCapability: false,
    });
    expect(service.getRun(laterSafe.run.id).effectCapability?.grantId)
      .not.toBe(service.getRun(retained.run.id).effectCapability?.grantId);
    expect(service.getRun(laterSafe.run.id).effectSinkReceipt?.grantSha256)
      .not.toBe(service.getRun(retained.run.id).effectSinkReceipt?.grantSha256);
    expect(service.getAgent(agent.id).status).toBe("ready");
  });

  it("revokes a retained child and fails closed when the runner returns without its declared effect", async () => {
    class RetainingRunner extends FixtureRunner {
      retained: {effectSink: NonNullable<RunnerRequest["effectSink"]>; request: RunnerRequest} | null = null;
      override async run(request: RunnerRequest): Promise<RunnerResult> {
        if (!request.effectSink) throw new Error("missing sink");
        this.retained = {effectSink: request.effectSink, request};
        return {output: "returned without redeeming", threadId: null, usage: null};
      }
    }
    const runner = new RetainingRunner();
    const service = await makeService(runner, {
      ARK_API_KEY: "", ARK_MODEL: "", DEMO_RUNNER: "1",
    });
    const agent = await service.createAgent({name: "Retained child after return"});
    const sent = await service.sendMessage(agent.id, EFFECT_FIREWALL_ALLOWED_DEMO_PROMPT);
    await expect.poll(() => service.getRun(sent.run.id).status).toBe("failed");
    expect(service.getRun(sent.run.id)).toMatchObject({
      output: null,
      error: "Declared cooperative effect did not commit through Effect Sink",
      effectSinkReceipt: {
        state: "revoked",
        closeDisposition: "unredeemed",
        spentAt: null,
        errorCode: "EFFECT_SINK_CLOSED",
      },
      guard: {
        verdict: "denied",
        recovery: "rolled_back",
        denialReason: "Declared cooperative effect did not commit through Effect Sink",
      },
    });
    if (!runner.retained) throw new Error("runner did not retain sink");
    const delayedRedeem = () => runner.retained!.effectSink.port.redeem(
      runner.retained!.effectSink.grant,
      {
        runId: runner.retained!.request.runId,
        agentId: runner.retained!.request.agentId,
        action: "write_demo_result",
        targetClass: "workspace",
        relativePath: EFFECT_SINK_DEMO_RESULT_PATH,
        payload: Buffer.from(EFFECT_SINK_DEMO_RESULT_PAYLOAD),
      },
    );
    await expect(delayedRedeem()).rejects.toMatchObject({code: "EFFECT_SINK_CLOSED"});
    await expect(delayedRedeem()).rejects.toMatchObject({code: "EFFECT_SINK_CLOSED"});
    await expect(access(path.join(agent.workspacePath, EFFECT_SINK_DEMO_RESULT_PATH))).rejects.toThrow();
    expect(service.getMessages(agent.id).map((message) => message.role)).toEqual(["user"]);
  });

  it("withholds and restores an ambient workspace write when the declared sink effect was ignored", async () => {
    class AmbientBypassRunner extends FixtureRunner {
      override async run(request: RunnerRequest): Promise<RunnerResult> {
        await writeFile(
          path.join(request.workspacePath, EFFECT_SINK_DEMO_RESULT_PATH),
          "ambient bypass must not survive\n",
          "utf8",
        );
        return {output: "claimed success without sink", threadId: null, usage: null};
      }
    }
    const service = await makeService(new AmbientBypassRunner(), {
      ARK_API_KEY: "", ARK_MODEL: "", DEMO_RUNNER: "1",
    });
    const agent = await service.createAgent({name: "Ambient sink bypass"});
    const sent = await service.sendMessage(agent.id, EFFECT_FIREWALL_ALLOWED_DEMO_PROMPT);
    await expect.poll(() => service.getRun(sent.run.id).status).toBe("failed");
    expect(service.getRun(sent.run.id)).toMatchObject({
      output: null,
      error: "Declared cooperative effect did not commit through Effect Sink",
      effectSinkReceipt: {
        state: "revoked",
        closeDisposition: "unredeemed",
        errorCode: "EFFECT_SINK_CLOSED",
      },
      guard: {
        verdict: "denied",
        recovery: "rolled_back",
        denialReason: "Declared cooperative effect did not commit through Effect Sink",
      },
    });
    await expect(access(path.join(agent.workspacePath, EFFECT_SINK_DEMO_RESULT_PATH))).rejects.toThrow();
    expect(service.getMessages(agent.id).map((message) => message.role)).toEqual(["user"]);
  });

  it("revokes a retained unredeemed child immediately after runner throw", async () => {
    class ThrowingRetainingRunner extends FixtureRunner {
      retained: {effectSink: NonNullable<RunnerRequest["effectSink"]>; request: RunnerRequest} | null = null;
      override async run(request: RunnerRequest): Promise<RunnerResult> {
        if (!request.effectSink) throw new Error("missing sink");
        this.retained = {effectSink: request.effectSink, request};
        throw new Error("deliberate runner failure");
      }
    }
    const runner = new ThrowingRetainingRunner();
    const service = await makeService(runner, {
      ARK_API_KEY: "", ARK_MODEL: "", DEMO_RUNNER: "1",
    });
    const agent = await service.createAgent({name: "Retained child after throw"});
    const sent = await service.sendMessage(agent.id, EFFECT_FIREWALL_ALLOWED_DEMO_PROMPT);
    await expect.poll(() => service.getRun(sent.run.id).status).toBe("failed");
    expect(service.getRun(sent.run.id).effectSinkReceipt).toMatchObject({
      state: "revoked",
      closeDisposition: "unredeemed",
      spentAt: null,
      errorCode: "EFFECT_SINK_CLOSED",
    });
    if (!runner.retained) throw new Error("runner did not retain sink");
    const delayedRedeem = () => runner.retained!.effectSink.port.redeem(
      runner.retained!.effectSink.grant,
      {
        runId: runner.retained!.request.runId,
        agentId: runner.retained!.request.agentId,
        action: "write_demo_result",
        targetClass: "workspace",
        relativePath: EFFECT_SINK_DEMO_RESULT_PATH,
        payload: Buffer.from(EFFECT_SINK_DEMO_RESULT_PAYLOAD),
      },
    );
    await expect(delayedRedeem()).rejects.toMatchObject({code: "EFFECT_SINK_CLOSED"});
    await expect(delayedRedeem()).rejects.toMatchObject({code: "EFFECT_SINK_CLOSED"});
    await expect(access(path.join(agent.workspacePath, EFFECT_SINK_DEMO_RESULT_PATH))).rejects.toThrow();
  });

  it("revokes a fire-and-forget redemption paused before I/O and prevents its delayed write", async () => {
    let releaseIo!: () => void;
    let markEntered!: () => void;
    const ioGate = new Promise<void>((resolve) => { releaseIo = resolve; });
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    class FireAndForgetRunner extends FixtureRunner {
      retained: {effectSink: NonNullable<RunnerRequest["effectSink"]>; request: RunnerRequest} | null = null;
      pending: Promise<unknown> | null = null;
      override async run(request: RunnerRequest): Promise<RunnerResult> {
        if (!request.effectSink) throw new Error("missing sink");
        this.retained = {effectSink: request.effectSink, request};
        this.pending = request.effectSink.port.redeem(request.effectSink.grant, {
          runId: request.runId,
          agentId: request.agentId,
          action: "write_demo_result",
          targetClass: "workspace",
          relativePath: EFFECT_SINK_DEMO_RESULT_PATH,
          payload: Buffer.from(EFFECT_SINK_DEMO_RESULT_PAYLOAD),
        });
        void this.pending.catch(() => undefined);
        await entered;
        return {output: "returned while redemption was paused", threadId: null, usage: null};
      }
    }
    const runner = new FireAndForgetRunner();
    const service = await makeService(
      runner,
      {ARK_API_KEY: "", ARK_MODEL: "", DEMO_RUNNER: "1"},
      {beforeIo: async () => {
        markEntered();
        await ioGate;
      }},
    );
    const agent = await service.createAgent({name: "Paused fire-and-forget child"});
    const sent = await service.sendMessage(agent.id, EFFECT_FIREWALL_ALLOWED_DEMO_PROMPT);
    await expect.poll(() => service.getRun(sent.run.id).status).toBe("failed");
    expect(service.getRun(sent.run.id).effectSinkReceipt).toMatchObject({
      state: "revoked",
      closeDisposition: "in_flight",
      spentAt: expect.any(String),
      committedAt: null,
      errorCode: "EFFECT_SINK_CLOSED",
    });
    releaseIo();
    if (!runner.pending || !runner.retained) throw new Error("runner did not retain paused redemption");
    await expect(runner.pending).rejects.toMatchObject({code: "EFFECT_SINK_CLOSED"});
    const repeat = () => runner.retained!.effectSink.port.redeem(
      runner.retained!.effectSink.grant,
      {
        runId: runner.retained!.request.runId,
        agentId: runner.retained!.request.agentId,
        action: "write_demo_result",
        targetClass: "workspace",
        relativePath: EFFECT_SINK_DEMO_RESULT_PATH,
        payload: Buffer.from(EFFECT_SINK_DEMO_RESULT_PAYLOAD),
      },
    );
    await expect(repeat()).rejects.toMatchObject({code: "EFFECT_SINK_CLOSED"});
    await expect(repeat()).rejects.toMatchObject({code: "EFFECT_SINK_CLOSED"});
    await expect(access(path.join(agent.workspacePath, EFFECT_SINK_DEMO_RESULT_PATH))).rejects.toThrow();
  });

  it("revokes the child when cancellation arrives at the initial sink-receipt persistence boundary", async () => {
    let releasePersist!: () => void;
    let markPersistEntered!: () => void;
    const persistGate = new Promise<void>((resolve) => { releasePersist = resolve; });
    const persistEntered = new Promise<void>((resolve) => { markPersistEntered = resolve; });
    let retained: NonNullable<RunnerRequest["effectSink"]> | null = null;
    let closed: NonNullable<AgentRun["effectSinkReceipt"]> | null = null;
    class NeverDispatchedRunner extends FixtureRunner {
      calls = 0;
      override async run(request: RunnerRequest): Promise<RunnerResult> {
        this.calls++;
        return super.run(request);
      }
    }
    const runner = new NeverDispatchedRunner();
    const service = await makeService(
      runner,
      {ARK_API_KEY: "", ARK_MODEL: "", DEMO_RUNNER: "1"},
      {
        onIssued: (authority) => { retained = authority; },
        onClosed: (receipt) => { closed = receipt; },
        beforeInitialReceiptPersist: async () => {
          markPersistEntered();
          await persistGate;
        },
      },
    );
    const agent = await service.createAgent({name: "Cancel during sink receipt persistence"});
    const sent = await service.sendMessage(agent.id, EFFECT_FIREWALL_ALLOWED_DEMO_PROMPT);
    await persistEntered;
    const stopping = service.stopAgent(agent.id);
    releasePersist();
    await stopping;
    await expect.poll(() => service.getRun(sent.run.id).status).toBe("cancelled");

    expect(runner.calls).toBe(0);
    expect(closed).toMatchObject({
      state: "revoked",
      closeDisposition: "unredeemed",
      errorCode: "EFFECT_SINK_CLOSED",
    });
    expect(service.getRun(sent.run.id)).toMatchObject({
      status: "cancelled",
      output: null,
      effectSinkReceipt: {
        state: "revoked",
        closeDisposition: "unredeemed",
        errorCode: "EFFECT_SINK_CLOSED",
      },
    });
    if (!retained) throw new Error("sink authority was not observed");
    const delayed = () => retained!.port.redeem(retained!.grant, {
      runId: sent.run.id,
      agentId: agent.id,
      action: "write_demo_result",
      targetClass: "workspace",
      relativePath: EFFECT_SINK_DEMO_RESULT_PATH,
      payload: Buffer.from(EFFECT_SINK_DEMO_RESULT_PAYLOAD),
    });
    await expect(delayed()).rejects.toMatchObject({code: "EFFECT_SINK_CLOSED"});
    await expect(delayed()).rejects.toMatchObject({code: "EFFECT_SINK_CLOSED"});
    await expect(access(path.join(agent.workspacePath, EFFECT_SINK_DEMO_RESULT_PATH))).rejects.toThrow();
    expect(service.getMessages(agent.id).map((message) => message.role)).toEqual(["user"]);
  });

  it("revokes without a revoked-first store write when initial sink-receipt persistence fails", async () => {
    let retained: NonNullable<RunnerRequest["effectSink"]> | null = null;
    let closed: NonNullable<AgentRun["effectSinkReceipt"]> | null = null;
    class NeverDispatchedRunner extends FixtureRunner {
      calls = 0;
      override async run(request: RunnerRequest): Promise<RunnerResult> {
        this.calls++;
        return super.run(request);
      }
    }
    const runner = new NeverDispatchedRunner();
    const service = await makeService(
      runner,
      {ARK_API_KEY: "", ARK_MODEL: "", DEMO_RUNNER: "1"},
      {
        onIssued: (authority) => { retained = authority; },
        onClosed: (receipt) => { closed = receipt; },
        beforeInitialReceiptPersist: () => {
          throw new Error("INJECTED_INITIAL_SINK_RECEIPT_PERSISTENCE_FAILURE");
        },
      },
    );
    const agent = await service.createAgent({name: "Initial sink receipt persistence failure"});
    const sent = await service.sendMessage(agent.id, EFFECT_FIREWALL_ALLOWED_DEMO_PROMPT);
    await expect.poll(() => service.getRun(sent.run.id).status).toBe("failed");

    expect(runner.calls).toBe(0);
    expect(closed).toMatchObject({
      state: "revoked",
      closeDisposition: "unredeemed",
      errorCode: "EFFECT_SINK_CLOSED",
    });
    expect(service.getRun(sent.run.id)).toMatchObject({
      status: "failed",
      output: null,
      error: "INJECTED_INITIAL_SINK_RECEIPT_PERSISTENCE_FAILURE",
    });
    expect(service.getRun(sent.run.id).effectSinkReceipt).toBeUndefined();
    if (!retained) throw new Error("sink authority was not observed");
    const delayed = () => retained!.port.redeem(retained!.grant, {
      runId: sent.run.id,
      agentId: agent.id,
      action: "write_demo_result",
      targetClass: "workspace",
      relativePath: EFFECT_SINK_DEMO_RESULT_PATH,
      payload: Buffer.from(EFFECT_SINK_DEMO_RESULT_PAYLOAD),
    });
    await expect(delayed()).rejects.toMatchObject({code: "EFFECT_SINK_CLOSED"});
    await expect(delayed()).rejects.toMatchObject({code: "EFFECT_SINK_CLOSED"});
    await expect(access(path.join(agent.workspacePath, EFFECT_SINK_DEMO_RESULT_PATH))).rejects.toThrow();
    expect(service.getMessages(agent.id).map((message) => message.role)).toEqual(["user"]);
  });

  it("persists a sanitized sink failure when an unsafe destination is injected before redemption", async () => {
    const externalRoot = await mkdtemp(path.join(tmpdir(), "effect-sink-external-"));
    temporaryDirectories.push(externalRoot);
    const external = path.join(externalRoot, "sentinel.txt");
    await writeFile(external, "external sentinel remains unchanged", "utf8");
    class UnsafeDestinationFixtureRunner extends FixtureRunner {
      override async run(request: RunnerRequest): Promise<RunnerResult> {
        await symlink(external, path.join(request.workspacePath, "demo-result.md"));
        return super.run(request);
      }
    }
    const service = await makeService(new UnsafeDestinationFixtureRunner(), {
      ARK_API_KEY: "",
      ARK_MODEL: "",
      DEMO_RUNNER: "1",
    });
    const agent = await service.createAgent({name: "Unsafe sink destination fixture"});
    const attempted = await service.sendMessage(agent.id, EFFECT_FIREWALL_ALLOWED_DEMO_PROMPT);
    await expect.poll(() => service.getRun(attempted.run.id).status).toBe("failed");

    expect(service.getRun(attempted.run.id)).toMatchObject({
      output: null,
      effectSinkReceipt: {
        state: "effect_failed",
        runId: attempted.run.id,
        agentId: agent.id,
        relativePath: "demo-result.md",
        bytesCommitted: null,
        committedAt: null,
        errorCode: "EFFECT_SINK_DESTINATION_UNSAFE",
      },
      guard: {verdict: "denied", recovery: "rolled_back"},
    });
    expect(await readFile(external, "utf8")).toBe("external sentinel remains unchanged");
    await expect(access(path.join(agent.workspacePath, "demo-result.md"))).rejects.toThrow();
  });

  it("reloads the sanitized committed sink receipt without reconstructing its process-local grant", async () => {
    const harness = await makeServiceHarness(new FixtureRunner(), {
      ARK_API_KEY: "",
      ARK_MODEL: "",
      DEMO_RUNNER: "1",
    });
    const agent = await harness.service.createAgent({name: "Durable sink evidence"});
    const sent = await harness.service.sendMessage(agent.id, EFFECT_FIREWALL_ALLOWED_DEMO_PROMPT);
    await expect.poll(() => harness.service.getRun(sent.run.id).status).toBe("completed");
    const beforeRestart = harness.service.getRun(sent.run.id).effectSinkReceipt;
    expect(beforeRestart).toMatchObject({state: "committed", errorCode: null});

    const restarted = await harness.reopen();
    expect(restarted.service.getRun(sent.run.id).effectSinkReceipt).toEqual(beforeRestart);
    expect(JSON.stringify(restarted.service.getRun(sent.run.id).effectSinkReceipt))
      .not.toContain(harness.service.getRun(sent.run.id).effectCapability?.grantId);
  });

  it("demonstrates a real recovery failure in explicit no-model fixture mode", async () => {
    const service = await makeService(new FixtureRunner(), { ARK_API_KEY: "", ARK_MODEL: "", DEMO_RUNNER: "1" });
    const agent = await service.createAgent({ name: "Disposable recovery demo" });
    const { run } = await service.sendMessage(agent.id, "Run the recovery-failure fixture (locks this Agent).");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    expect(service.getRun(run.id)).toMatchObject({ output: null, guard: { verdict: "denied", recovery: "failed" } });
    expect(service.getAgent(agent.id).recoveryHold).toMatchObject({ reason: "rollback_failed", runId: run.id });
    expect((await lstat(path.join(agent.workspacePath, "README.md"))).isDirectory()).toBe(true);
    expect(service.getMessages(agent.id).map((message) => message.role)).toEqual(["user"]);
    await expect(service.sendMessage(agent.id, "retry")).rejects.toMatchObject({ statusCode: 409 });
  });

  it.each(["return", "throw", "cancel"] as const)(
    "persists a recovery hold when real filesystem rollback fails after runner %s",
    async (outcome) => {
      let calls = 0;
      const runner: AgentRunner = {
        run: async (request) => {
          calls++;
          // Turn a protected baseline file into a directory. Incremental recovery's
          // writeFile must fail on the real filesystem; no mocked guard receipt.
          const target = path.join(request.workspacePath, ".env");
          await rm(target);
          await mkdir(target);
          await writeFile(path.join(target, "payload"), "unverified fixture content");
          if (outcome === "throw") throw new Error("runner failed at " + target);
          if (outcome === "cancel") throw new RunCancelledError();
          return { output: "must not be retained", threadId: "unsafe-thread", usage: null };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      };
      const harness = await makeServiceHarness(runner);
      const { service } = harness;
      const agent = await service.createAgent({ name: "Failed rollback" });
      await writeFile(path.join(agent.workspacePath, ".env"), "baseline fixture content");
      const instructions = await readFile(path.join(agent.workspacePath, "AGENTS.md"), "utf8");
      const { run } = await service.sendMessage(agent.id, "trigger rollback failure");
      await expect.poll(() => service.getRun(run.id).status).toBe(
        outcome === "cancel" ? "cancelled" : "failed",
      );

      const receipt = service.getRun(run.id);
      expect(receipt).toMatchObject({ output: null, guard: { verdict: "denied", recovery: "failed" } });
      expect(receipt.guard?.events.at(-1)?.kind).toBe("rollback_failed");
      expect(service.getAgent(agent.id)).toMatchObject({
        status: "error", codexThreadId: null,
        recoveryHold: { runId: run.id, reason: "rollback_failed" },
      });
      expect((await lstat(path.join(agent.workspacePath, ".env"))).isDirectory()).toBe(true);
      // The failed recovery error path must not expose protected names or raw errno.
      for (const sensitive of [".env", agent.workspacePath, "EISDIR", "unverified fixture content"]) {
        expect(JSON.stringify(receipt)).not.toContain(sensitive);
      }
      await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
      await expect(service.sendMessage(agent.id, "bypass")).rejects.toMatchObject({ statusCode: 409 });
      await expect(service.updateAgent(agent.id, { instructions: "bypass" })).rejects.toMatchObject({ statusCode: 409 });
      const hold = service.getAgent(agent.id).recoveryHold;
      expect((await service.stopAgent(agent.id)).recoveryHold).toEqual(hold);
      await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
      expect(service.getRuns(agent.id)).toHaveLength(1);
      expect(service.getMessages(agent.id).map((message) => message.role)).toEqual(["user"]);
      expect(await readFile(path.join(agent.workspacePath, "AGENTS.md"), "utf8")).toBe(instructions);

      const restarted = (await harness.reopen()).service;
      expect(restarted.getAgent(agent.id)).toMatchObject({ status: "stopped", recoveryHold: hold });
      await expect(restarted.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
      await expect(restarted.sendMessage(agent.id, "retry after restart")).rejects.toMatchObject({ statusCode: 409 });
      expect(calls).toBe(1);
      const archived = await restarted.deleteAgent(agent.id);
      expect(await readFile(path.join(archived.archivedWorkspace, ".env", "payload"), "utf8"))
        .toBe("unverified fixture content");
      expect((await restarted.createAgent({ name: "Fresh replacement" })).recoveryHold).toBeNull();
    },
  );

  it.each(["queued", "running"] as const)(
    "holds a persisted %s Run on restart without claiming checkpoint recovery",
    async (status) => {
      const harness = await makeServiceHarness();
      const { service, store } = harness;
      const agent = await service.createAgent({ name: "Interrupted" });
      const healthy = await service.createAgent({ name: "Unaffected" });
      const { run } = await service.sendMessage(agent.id, "fixture run");
      await expect.poll(() => service.getRun(run.id).status).toBe("completed");
      await writeFile(path.join(agent.workspacePath, "unverified.txt"), "survives restart");
      // Seed the on-disk shape of an interrupted run. This is a disk-reopen test,
      // not a claim of OS process-kill, power-loss, or runner termination proof.
      await store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id)!;
        storedRun.status = status;
        storedRun.output = null;
        storedRun.usage = null;
        storedRun.completedAt = null;
        if (status === "queued") storedRun.guard = null;
        else {
          storedRun.guard!.verdict = "pending";
          storedRun.guard!.events = storedRun.guard!.events.filter((event) => event.kind === "grant_issued");
        }
        database.messages = database.messages.filter((message) => message.role !== "assistant");
        database.agents.find((item) => item.id === agent.id)!.status = "busy";
      });

      const restarted = (await harness.reopen()).service;
      expect(restarted.getRun(run.id)).toMatchObject({ status: "cancelled", output: null });
      if (status === "running") {
        expect(restarted.getRun(run.id).guard).toMatchObject({
          verdict: "denied", recovery: "failed", recoveredManifestDigest: null,
        });
        expect(restarted.getRun(run.id).guard?.events.at(-1)?.kind).toBe("recovery_required");
      } else expect(restarted.getRun(run.id).guard).toBeNull();
      expect(restarted.getAgent(agent.id)).toMatchObject({
        status: "error", codexThreadId: null,
        recoveryHold: { runId: run.id, reason: "interrupted_run" },
      });
      await expect(restarted.sendMessage(agent.id, "unsafe retry")).rejects.toMatchObject({ statusCode: 409 });
      await expect(restarted.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
      await expect(restarted.updateAgent(agent.id, { name: "bypass" })).rejects.toMatchObject({ statusCode: 409 });
      expect(await readFile(path.join(agent.workspacePath, "unverified.txt"), "utf8")).toBe("survives restart");
      const twiceRestarted = (await harness.reopen()).service;
      expect(twiceRestarted.getAgent(agent.id)).toEqual(restarted.getAgent(agent.id));
      expect(twiceRestarted.getRun(run.id)).toEqual(restarted.getRun(run.id));
      const unaffectedRun = await twiceRestarted.sendMessage(healthy.id, "still works");
      await expect.poll(() => twiceRestarted.getRun(unaffectedRun.run.id).status).toBe("completed");
    },
  );

  it("holds an orphaned busy Agent and migrates legacy failed receipts without blocking healthy Agents", async () => {
    const harness = await makeServiceHarness();
    const { service, store } = harness;
    const orphan = await service.createAgent({ name: "Orphan" });
    const legacy = await service.createAgent({ name: "Legacy failed recovery" });
    const healthy = await service.createAgent({ name: "Legacy healthy" });
    const { run } = await service.sendMessage(legacy.id, "fixture run");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    await store.mutate((database) => {
      for (const agent of database.agents) {
        // Simulate the version-1 schema before the recoveryHold field existed.
        Reflect.deleteProperty(agent, "recoveryHold");
      }
      database.agents.find((item) => item.id === orphan.id)!.status = "busy";
      const storedRun = database.runs.find((item) => item.id === run.id)!;
      storedRun.status = "failed";
      storedRun.guard!.verdict = "denied";
      storedRun.guard!.recovery = "failed";
    });
    const restarted = (await harness.reopen()).service;
    expect(restarted.getAgent(orphan.id).recoveryHold).toMatchObject({ runId: null, reason: "interrupted_run" });
    expect(restarted.getAgent(legacy.id).recoveryHold).toMatchObject({ runId: run.id, reason: "rollback_failed" });
    expect(restarted.getAgent(healthy.id)).toMatchObject({ status: "ready", recoveryHold: null });
  });

  it("redacts baseline filesystem failures and does not invoke the runner", async () => {
    let calls = 0;
    const service = await makeService({
      run: async () => { calls++; throw new Error("must not run"); },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Unsafe baseline" });
    await symlink("../../private-target", path.join(agent.workspacePath, "credential-link"));
    const { run } = await service.sendMessage(agent.id, "baseline is unsafe");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    expect(calls).toBe(0);
    expect(service.getRun(run.id).guard).toMatchObject({ verdict: "denied", recovery: "not_needed" });
    for (const sensitive of ["credential-link", "private-target", agent.workspacePath]) {
      expect(JSON.stringify(service.getRun(run.id))).not.toContain(sensitive);
    }
  });

  it("rejects recovery-hold bypasses through HTTP routes while retaining Stop and archive access", async () => {
    const harness = await makeServiceHarness();
    const agent = await harness.service.createAgent({ name: "HTTP recovery hold" });
    await harness.store.mutate((database) => {
      database.agents.find((item) => item.id === agent.id)!.status = "busy";
    });
    const restarted = (await harness.reopen()).service;
    const app = await createApp(harness.config, restarted);
    try {
      const base = "/api/agents/" + agent.id;
      const initial = await app.inject({ method: "GET", url: base });
      expect(initial.json().agent.recoveryHold.reason).toBe("interrupted_run");
      const start = await app.inject({ method: "POST", url: base + "/start" });
      const send = await app.inject({ method: "POST", url: base + "/messages", payload: { content: "bypass" } });
      const settings = await app.inject({ method: "PATCH", url: base, payload: { instructions: "bypass" } });
      for (const response of [start, send, settings]) {
        expect(response.statusCode).toBe(409);
        expect(response.json().error).toContain("manual recovery review");
      }
      const stop = await app.inject({ method: "POST", url: base + "/stop" });
      expect(stop.statusCode).toBe(200);
      expect(stop.json().agent.recoveryHold).toEqual(initial.json().agent.recoveryHold);
      expect((await app.inject({ method: "POST", url: base + "/start" })).statusCode).toBe(409);
      expect(restarted.getMessages(agent.id)).toHaveLength(0);
      expect(restarted.getRuns(agent.id)).toHaveLength(0);
      const archive = await app.inject({ method: "DELETE", url: base });
      expect(archive.statusCode).toBe(200);
      expect(await readFile(path.join(archive.json().archivedWorkspace, "AGENTS.md"), "utf8"))
        .toContain("HTTP recovery hold");
    } finally {
      await app.close();
    }
  });

  it("keeps a verified workspace retryable after an ordinary runner error", async () => {
    let calls = 0;
    const service = await makeService({
      run: async () => {
        if (++calls === 1) throw new Error("ordinary runner failure");
        return { output: "retry succeeded", threadId: "thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Retryable" });
    const first = await service.sendMessage(agent.id, "first");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("failed");
    expect(service.getAgent(agent.id)).toMatchObject({ status: "error", recoveryHold: null });
    expect(service.getRun(first.run.id).guard?.verdict).toBe("retained");
    const second = await service.sendMessage(agent.id, "retry");
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
});
