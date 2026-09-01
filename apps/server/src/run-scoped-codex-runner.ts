import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {appendFile, lstat, mkdir, open, realpath, writeFile} from "node:fs/promises";
import path from "node:path";
import {CodexRunner, selectedRunnerModel} from "./codex-runner.js";
import {writeCodexConfig, type AppConfig} from "./config.js";
import {RunCancelledError} from "./errors.js";
import {nativeToolPolicyReceipt} from "./native-tool-policy.js";
import {startResponsesToolGate} from "./responses-tool-gate.js";
import {renderRunConversation, validateRunConversation} from "./run-conversation.js";
import type {AgentRunner, RunnerRequest, RunnerResult} from "./types.js";

export interface RunScopedContext {
  request: Readonly<RunnerRequest>;
  codexHome: string;
  signal: AbortSignal;
}

// Trusted host setup only. Not selected by HTTP/prompt content. It must be
// bounded and cooperatively cancellable; no arbitrary plugin loader is added.
export type PrepareRunConfiguration = (context: RunScopedContext) => Promise<void | {
  upstreamBaseUrl?: string;
  onGateReady?: (origin: string) => Promise<void>;
}>;

interface ActiveRun {
  controller: AbortController;
  runner: CodexRunner | null;
  terminal: boolean;
  settled: Promise<RunnerResult>;
}

async function configDigest(codexHome: string): Promise<string> {
  const handle = await open(path.join(codexHome, "config.toml"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65_536) throw new Error("RUN_CONFIG_UNSAFE");
    const bytes = Buffer.alloc(65_537);
    let size = 0;
    while (size < bytes.length) {
      const next = await handle.read(bytes, size, bytes.length - size, null);
      if (!next.bytesRead) break;
      size += next.bytesRead;
    }
    if (size > 65_536) throw new Error("RUN_CONFIG_TOO_LARGE");
    return createHash("sha256").update(bytes.subarray(0, size)).digest("hex");
  } finally { await handle.close(); }
}

