import type { AppConfig } from "./config.js";
import { ContainerCodexRunner } from "./container-codex-runner.js";
import { CodexRunner } from "./codex-runner.js";
import { FixtureRunner } from "./fixture-runner.js";
import { RunScopedCodexRunner } from "./run-scoped-codex-runner.js";
import type { AgentRunner } from "./types.js";

export function createRunner(config: AppConfig): AgentRunner {
  if (config.demoRunner) return new FixtureRunner();
  if (config.codexRunHomeMode === "run-scoped") {
    if (config.runtimeProvider !== "local-process") throw new Error("RUN_SCOPED_CONTAINER_UNSUPPORTED");
    return new RunScopedCodexRunner(config);
  }
  return config.runtimeProvider === "container"
    ? new ContainerCodexRunner(config)
    : new CodexRunner(config);
}
