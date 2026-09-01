import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EffectCapabilityRegistry,
  bindingFromCapability,
} from "./effect-capability.js";
import {
  EffectSinkError,
  ProcessLocalEffectSinkBroker,
  effectSinkPayloadSha256,
} from "./effect-sink.js";
import { decideEffect } from "./effect-policy.js";
import { EFFECT_FIREWALL_ALLOWED_DEMO_PROMPT, FixtureRunner } from "./fixture-runner.js";
import type {
  EffectCapabilityReceipt,
  EffectSinkPort,
  EffectSinkWriteRequest,
} from "./types.js";

const temporaryDirectories: string[] = [];
const baseTime = 1_800_000_000_000;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, {recursive: true, force: true})));
});

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `nerveloop-product-sink-${label}-`));
  temporaryDirectories.push(root);
  return root;
}

function allowedParent(
  registry: EffectCapabilityRegistry,
  label: string,
): EffectCapabilityReceipt {
  const decision = decideEffect({
    version: 1,
    action: "write_demo_result",
    targetClass: "workspace",
  });
  const issued = registry.issue({
    runId: `run_${label}`,
    agentId: `agent_${label}`,
    decision,
    ttlMs: 5_000,
  });
  const binding = bindingFromCapability(issued);
  return registry.consume(registry.claim(issued, binding), binding);
}

function requestFor(
  parent: EffectCapabilityReceipt,
  relativePath: string,
  payload: Uint8Array,
): EffectSinkWriteRequest {
  return {
    runId: parent.runId,
    agentId: parent.agentId,
    action: parent.action,
    targetClass: parent.targetClass,
    relativePath,
    payload,
  };
}

async function expectSinkCode(
  operation: Promise<unknown>,
  code: EffectSinkError["code"],
): Promise<void> {
  await expect(operation).rejects.toMatchObject({name: "EffectSinkError", code});
}

