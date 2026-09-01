import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EFFECT_SINK_DEMO_RESULT_PATH,
  EFFECT_SINK_DEMO_RESULT_PAYLOAD,
} from "./effect-sink.js";
import { proposeDemoEffect } from "./effect-policy.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";

export const EFFECT_FIREWALL_ALLOWED_DEMO_PROMPT = "show the normal case" as const;

/** Explicit local-demo runner, enabled only with DEMO_RUNNER=1. */
export class FixtureRunner implements AgentRunner {
  proposeEffect(request: Readonly<Pick<RunnerRequest, "prompt">>) {
    const protectedDelete = proposeDemoEffect(request.prompt);
    if (protectedDelete) return protectedDelete;
    // Every deterministic demo Run declares the same bounded workspace effect.
    // Fault-injection prompts deliberately violate that declaration so the
    // post-run RunGuard backstop can prove it catches admitted-worker drift.
    return {version: 1, action: "write_demo_result", targetClass: "workspace"} as const;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (/\brecovery-failure\b/i.test(request.prompt)) {
      // Explicit fault injection for disposable demo Agents only: replace the
      // starter's baseline README file with a directory, then trigger denial.
      // RunGuard's attempted restore encounters the collision and must hold it.
      const target = path.join(request.workspacePath, "README.md");
      await rm(target);
      await mkdir(target);
      await writeFile(path.join(target, "fixture.txt"), "deliberate recovery collision\n");
      await writeFile(path.join(request.workspacePath, ".env"), "fixture-only denial\n");
      return { output: "Recovery-failure fixture must not be retained", threadId: null, usage: null };
    }
    const denialScenario = /\b(deny|denial|protected|secret)\b/i.test(request.prompt);
    if (denialScenario) {
      await writeFile(
        path.join(request.workspacePath, ".env"),
        "fixture-only: RunGuard must deny this protected-path mutation\n",
        "utf8",
      );
      return {
        output: "Fixture attempted a protected workspace mutation. RunGuard should deny it.",
        threadId: request.threadId ?? "run-guard-demo",
        usage: null,
      };
    }

    if (!request.effectSink) throw new Error("EFFECT_SINK_REQUIRED");
    // Cooperative normal effects have no ambient write here. The opaque child
    // is redeemed at the attached sink immediately where writeFile used to be.
    await request.effectSink.port.redeem(request.effectSink.grant, {
      runId: request.runId,
      agentId: request.agentId,
      action: "write_demo_result",
      targetClass: "workspace",
      relativePath: EFFECT_SINK_DEMO_RESULT_PATH,
      payload: Buffer.from(EFFECT_SINK_DEMO_RESULT_PAYLOAD, "utf8"),
    });
    return {
      output: "Fixture completed a workspace-scoped Run. RunGuard should retain it.",
      threadId: request.threadId ?? "run-guard-demo",
      usage: null,
    };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