async function directory(location: string, recursive = false): Promise<void> {
  await mkdir(location, {recursive, mode: 0o700}).catch(error => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await lstat(location);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("RUN_HOME_UNSAFE");
}

/** Opt-in configuration namespace, not an OS isolation or session-migration layer. */
export class RunScopedCodexRunner implements AgentRunner {
  private readonly active = new Map<string, ActiveRun>();

  constructor(private readonly config: AppConfig,
    private readonly prepare?: PrepareRunConfiguration) {}

  isAvailable(): Promise<boolean> { return new CodexRunner(this.config).isAvailable(); }

  run(input: RunnerRequest): Promise<RunnerResult> {
    const history = input.history ? structuredClone(input.history) : undefined;
    if (history) {
      try { validateRunConversation(history, input.agentId, input.runId); }
      catch (error) { return Promise.reject(error); }
      Object.freeze(history.includedRunIds);
      Object.freeze(history);
    }
    const request = Object.freeze({...input, ...(history ? {history} : {})});
    if (typeof request.runId !== "string" || !request.runId.length || request.runId.length > 128 ||
        typeof request.agentId !== "string" || !request.agentId.length || request.agentId.length > 128) {
      return Promise.reject(new Error("RUN_ID_REQUIRED"));
    }
    if (request.threadId !== null) return Promise.reject(new Error("RUN_SCOPED_RESUME_UNSUPPORTED"));
    if (this.active.has(request.agentId)) return Promise.reject(new Error("Agent already has an active Run-scoped process"));
    const state: ActiveRun = {controller: new AbortController(), runner: null, terminal: false,
      settled: Promise.resolve({output: "", threadId: null, usage: null})};
    // Reserve before any filesystem await; concurrent calls cannot both prepare.
    this.active.set(request.agentId, state);
    state.settled = this.execute(request, state).finally(() => {
      if (this.active.get(request.agentId) === state) this.active.delete(request.agentId);
    });
    return state.settled;
  }

  async cancel(agentId: string): Promise<boolean> {
    const state = this.active.get(agentId);
    if (!state) return false;
    if (state.terminal) {
      await state.settled.catch(() => undefined);
      return false;
    }
    state.controller.abort();
    if (state.runner) await state.runner.cancel(agentId);
    // Do not release admission while trusted setup or child teardown is pending.
    await state.settled.catch(() => undefined);
    return true;
  }

  private async execute(request: Readonly<RunnerRequest>, state: ActiveRun): Promise<RunnerResult> {
    const createdAt = new Date().toISOString();
    let runDirectory: string | null = null;
    let codexHome: string | null = null;
    let digest: string | null = null;
    let childStarted = false;
    let primaryFailed = false;
    let primaryError: unknown;
    let status: "completed" | "failed" | "cancelled" = "failed";
    let gate: Awaited<ReturnType<typeof startResponsesToolGate>> | undefined;
    const checkCancelled = () => { if (state.controller.signal.aborted) throw new RunCancelledError(); };
    try {
      checkCancelled();
      await directory(this.config.codexHome, true);
      const base = await realpath(this.config.codexHome);
      const workspace = await realpath(request.workspacePath);
      const relative = path.relative(workspace, base);
      if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) {
        throw new Error("RUN_HOME_INSIDE_WORKSPACE");
      }
      const scopes = path.join(base, "run-scopes");
      await directory(scopes);
      const key = createHash("sha256").update(request.runId).digest("hex");
      const candidate = path.join(scopes, key);
      try { await mkdir(candidate, {mode: 0o700}); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("RUN_HOME_ALREADY_EXISTS");
        throw error;
      }
      runDirectory = candidate;
      codexHome = path.join(candidate, "home");
      await mkdir(codexHome, {mode: 0o700});
      await writeFile(path.join(candidate, "binding.json"), JSON.stringify({
        version: 1, runId: request.runId, agentId: request.agentId, workspace, createdAt,
      }), {flag: "wx", mode: 0o600});
      const model = selectedRunnerModel(request, this.config.arkModel);
      const isolated = {...this.config, codexHome, arkModel: model};
      // Generate from host settings; never copy ambient auth, session, plugin or config files.
      await writeCodexConfig(isolated);
      // The actual CLI records this exact operator-selected workspace as trusted
      // on first execution. Seed it before the digest so that expected CLI setup
      // does not look like a worker mutation. Never grant a parent/root wildcard.
      await appendFile(path.join(codexHome, "config.toml"),
        "\n[projects." + JSON.stringify(workspace) + "]\ntrust_level = \"trusted\"\n");
      checkCancelled();
      const prepared = await this.prepare?.(Object.freeze({request, codexHome, signal: state.controller.signal}));
      if (this.config.codexProviderGate === "bounded-video-v1") {
        gate = await startResponsesToolGate({runId: request.runId, agentId: request.agentId,
          model, upstreamBaseUrl: prepared?.upstreamBaseUrl ?? this.config.arkBaseUrl,
          apiKey: this.config.arkApiKey, signal: state.controller.signal, timeoutMs: Math.min(this.config.codexTimeoutMs, 15_000)});
        await prepared?.onGateReady?.(new URL(gate.baseUrl).origin);
      }
      checkCancelled();
      if ((await realpath(codexHome)) !== codexHome || !(await lstat(codexHome)).isDirectory()) throw new Error("RUN_HOME_UNSAFE");
      digest = await configDigest(codexHome);
      checkCancelled();
      state.runner = new CodexRunner(isolated, gate);
      childStarted = true;
      const result = await state.runner.run(request.history
        ? {...request, prompt: renderRunConversation(request.prompt, request.history)} : request);
      checkCancelled();
      if (gate?.receipt().poisoned) throw new Error("PROVIDER_GATE_DENIED");
      if (await configDigest(codexHome) !== digest) throw new Error("RUN_CONFIG_CHANGED");
      checkCancelled();
      status = "completed";
      // A fresh home is deliberately single-turn until session portability is verified.
      // Do not publish an unusable home-local thread ID for a subsequent global resume.
      return {...result, threadId: null};
    } catch (error) {
      primaryFailed = true;
      primaryError = error;
      status = state.controller.signal.aborted ? "cancelled" : "failed";
      throw error;
    } finally {
      state.terminal = true;
      await gate?.close();
      // Execution outcome is now fixed; cancellation during receipt persistence
      // must not claim to have cancelled already-finished execution.
      try {
        if (runDirectory) await writeFile(path.join(runDirectory, "receipt.json"), JSON.stringify({
        version: 1, runId: request.runId, agentId: request.agentId, codexHome,
        configurationIsolation: "separate-run-home", configSha256: digest,
        nativeToolPolicy: nativeToolPolicyReceipt(this.config.codexNativeToolPolicy),
        providerGate: gate?.receipt() ?? null,
        conversation: request.history ? {
          version: request.history.version, sha256: request.history.sha256,
          bytes: request.history.bytes, includedRunIds: request.history.includedRunIds,
          omittedTurns: request.history.omittedTurns, truncatedFields: request.history.truncatedFields,
          boundary: "Historical data only; no carried-forward tool authority",
        } : null,
        status, childStarted, createdAt, finishedAt: new Date().toISOString(),
        sessionResume: "not-supported", boundary: "Configuration separation only; not hostile-process or OS isolation",
        }, null, 2), {flag: "wx", mode: 0o600});
      } catch (receiptError) {
        // Receipt failure also fails closed, without erasing the original cause.
        if (primaryFailed) throw new AggregateError([primaryError, receiptError],
          "RUN_RECEIPT_FAILED", {cause: primaryError});
        throw new Error("RUN_RECEIPT_FAILED", {cause: receiptError});
      }
    }
  }
}