describe("ProcessLocalEffectSinkBroker", () => {
  it("gives the cooperative normal fixture no ambient-write fallback", async () => {
    const root = await temporaryRoot("fixture-no-fallback");
    const runner = new FixtureRunner();
    await expect(runner.run({
      runId: "run_no_fallback",
      agentId: "agent_no_fallback",
      workspacePath: root,
      prompt: EFFECT_FIREWALL_ALLOWED_DEMO_PROMPT,
      threadId: null,
    })).rejects.toThrow("EFFECT_SINK_REQUIRED");
    await expect(readFile(path.join(root, "demo-result.md"))).rejects.toMatchObject({code: "ENOENT"});
  });

  it("binds the complete parent context while exposing only an opaque child and sanitized receipt", async () => {
    const root = await temporaryRoot("binding");
    let clock = baseTime;
    const registry = new EffectCapabilityRegistry({
      now: () => clock,
      grantId: () => "parent_binding_secret",
    });
    const parent = allowedParent(registry, "binding");
    const payload = Buffer.from("exact payload\n", "utf8");
    const broker = new ProcessLocalEffectSinkBroker(registry, {
      now: () => clock,
      grant: () => "opaque_child_binding_secret",
    });
    const issued = broker.issue({
      parent,
      workspaceRoot: root,
      relativePath: "demo-result.md",
      payloadSha256: effectSinkPayloadSha256(payload),
      ttlMs: 1_000,
    });

    expect(issued.grant).toBe("opaque_child_binding_secret");
    expect(issued.receipt).toMatchObject({
      state: "issued",
      runId: parent.runId,
      agentId: parent.agentId,
      action: "write_demo_result",
      targetClass: "workspace",
      policy: "effect-firewall-v1",
      policyVersion: 1,
      policyDigest: parent.policyDigest,
      relativePath: "demo-result.md",
      payloadSha256: effectSinkPayloadSha256(payload),
      spentAt: null,
      committedAt: null,
      failedAt: null,
    });
    const serialized = JSON.stringify(issued.receipt);
    expect(serialized).not.toContain(issued.grant);
    expect(serialized).not.toContain(parent.grantId);
    expect(issued.receipt.boundary).toMatch(/not.*concurrent ancestor-swap TOCTOU/i);

    const exact = requestFor(parent, "demo-result.md", payload);
    const mutations: EffectSinkWriteRequest[] = [
      {...exact, runId: "run_other"},
      {...exact, agentId: "agent_other"},
      {...exact, action: "read_asset_metadata"},
      {...exact, targetClass: "scratch"},
      {...exact, relativePath: "other.md"},
      {...exact, payload: Buffer.from("different\n")},
    ];
    for (const mutation of mutations) {
      await expectSinkCode(
        broker.port.redeem(issued.grant, mutation),
        "EFFECT_SINK_CONTEXT_MISMATCH",
      );
      expect(broker.inspect(issued.grant)?.state).toBe("issued");
    }

    clock += 1;
    await expect(broker.port.redeem(issued.grant, exact)).resolves.toMatchObject({
      state: "committed",
      relativePath: "demo-result.md",
      payloadSha256: effectSinkPayloadSha256(payload),
      bytesCommitted: payload.length,
    });
    expect(await readFile(path.join(root, "demo-result.md"))).toEqual(payload);
    expect(broker.inspect(issued.grant)).toMatchObject({
      state: "committed",
      spentAt: new Date(clock).toISOString(),
      committedAt: new Date(clock).toISOString(),
      errorCode: null,
    });
  });

  it("has one synchronous winner among 64 attempts and snapshots caller bytes before its first await", async () => {
    const root = await temporaryRoot("concurrency");
    const registry = new EffectCapabilityRegistry({
      now: () => baseTime,
      grantId: () => "parent_concurrency",
    });
    const parent = allowedParent(registry, "concurrency");
    const original = Buffer.from("original immutable payload\n", "utf8");
    let releaseIo!: () => void;
    let markEntered!: () => void;
    const ioGate = new Promise<void>((resolve) => { releaseIo = resolve; });
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const broker = new ProcessLocalEffectSinkBroker(registry, {
      now: () => baseTime,
      grant: () => "opaque_concurrency",
      beforeIo: async () => {
        markEntered();
        await ioGate;
      },
    });
    const issued = broker.issue({
      parent,
      workspaceRoot: root,
      relativePath: "demo-result.md",
      payloadSha256: effectSinkPayloadSha256(original),
    });
    const mutableCaller = Buffer.from(original);
    const first = broker.port.redeem(
      issued.grant,
      requestFor(parent, "demo-result.md", mutableCaller),
    );
    await entered;
    expect(broker.inspect(issued.grant)).toMatchObject({
      state: "spent",
      committedAt: null,
      failedAt: null,
    });
    mutableCaller.fill(0x78);

    const replays = Array.from({length: 63}, () =>
      broker.port.redeem(
        issued.grant,
        requestFor(parent, "demo-result.md", Buffer.from(original)),
      ));
    releaseIo();
    const results = await Promise.allSettled([first, ...replays]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failures = results.filter((result): result is PromiseRejectedResult =>
      result.status === "rejected");
    expect(failures).toHaveLength(63);
    expect(failures.every((result) => result.reason instanceof EffectSinkError &&
      result.reason.code === "EFFECT_SINK_ALREADY_SPENT")).toBe(true);
    expect(await readFile(path.join(root, "demo-result.md"))).toEqual(original);
    expect(broker.inspect(issued.grant)?.state).toBe("committed");
  });

  it("allows one child per parent and atomically replaces a prior regular result on the later safe run", async () => {
    const root = await temporaryRoot("replace");
    let sequence = 0;
    const registry = new EffectCapabilityRegistry({
      now: () => baseTime,
      grantId: () => `parent_replace_${++sequence}`,
    });
    const broker = new ProcessLocalEffectSinkBroker(registry, {
      now: () => baseTime,
      grant: () => `opaque_replace_${sequence}`,
    });

    const firstParent = allowedParent(registry, "replace_first");
    const firstPayload = Buffer.from("first safe run\n");
    const first = broker.issue({
      parent: firstParent,
      workspaceRoot: root,
      relativePath: "demo-result.md",
      payloadSha256: effectSinkPayloadSha256(firstPayload),
    });
    expect(() => broker.issue({
      parent: firstParent,
      workspaceRoot: root,
      relativePath: "second-child.md",
      payloadSha256: effectSinkPayloadSha256(firstPayload),
    })).toThrowError(expect.objectContaining({code: "EFFECT_SINK_PARENT_ALREADY_DERIVED"}));
    await broker.port.redeem(
      first.grant,
      requestFor(firstParent, "demo-result.md", firstPayload),
    );

    const secondParent = allowedParent(registry, "replace_second");
    const secondPayload = Buffer.from("later safe run atomically replaced the result\n");
    const second = broker.issue({
      parent: secondParent,
      workspaceRoot: root,
      relativePath: "demo-result.md",
      payloadSha256: effectSinkPayloadSha256(secondPayload),
    });
    await broker.port.redeem(
      second.grant,
      requestFor(secondParent, "demo-result.md", secondPayload),
    );

    expect(await readFile(path.join(root, "demo-result.md"))).toEqual(secondPayload);
    expect(broker.inspect(first.grant)?.state).toBe("committed");
    expect(broker.inspect(second.grant)?.state).toBe("committed");
  });

  it("rejects the exact expiry boundary without spending or creating a file", async () => {
    const root = await temporaryRoot("expiry");
    let clock = baseTime;
    const registry = new EffectCapabilityRegistry({
      now: () => clock,
      grantId: () => "parent_expiry",
    });
    const parent = allowedParent(registry, "expiry");
    const payload = Buffer.from("expired\n");
    const broker = new ProcessLocalEffectSinkBroker(registry, {
      now: () => clock,
      grant: () => "opaque_expiry",
    });
    const issued = broker.issue({
      parent,
      workspaceRoot: root,
      relativePath: "demo-result.md",
      payloadSha256: effectSinkPayloadSha256(payload),
      ttlMs: 10,
    });
    clock += 10;
    await expectSinkCode(
      broker.port.redeem(issued.grant, requestFor(parent, "demo-result.md", payload)),
      "EFFECT_SINK_EXPIRED",
    );
    expect(broker.inspect(issued.grant)?.state).toBe("issued");
    await expect(readFile(path.join(root, "demo-result.md"))).rejects.toMatchObject({code: "ENOENT"});
  });

  it("detects deterministic workspace-root replacement by identity and fails the spent grant closed", async () => {
    const parentDirectory = await temporaryRoot("root-replacement-parent");
    const root = path.join(parentDirectory, "workspace");
    const moved = path.join(parentDirectory, "workspace-original");
    await mkdir(root);
    const registry = new EffectCapabilityRegistry({
      now: () => baseTime,
      grantId: () => "parent_root_replacement",
    });
    const parent = allowedParent(registry, "root_replacement");
    const payload = Buffer.from("must not land in replacement\n");
    const broker = new ProcessLocalEffectSinkBroker(registry, {
      now: () => baseTime,
      grant: () => "opaque_root_replacement",
      beforeIo: async () => {
        await rename(root, moved);
        await mkdir(root);
      },
    });
    const issued = broker.issue({
      parent,
      workspaceRoot: root,
      relativePath: "demo-result.md",
      payloadSha256: effectSinkPayloadSha256(payload),
    });

    await expectSinkCode(
      broker.port.redeem(issued.grant, requestFor(parent, "demo-result.md", payload)),
      "EFFECT_SINK_ROOT_CHANGED",
    );
    expect(broker.inspect(issued.grant)).toMatchObject({
      state: "effect_failed",
      errorCode: "EFFECT_SINK_ROOT_CHANGED",
      committedAt: null,
      bytesCommitted: null,
    });
    await expect(readFile(path.join(root, "demo-result.md"))).rejects.toMatchObject({code: "ENOENT"});
    await expect(readFile(path.join(moved, "demo-result.md"))).rejects.toMatchObject({code: "ENOENT"});
  });

  it.each(["symlink", "directory"] as const)(
    "fails closed on a pre-existing destination %s without altering an external sentinel",
    async (kind) => {
      const parentDirectory = await temporaryRoot(`unsafe-${kind}`);
      const root = path.join(parentDirectory, "workspace");
      await mkdir(root);
      const external = path.join(parentDirectory, "external-sentinel.txt");
      await writeFile(external, "sentinel remains unchanged\n");
      const destination = path.join(root, "demo-result.md");
      if (kind === "symlink") await symlink(external, destination);
      else await mkdir(destination);

      const registry = new EffectCapabilityRegistry({
        now: () => baseTime,
        grantId: () => `parent_unsafe_${kind}`,
      });
      const parent = allowedParent(registry, `unsafe_${kind}`);
      const payload = Buffer.from("must not be written\n");
      const broker = new ProcessLocalEffectSinkBroker(registry, {
        now: () => baseTime,
        grant: () => `opaque_unsafe_${kind}`,
      });
      const issued = broker.issue({
        parent,
        workspaceRoot: root,
        relativePath: "demo-result.md",
        payloadSha256: effectSinkPayloadSha256(payload),
      });

      await expectSinkCode(
        broker.port.redeem(issued.grant, requestFor(parent, "demo-result.md", payload)),
        "EFFECT_SINK_DESTINATION_UNSAFE",
      );
      expect(broker.inspect(issued.grant)).toMatchObject({
        state: "effect_failed",
        errorCode: "EFFECT_SINK_DESTINATION_UNSAFE",
        committedAt: null,
      });
      expect(await readFile(external, "utf8")).toBe("sentinel remains unchanged\n");
      await expectSinkCode(
        broker.port.redeem(issued.grant, requestFor(parent, "demo-result.md", payload)),
        "EFFECT_SINK_ALREADY_SPENT",
      );
    },
  );
});
