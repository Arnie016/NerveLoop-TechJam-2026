import {createHash, randomUUID} from "node:crypto";
import {execFile, type ChildProcess} from "node:child_process";
import {constants} from "node:fs";
import {lstat, open, readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import type {
  AgentRun,
  AgentRunner,
  RunnerRequest,
  RunnerResult,
  TaskAcceptanceContext,
  TaskAcceptanceVerifier,
} from "./types.js";

const RECEIPT_NAME = "decodebridge-agent-run.receipt.json";
const REGRESSION_ID = "decodebridge-pts-one-tick-v1";
const WORKLOAD = "decodebridge-owned-stride-canary-correctness-v1";
const ROUTE = "AgentService->DecodeBridgeRunner->VideoToolbox->Metal->independent-verifier";
const CONTRACT = [
  "decodebridge-agentservice-work-cell-v1",
  "one-owned-input",
  "correctness-only-no-benchmark-promotion",
  "hardware-required",
  "exact-timeline",
  "cpu-metal-parity",
  "selector-identity",
  "one-use-lease",
  "independent-local-verifier",
  "run-guard-retention",
].join("|");
const SOURCE_IDENTITY_PATHS = [
  "Package.swift",
  "Sources/DecodeBridge/main.swift",
  "Sources/DecodeBridge/FeaturePipeline.swift",
  "Sources/DecodeBridge/TemporalFacilitySelector.swift",
  "Sources/DecodeBridge/Shaders/PatchFeatures.metal",
  "BENCHMARK_CONTRACT.md",
  "verify_receipt.py",
] as const;

type JsonRecord = Record<string, unknown>;

export interface DecodeBridgeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DecodeBridgeCommandExecutor {
  run(input: {
    key: string;
    executable: string;
    arguments: string[];
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
    signal?: AbortSignal;
  }): Promise<DecodeBridgeCommandResult>;
  cancel(key: string): boolean;
}

export interface DecodeBridgeLeaseBindings {
  executableSha256: string;
  sourceTreeSha256: string;
  inputSha256: string;
  manifestSha256: string;
  shaderSha256: string;
  verifierSha256: string;
  hostPolicySha256: string;
  regressionArtifactSha256: string;
  regressionPayloadSha256: string;
  regressionVerifierSha256: string;
  contractSha256: string;
  promptSha256: string;
}

export interface DecodeBridgeCapabilityLease {
  version: 1;
  leaseId: string;
  runId: string;
  agentId: string;
  workload: typeof WORKLOAD;
  route: typeof ROUTE;
  issuedAtUtc: string;
  expiresAtUtc: string;
  maxExecutions: 1;
  scope: string[];
  receiptName: typeof RECEIPT_NAME;
  bindings: DecodeBridgeLeaseBindings;
  leaseSha256: string;
}

export interface DecodeBridgeExecutionEvidence {
  startedAtUtc: string;
  completedAtUtc: string;
  exitCode: 0;
  receiptName: typeof RECEIPT_NAME;
  receiptByteSha256: string;
  receiptCanonicalSha256: string;
  receiptBytes: number;
}

export interface DecodeBridgeVerificationEvidence {
  checkedAtUtc: string;
  verifierId: typeof DecodeBridgeAcceptanceVerifier.id;
  verdict: "PASS";
  failedGates: [];
  receiptSha256: string;
  regressionIds: [typeof REGRESSION_ID];
  regressionReplayExecutionSha256: string;
}

export interface DecodeBridgeAuthorityEvidence {
  lease: DecodeBridgeCapabilityLease;
  state: "ISSUED" | "CONSUMED" | "CLOSED";
  execution: DecodeBridgeExecutionEvidence | null;
  verification: DecodeBridgeVerificationEvidence | null;
  failureCode: string | null;
  closedAtUtc: string | null;
  closeReason: "VERIFIED" | "EXECUTION_FAILED" | "VERIFICATION_REJECTED" | null;
}

export interface DecodeBridgeWorkCellOptions {
  experimentRoot: string;
  assetName?: string;
  timeoutMs?: number;
  leaseLifetimeMs?: number;
  now?: () => Date;
  commandExecutor?: DecodeBridgeCommandExecutor;
}

interface ResolvedWorkCell {
  experimentRoot: string;
  binary: string;
  manifest: string;
  input: string;
  verifier: string;
  shader: string;
  assetName: string;
  hostPolicyFiles: string[];
  regressionArtifact: string;
  regressionVerifier: string;
  runtimeControls: string;
  timeoutMs: number;
  leaseLifetimeMs: number;
}

function jsonRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`DECODEBRIDGE_WORK_CELL_INVALID_${label}`);
  }
  return value as JsonRecord;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const raw = value as JsonRecord;
    return `{${Object.keys(raw).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(raw[key])}`).join(",")}}`;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("DECODEBRIDGE_WORK_CELL_CANONICAL_NUMBER");
    const magnitude = Math.abs(value);
    let encoded = value.toString();
    // Python's json.dumps uses scientific notation below 1e-4 or at/above
    // 1e16 and always includes a signed, at-least-two-digit exponent.
    if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e16)) {
      encoded = value.toExponential();
    }
    if (encoded.includes("e")) {
      const [mantissa, rawExponent] = encoded.split("e");
      const negative = rawExponent!.startsWith("-");
      const exponent = rawExponent!.replace(/^[-+]/, "").padStart(2, "0");
      return `${mantissa}e${negative ? "-" : "+"}${exponent}`;
    }
    return encoded;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("DECODEBRIDGE_WORK_CELL_CANONICAL_JSON");
  return encoded;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fileDigest(filePath: string, maximumBytes = 64 * 1024 * 1024): Promise<string> {
  const entry = await lstat(filePath);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > maximumBytes) {
    throw new Error("DECODEBRIDGE_WORK_CELL_FILE_CONTRACT");
  }
  return digest(await readFile(filePath));
}

async function sourceTreeDigest(experimentRoot: string): Promise<string> {
  const entries = await Promise.all(SOURCE_IDENTITY_PATHS.map(async relative =>
    [relative, await fileDigest(path.join(experimentRoot, relative))] as const));
  // Match Swift's String.sorted() and Python's sorted(): raw code-point order,
  // not the host locale (which places lowercase main.swift differently).
  return digest(entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([relative, sha]) => `${relative}:${sha}`).join("\n"));
}

function resolveWorkCell(options: DecodeBridgeWorkCellOptions): ResolvedWorkCell {
  const experimentRoot = path.resolve(options.experimentRoot);
  const assetName = options.assetName ?? "owned-h264-bframes-322x182-stride.mp4";
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  if (!/^[A-Za-z0-9._-]+\.mp4$/.test(assetName)) {
    throw new Error("DECODEBRIDGE_WORK_CELL_ASSET_NAME");
  }
  return {
    experimentRoot,
    binary: path.join(experimentRoot, ".build", "release", "decodebridge"),
    manifest: path.join(experimentRoot, "artifacts", "asset-manifest-v1.json"),
    input: path.join(experimentRoot, "artifacts", assetName),
    verifier: path.join(experimentRoot, "verify_receipt.py"),
    shader: path.join(experimentRoot, "Sources", "DecodeBridge", "Shaders", "PatchFeatures.metal"),
    assetName,
    hostPolicyFiles: [
      path.join(moduleDirectory, "decodebridge-work-cell.ts"),
      path.join(moduleDirectory, "agent-service.ts"),
      path.join(moduleDirectory, "types.ts"),
    ],
    regressionArtifact: path.join(
      experimentRoot,
      "artifacts",
      "regressions",
      "decodebridge-pts-one-tick-v1.json",
    ),
    regressionVerifier: path.join(experimentRoot, "verify_runtime_regression.py"),
    runtimeControls: path.join(
      experimentRoot,
      "artifacts",
      "runtime-negative-controls",
      "latest.json",
    ),
    timeoutMs: options.timeoutMs ?? 60_000,
    leaseLifetimeMs: options.leaseLifetimeMs ?? 120_000,
  };
}

async function hostPolicyDigest(files: readonly string[]): Promise<string> {
  const entries = await Promise.all(files.map(async file =>
    [path.basename(file), await fileDigest(file)] as const));
  return digest(entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, sha]) => `${name}:${sha}`).join("\n"));
}

export class NodeDecodeBridgeCommandExecutor implements DecodeBridgeCommandExecutor {
  private readonly active = new Map<string, ChildProcess>();

  async run(input: Parameters<DecodeBridgeCommandExecutor["run"]>[0]): Promise<DecodeBridgeCommandResult> {
    if (this.active.has(input.key)) throw new Error("DECODEBRIDGE_COMMAND_ALREADY_ACTIVE");
    return await new Promise<DecodeBridgeCommandResult>((resolve, reject) => {
      const child = execFile(input.executable, input.arguments, {
        cwd: input.cwd,
        encoding: "utf8",
        timeout: input.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: input.maxOutputBytes,
        signal: input.signal,
        windowsHide: true,
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          LANG: "C.UTF-8",
          ...(process.env.TMPDIR ? {TMPDIR: process.env.TMPDIR} : {}),
        },
      }, (error, stdout, stderr) => {
        this.active.delete(input.key);
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({
          exitCode: error && typeof error.code === "number" ? error.code : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      });
      this.active.set(input.key, child);
    });
  }

  cancel(key: string): boolean {
    const child = this.active.get(key);
    if (!child) return false;
    return child.kill("SIGKILL");
  }
}

export class DecodeBridgeRunAuthority {
  private readonly evidenceByRun = new Map<string, DecodeBridgeAuthorityEvidence>();
  private readonly resolved: ResolvedWorkCell;
  private readonly clock: () => Date;

  constructor(options: DecodeBridgeWorkCellOptions) {
    this.resolved = resolveWorkCell(options);
    this.clock = options.now ?? (() => new Date());
  }

  paths(): Readonly<ResolvedWorkCell> {
    return this.resolved;
  }

  async issue(context: TaskAcceptanceContext, prompt: string): Promise<DecodeBridgeCapabilityLease> {
    if (this.evidenceByRun.has(context.runId)) throw new Error("DECODEBRIDGE_LEASE_ALREADY_EXISTS");
    const manifest = jsonRecord(JSON.parse(await readFile(this.resolved.manifest, "utf8")), "MANIFEST");
    const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
    const asset = assets.find(item => jsonRecord(item, "ASSET").path === this.resolved.assetName);
    const assetRecord = jsonRecord(asset, "ASSET");
    const inputSha256 = await fileDigest(this.resolved.input);
    if (assetRecord.sha256 !== inputSha256) throw new Error("DECODEBRIDGE_LEASE_INPUT_MANIFEST_MISMATCH");
    const issued = this.clock();
    const regression = jsonRecord(
      JSON.parse(await readFile(this.resolved.regressionArtifact, "utf8")),
      "REGRESSION",
    );
    if (regression.regression_id !== REGRESSION_ID ||
        regression.status !== "RETAINED_AFTER_REPRODUCTION_AND_REPLAY") {
      throw new Error("DECODEBRIDGE_LEASE_REGRESSION_CONTRACT");
    }
    const leaseBase = {
      version: 1 as const,
      leaseId: randomUUID(),
      runId: context.runId,
      agentId: context.agentId,
      workload: WORKLOAD as typeof WORKLOAD,
      route: ROUTE as typeof ROUTE,
      issuedAtUtc: issued.toISOString(),
      expiresAtUtc: new Date(issued.getTime() + this.resolved.leaseLifetimeMs).toISOString(),
      maxExecutions: 1 as const,
      scope: [
        "read:owned-stride-canary",
        "execute:digest-bound-decodebridge",
        "write:agent-workspace/decodebridge-agent-run.receipt.json",
        "network:denied-by-runner-contract",
        "benchmark:disabled",
      ],
      receiptName: RECEIPT_NAME as typeof RECEIPT_NAME,
      bindings: {
        executableSha256: await fileDigest(this.resolved.binary),
        sourceTreeSha256: await sourceTreeDigest(this.resolved.experimentRoot),
        inputSha256,
        manifestSha256: await fileDigest(this.resolved.manifest),
        shaderSha256: await fileDigest(this.resolved.shader),
        verifierSha256: await fileDigest(this.resolved.verifier),
        hostPolicySha256: await hostPolicyDigest(this.resolved.hostPolicyFiles),
        regressionArtifactSha256: await fileDigest(this.resolved.regressionArtifact),
        regressionPayloadSha256: String(regression.artifact_payload_sha256),
        regressionVerifierSha256: await fileDigest(this.resolved.regressionVerifier),
        contractSha256: digest(CONTRACT),
        promptSha256: digest(prompt),
      },
    };
    const lease: DecodeBridgeCapabilityLease = {
      ...leaseBase,
      leaseSha256: digest(canonicalJson(leaseBase)),
    };
    this.evidenceByRun.set(context.runId, {
      lease,
      state: "ISSUED",
      execution: null,
      verification: null,
      failureCode: null,
      closedAtUtc: null,
      closeReason: null,
    });
    return structuredClone(lease);
  }

  async consume(request: RunnerRequest): Promise<DecodeBridgeCapabilityLease> {
    const evidence = this.evidenceByRun.get(request.runId);
    if (!evidence || evidence.state !== "ISSUED") throw new Error("DECODEBRIDGE_LEASE_NOT_ISSUED");
    const lease = evidence.lease;
    if (lease.agentId !== request.agentId || lease.bindings.promptSha256 !== digest(request.prompt) ||
        Date.parse(lease.expiresAtUtc) <= this.clock().getTime()) {
      this.close(request.runId, "EXECUTION_FAILED");
      throw new Error("DECODEBRIDGE_LEASE_BINDING_OR_EXPIRY");
    }
    const current = await Promise.all([
      fileDigest(this.resolved.binary), sourceTreeDigest(this.resolved.experimentRoot),
      fileDigest(this.resolved.input), fileDigest(this.resolved.manifest),
      fileDigest(this.resolved.shader), fileDigest(this.resolved.verifier),
      hostPolicyDigest(this.resolved.hostPolicyFiles),
      fileDigest(this.resolved.regressionArtifact),
      fileDigest(this.resolved.regressionVerifier),
    ]);
    const expected = lease.bindings;
    if (current[0] !== expected.executableSha256 || current[1] !== expected.sourceTreeSha256 ||
        current[2] !== expected.inputSha256 || current[3] !== expected.manifestSha256 ||
        current[4] !== expected.shaderSha256 || current[5] !== expected.verifierSha256 ||
        current[6] !== expected.hostPolicySha256 ||
        current[7] !== expected.regressionArtifactSha256 ||
        current[8] !== expected.regressionVerifierSha256) {
      this.close(request.runId, "EXECUTION_FAILED");
      throw new Error("DECODEBRIDGE_LEASE_ARTIFACT_DRIFT");
    }
    evidence.state = "CONSUMED";
    return structuredClone(lease);
  }

  completeExecution(runId: string, execution: DecodeBridgeExecutionEvidence): void {
    const evidence = this.evidenceByRun.get(runId);
    if (!evidence || evidence.state !== "CONSUMED" || evidence.execution) {
      throw new Error("DECODEBRIDGE_EXECUTION_STATE_INVALID");
    }
    evidence.execution = structuredClone(execution);
  }

  completeVerification(runId: string, verification: DecodeBridgeVerificationEvidence): void {
    const evidence = this.evidenceByRun.get(runId);
    if (!evidence || evidence.state !== "CONSUMED" || !evidence.execution || evidence.verification) {
      throw new Error("DECODEBRIDGE_VERIFICATION_STATE_INVALID");
    }
    if (verification.receiptSha256 !== evidence.execution.receiptCanonicalSha256) {
      throw new Error("DECODEBRIDGE_VERIFICATION_RECEIPT_MISMATCH");
    }
    evidence.verification = structuredClone(verification);
    this.close(runId, "VERIFIED");
  }

  recordFailure(runId: string, error: unknown): void {
    const evidence = this.evidenceByRun.get(runId);
    if (!evidence) return;
    const raw = error instanceof Error ? error.message : String(error);
    evidence.failureCode = raw.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160);
  }

  close(runId: string, reason: NonNullable<DecodeBridgeAuthorityEvidence["closeReason"]>): void {
    const evidence = this.evidenceByRun.get(runId);
    if (!evidence || evidence.state === "CLOSED") return;
    evidence.state = "CLOSED";
    evidence.closedAtUtc = this.clock().toISOString();
    evidence.closeReason = reason;
  }

  evidence(runId: string): DecodeBridgeAuthorityEvidence {
    const evidence = this.evidenceByRun.get(runId);
    if (!evidence) throw new Error("DECODEBRIDGE_EVIDENCE_NOT_FOUND");
    return structuredClone(evidence);
  }
}

export class DecodeBridgeAgentRunner implements AgentRunner {
  constructor(
    private readonly authority: DecodeBridgeRunAuthority,
    private readonly commands: DecodeBridgeCommandExecutor,
  ) {}

  async run(request: RunnerRequest): Promise<RunnerResult> {
    const lease = await this.authority.consume(request);
    const paths = this.authority.paths();
    const receiptPath = path.join(request.workspacePath, lease.receiptName);
    const startedAtUtc = new Date().toISOString();
    try {
      const result = await this.commands.run({
        key: `run:${request.agentId}`,
        executable: paths.binary,
        arguments: ["--input", paths.input, "--source-root", paths.experimentRoot],
        cwd: paths.experimentRoot,
        timeoutMs: paths.timeoutMs,
        maxOutputBytes: 4 * 1024 * 1024,
      });
      if (result.exitCode !== 0) throw new Error(`DECODEBRIDGE_EXECUTION_EXIT_${result.exitCode}`);
      if (Buffer.byteLength(result.stdout, "utf8") > 2 * 1024 * 1024) {
        throw new Error("DECODEBRIDGE_RECEIPT_TOO_LARGE");
      }
      const receipt = jsonRecord(JSON.parse(result.stdout), "RECEIPT");
      const identity = jsonRecord(receipt.implementationIdentity, "IDENTITY");
      const bindingChecks: Array<[boolean, string]> = [
        [receipt.schemaVersion === 2, "SCHEMA"],
        [receipt.inputPath === paths.assetName, "INPUT_NAME"],
        [receipt.inputSHA256 === lease.bindings.inputSha256, "INPUT_SHA"],
        [identity.executableSHA256 === lease.bindings.executableSha256, "EXECUTABLE_SHA"],
        [identity.sourceTreeSHA256 === lease.bindings.sourceTreeSha256, "SOURCE_TREE_SHA"],
        [identity.runtimeShaderSHA256 === lease.bindings.shaderSha256, "SHADER_SHA"],
        [identity.verifierSHA256 === lease.bindings.verifierSha256, "VERIFIER_SHA"],
      ];
      const failedBinding = bindingChecks.find(([passed]) => !passed);
      if (failedBinding) throw new Error(`DECODEBRIDGE_EXECUTION_BINDING_${failedBinding[1]}`);
      const handle = await open(receiptPath, constants.O_WRONLY | constants.O_CREAT |
        constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(result.stdout, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.authority.completeExecution(request.runId, {
        startedAtUtc,
        completedAtUtc: new Date().toISOString(),
        exitCode: 0,
        receiptName: RECEIPT_NAME,
        receiptByteSha256: digest(result.stdout),
        receiptCanonicalSha256: digest(canonicalJson(receipt)),
        receiptBytes: Buffer.byteLength(result.stdout, "utf8"),
      });
      return {
        output: "DecodeBridge completed one lease-bound correctness run; independent acceptance passed before publication.",
        threadId: null,
        usage: null,
      };
    } catch (error) {
      this.authority.recordFailure(request.runId, error);
      this.authority.close(request.runId, "EXECUTION_FAILED");
      throw error;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    return this.commands.cancel(`run:${agentId}`);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const paths = this.authority.paths();
      await Promise.all([lstat(paths.binary), lstat(paths.input), lstat(paths.verifier)]);
      return true;
    } catch {
      return false;
    }
  }
}

export class DecodeBridgeAcceptanceVerifier implements TaskAcceptanceVerifier {
  static readonly id = "decodebridge-independent-verifier-v1" as const;
  readonly id = DecodeBridgeAcceptanceVerifier.id;

  constructor(
    private readonly authority: DecodeBridgeRunAuthority,
    private readonly commands: DecodeBridgeCommandExecutor,
    private readonly prompt: string,
  ) {}

  async prepare(context: TaskAcceptanceContext): Promise<unknown> {
    const lease = await this.authority.issue(context, this.prompt);
    return {leaseId: lease.leaseId, leaseSha256: lease.leaseSha256};
  }

  async verify(context: TaskAcceptanceContext & {
    checkpoint: unknown;
    run: Readonly<AgentRun>;
  }): Promise<{accepted: boolean}> {
    const checkpoint = jsonRecord(context.checkpoint, "CHECKPOINT");
    const evidence = this.authority.evidence(context.runId);
    if (checkpoint.leaseId !== evidence.lease.leaseId ||
        checkpoint.leaseSha256 !== evidence.lease.leaseSha256 ||
        evidence.state !== "CONSUMED" || !evidence.execution ||
        context.run.prompt !== this.prompt || context.run.guard?.verdict !== "retained" ||
        context.run.guard.changedFiles.length !== 1 ||
        context.run.guard.changedFiles[0] !== RECEIPT_NAME) {
      this.authority.recordFailure(context.runId, "DECODEBRIDGE_VERIFICATION_CONTEXT");
      this.authority.close(context.runId, "VERIFICATION_REJECTED");
      return {accepted: false};
    }
    const paths = this.authority.paths();
    const receiptPath = path.join(context.workspacePath, RECEIPT_NAME);
    const receiptBytes = await readFile(receiptPath);
    if (digest(receiptBytes) !== evidence.execution.receiptByteSha256) {
      this.authority.recordFailure(context.runId, "DECODEBRIDGE_VERIFICATION_RECEIPT_BYTES");
      this.authority.close(context.runId, "VERIFICATION_REJECTED");
      return {accepted: false};
    }
    const result = await this.commands.run({
      key: `verify:${context.runId}`,
      executable: "/usr/bin/python3",
      arguments: [
        paths.verifier,
        "--receipt", receiptPath,
        "--manifest", paths.manifest,
        "--source-root", paths.experimentRoot,
        "--binary", paths.binary,
      ],
      cwd: paths.experimentRoot,
      timeoutMs: paths.timeoutMs,
      maxOutputBytes: 256 * 1024,
      signal: context.signal,
    });
    if (result.exitCode !== 0) {
      this.authority.recordFailure(context.runId,
        `DECODEBRIDGE_VERIFIER_EXIT_${result.exitCode}:${result.stdout.slice(0, 120)}`);
      this.authority.close(context.runId, "VERIFICATION_REJECTED");
      return {accepted: false};
    }
    const verification = jsonRecord(JSON.parse(result.stdout), "VERIFICATION");
    if (verification.verdict !== "PASS" || !Array.isArray(verification.failed_gates) ||
        verification.failed_gates.length !== 0 ||
        verification.receipt_sha256 !== evidence.execution.receiptCanonicalSha256) {
      this.authority.recordFailure(context.runId,
        `DECODEBRIDGE_VERIFIER_OUTPUT_${String(verification.verdict)}_${String(verification.receipt_sha256)}`);
      this.authority.close(context.runId, "VERIFICATION_REJECTED");
      return {accepted: false};
    }
    const regressionResult = await this.commands.run({
      key: `regression:${context.runId}`,
      executable: "/usr/bin/python3",
      arguments: [
        paths.regressionVerifier,
        "--artifact", paths.regressionArtifact,
        "--binary", paths.binary,
        "--asset", paths.input,
        "--runtime-controls", paths.runtimeControls,
      ],
      cwd: paths.experimentRoot,
      timeoutMs: paths.timeoutMs,
      maxOutputBytes: 256 * 1024,
      signal: context.signal,
    });
    if (regressionResult.exitCode !== 0) {
      this.authority.recordFailure(context.runId,
        `DECODEBRIDGE_REGRESSION_EXIT_${regressionResult.exitCode}`);
      this.authority.close(context.runId, "VERIFICATION_REJECTED");
      return {accepted: false};
    }
    const regression = jsonRecord(JSON.parse(regressionResult.stdout), "REGRESSION_REPLAY");
    const regressionFailedGates = Array.isArray(regression.failed_gates)
      ? regression.failed_gates : ["invalid"];
    const freshReplay = jsonRecord(regression.fresh_replay, "REGRESSION_FRESH_REPLAY");
    if (regression.verdict !== "PASS" || regression.regression_id !== REGRESSION_ID ||
        regressionFailedGates.length !== 0 ||
        regression.artifact_payload_sha256 !== evidence.lease.bindings.regressionPayloadSha256 ||
        freshReplay.exit_code !== 2 ||
        freshReplay.expected_gate !== "timeline.reference_exact_match" ||
        freshReplay.observed_gate !== "timeline.reference_exact_match" ||
        freshReplay.verdict !== "REJECTED_AS_EXPECTED") {
      this.authority.recordFailure(context.runId, "DECODEBRIDGE_REGRESSION_REPLAY_INVALID");
      this.authority.close(context.runId, "VERIFICATION_REJECTED");
      return {accepted: false};
    }
    this.authority.completeVerification(context.runId, {
      checkedAtUtc: new Date().toISOString(),
      verifierId: DecodeBridgeAcceptanceVerifier.id,
      verdict: "PASS",
      failedGates: [],
      receiptSha256: evidence.execution.receiptCanonicalSha256,
      regressionIds: [REGRESSION_ID],
      regressionReplayExecutionSha256: String(freshReplay.execution_sha256),
    });
    return {accepted: true};
  }
}

export function createDecodeBridgeWorkCell(options: DecodeBridgeWorkCellOptions, prompt: string) {
  const commands = options.commandExecutor ?? new NodeDecodeBridgeCommandExecutor();
  const authority = new DecodeBridgeRunAuthority(options);
  return {
    authority,
    runner: new DecodeBridgeAgentRunner(authority, commands),
    verifier: new DecodeBridgeAcceptanceVerifier(authority, commands, prompt),
  };
}

export const decodeBridgeWorkCellContract = Object.freeze({
  workload: WORKLOAD,
  route: ROUTE,
  contractSha256: digest(CONTRACT),
  receiptName: RECEIPT_NAME,
  regressionId: REGRESSION_ID,
});

export function decodeBridgeCanonicalSha256(value: unknown): string {
  return digest(canonicalJson(value));
}
