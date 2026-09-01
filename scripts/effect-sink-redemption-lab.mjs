#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const defaultEvidenceDirectory = path.join(
  projectRoot,
  "research/evidence/final-algorithm-lab",
);

const OFFICIAL_TRACK =
  "Track #1: Agent Launchpad: Design and Build Lightweight Agent Middleware";
const SCENARIO = "The Kill Switch";
const SINK_ACTION = "write_demo_result";
const SINK_TARGET = "workspace";
const MAX_SINK_TTL_MS = 2_000;
const FIXTURE_PAYLOAD = Buffer.from(
  "NerveLoop sink-side redemption succeeded exactly once.\n",
  "utf8",
);
const FIXTURE_RELATIVE_PATH = "demo-result.md";

const RESEARCH_SOURCES = Object.freeze([
  Object.freeze({
    title: "If Agents Were Angels, No Governance Would Be Necessary: Out-of-Band Policy Enforcement at a Trusted Tool Boundary",
    url: "https://arxiv.org/abs/2608.27646",
    designUse:
      "Keep effect authorization outside agent reasoning and mediate the typed operation and resource at the trusted boundary.",
    nonClaim:
      "This lab does not reproduce the paper's proxy, Cedar core, benchmark, data filtering, or security guarantees.",
  }),
  Object.freeze({
    title: "Capsicum: Practical Capabilities for UNIX",
    url: "https://www.usenix.org/conference/usenixsecurity10/legacy-presentation/capsicum-practical-capabilities-unix",
    designUse:
      "Bind narrowly scoped authority to an object and make the effect path present that authority instead of relying on ambient privilege.",
    nonClaim:
      "This user-space Node prototype is not Capsicum, kernel capability mode, or a hardened sandbox.",
  }),
  Object.freeze({
    title: "Macaroons: Cookies with Contextual Caveats for Decentralized Authorization in the Cloud",
    url: "https://www.ndss-symposium.org/ndss2014/ndss-2014-programme/macaroons-cookies-contextual-caveats-decentralized-authorization-cloud/",
    designUse:
      "Cryptographically bind contextual restrictions such as who, what, where, and when to an authorization token.",
    nonClaim:
      "The envelope below is a process-local HMAC prototype, not a macaroon, delegation system, or distributed credential.",
  }),
  Object.freeze({
    title: "TLA+ Model Checking Made Symbolic",
    url: "https://www.microsoft.com/en-us/research/publication/tla-model-checking-made-symbolic/",
    designUse:
      "Check a finite transition system against explicit safety invariants rather than relying only on example traces.",
    nonClaim:
      "This is a bounded deterministic state-space experiment, not a TLA+ specification or formal proof.",
  }),
]);

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("CANONICAL_JSON_INVALID");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256RegularFile(filePath) {
  const entry = await lstat(filePath);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("SOURCE_BINDING_NOT_REGULAR_FILE");
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size) {
      throw new Error("SOURCE_BINDING_CHANGED_BEFORE_READ");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(filePath);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
        current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size) {
      throw new Error("SOURCE_BINDING_CHANGED_DURING_READ");
    }
    return sha256(bytes);
  } finally {
    await handle.close();
  }
}

export class SinkRedemptionError extends Error {
  constructor(code) {
    super(code);
    this.name = "SinkRedemptionError";
    this.code = code;
  }
}

function sinkError(code) {
  throw new SinkRedemptionError(code);
}

function validSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validRelativeFile(value) {
  return typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value) &&
    value !== "." && value !== "..";
}

function envelopePayload(envelope) {
  const { tag: _ignored, ...payload } = envelope;
  return payload;
}

function hmacTag(key, payload) {
  return createHmac("sha256", key).update(canonicalJson(payload)).digest("hex");
}

function equalTag(left, right) {
  if (!validSha256(left) || !validSha256(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function exactObject(left, right) {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

/**
 * Experimental reference monitor for one exact filesystem effect.
 *
 * A host-consumed EffectCapability is attenuated into an HMAC-bound envelope
 * for one path and one payload. The worker can present that envelope only to
 * this sink. Authorization is spent synchronously before the first await, so
 * concurrent replays cannot both pass in this process.
 */
export class ProcessLocalEffectSink {
  #entries = new Map();
  #derivedParents = new Set();
  #key;

  constructor({
    root,
    registry,
    now = Date.now,
    key = randomBytes(32),
    sinkGrantId = randomUUID,
    beforeIo = async () => {},
  }) {
    if (typeof root !== "string" || !path.isAbsolute(root)) sinkError("SINK_ROOT_INVALID");
    if (!registry || typeof registry.inspect !== "function") sinkError("SINK_REGISTRY_INVALID");
    if (typeof now !== "function" || typeof sinkGrantId !== "function" || typeof beforeIo !== "function") {
      sinkError("SINK_OPTIONS_INVALID");
    }
    if (!Buffer.isBuffer(key) || key.length < 32) sinkError("SINK_KEY_INVALID");
    if (!Number.isInteger(constants.O_NOFOLLOW)) sinkError("SINK_NOFOLLOW_UNAVAILABLE");
    const requestedRoot = path.resolve(root);
    let rootEntry;
    let canonicalRoot;
    try {
      rootEntry = lstatSync(requestedRoot);
      canonicalRoot = realpathSync(requestedRoot);
    } catch {
      sinkError("SINK_ROOT_INVALID");
    }
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
      sinkError("SINK_ROOT_INVALID");
    }
    this.root = canonicalRoot;
    this.rootIdentity = Object.freeze({
      device: String(rootEntry.dev),
      inode: String(rootEntry.ino),
      canonicalRoot,
    });
    this.rootIdentitySha256 = sha256(Buffer.from(canonicalJson(this.rootIdentity), "utf8"));
    this.registry = registry;
    this.now = now;
    this.sinkGrantId = sinkGrantId;
    this.beforeIo = beforeIo;
    this.#key = Buffer.from(key);
  }

  async #assertRootIdentity() {
    let current;
    let canonicalRoot;
    try {
      current = await lstat(this.root);
      canonicalRoot = await realpath(this.root);
    } catch {
      sinkError("SINK_ROOT_CHANGED");
    }
    if (!current.isDirectory() || current.isSymbolicLink() ||
        String(current.dev) !== this.rootIdentity.device ||
        String(current.ino) !== this.rootIdentity.inode ||
        canonicalRoot !== this.rootIdentity.canonicalRoot) {
      sinkError("SINK_ROOT_CHANGED");
    }
  }

  mint(consumedCapability, { relativePath, payloadSha256, ttlMs = 1_000 }) {
    const current = this.registry.inspect(consumedCapability?.grantId);
    if (!current || !exactObject(current, consumedCapability) || current.state !== "consumed") {
      sinkError("SINK_PARENT_CAPABILITY_INVALID");
    }
    if (current.action !== SINK_ACTION || current.targetClass !== SINK_TARGET) {
      sinkError("SINK_CAPABILITY_SCOPE_MISMATCH");
    }
    if (!validRelativeFile(relativePath) || !validSha256(payloadSha256) ||
        !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_SINK_TTL_MS) {
      sinkError("SINK_CAVEAT_INVALID");
    }
    const issuedAtMs = this.now();
    const parentExpiresAtMs = Date.parse(current.expiresAt);
    if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0 ||
        !Number.isSafeInteger(parentExpiresAtMs) || issuedAtMs >= parentExpiresAtMs) {
      sinkError("SINK_PARENT_CAPABILITY_EXPIRED");
    }
    const expiresAtMs = Math.min(issuedAtMs + ttlMs, parentExpiresAtMs);
    const sinkGrantId = this.sinkGrantId();
    if (typeof sinkGrantId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(sinkGrantId) ||
        this.#entries.has(sinkGrantId)) {
      sinkError("SINK_GRANT_ID_INVALID");
    }
    // One consumed parent may derive at most one child. The reservation occurs
    // synchronously, before callers can interleave another mint in this process.
    if (this.#derivedParents.has(current.grantId)) sinkError("SINK_PARENT_ALREADY_DERIVED");
    this.#derivedParents.add(current.grantId);
    const payload = Object.freeze({
      version: 1,
      scheme: "hmac-sha256-process-local-v1",
      sinkGrantId,
      parentGrantId: current.grantId,
      runId: current.runId,
      agentId: current.agentId,
      action: current.action,
      targetClass: current.targetClass,
      policy: current.policy,
      policyVersion: current.policyVersion,
      policyDigest: current.policyDigest,
      workspaceRootIdentitySha256: this.rootIdentitySha256,
      relativePath,
      payloadSha256,
      issuedAtMs,
      expiresAtMs,
    });
    const envelope = Object.freeze({ ...payload, tag: hmacTag(this.#key, payload) });
    this.#entries.set(sinkGrantId, {
      envelope,
      state: "dispatch_ready",
      redeemedAtMs: null,
    });
    return envelope;
  }

  inspect(sinkGrantId) {
    const entry = this.#entries.get(sinkGrantId);
    return entry ? Object.freeze({
      state: entry.state,
      redeemedAtMs: entry.redeemedAtMs,
      relativePath: entry.envelope.relativePath,
      payloadSha256: entry.envelope.payloadSha256,
    }) : null;
  }

  async redeemAndWrite(envelope, request) {
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
        typeof envelope.sinkGrantId !== "string") {
      sinkError("SINK_CAPABILITY_INVALID");
    }
    const entry = this.#entries.get(envelope.sinkGrantId);
    if (!entry) sinkError("SINK_CAPABILITY_UNKNOWN");
    const payload = envelopePayload(envelope);
    if (!equalTag(envelope.tag, hmacTag(this.#key, payload)) ||
        !exactObject(envelope, entry.envelope)) {
      sinkError("SINK_CAPABILITY_TAMPERED");
    }
    if (!request || typeof request !== "object" || Array.isArray(request) ||
        Object.keys(request).sort().join(",") !==
          "action,agentId,payload,relativePath,runId,targetClass" ||
        !Buffer.isBuffer(request.payload)) {
      sinkError("SINK_REQUEST_INVALID");
    }
    // Snapshot caller-owned mutable bytes before the first await. Validation
    // and I/O use only this copy.
    const immutablePayload = Buffer.from(request.payload);
    const requestMatches = request.runId === envelope.runId &&
      request.agentId === envelope.agentId &&
      request.action === envelope.action &&
      request.targetClass === envelope.targetClass &&
      request.relativePath === envelope.relativePath &&
      sha256(immutablePayload) === envelope.payloadSha256;
    if (!requestMatches) sinkError("SINK_CAPABILITY_CONTEXT_MISMATCH");
    if (entry.state !== "dispatch_ready") sinkError("SINK_CAPABILITY_ALREADY_REDEEMED");
    const redeemedAtMs = this.now();
    if (!Number.isSafeInteger(redeemedAtMs) || redeemedAtMs < envelope.issuedAtMs ||
        redeemedAtMs >= envelope.expiresAtMs) {
      sinkError("SINK_CAPABILITY_EXPIRED");
    }

    // Linearization point: spend before any asynchronous filesystem action.
    entry.state = "redeeming";
    entry.redeemedAtMs = redeemedAtMs;

    const destination = path.resolve(this.root, envelope.relativePath);
    if (path.dirname(destination) !== this.root) sinkError("SINK_DESTINATION_INVALID");
    const staging = path.join(this.root, `.nerveloop-${envelope.sinkGrantId}.staging`);
    let handle = null;
    try {
      await this.beforeIo();
      await this.#assertRootIdentity();
      handle = await open(
        staging,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(immutablePayload);
      await handle.sync();
      await handle.close();
      handle = null;
      // link() is an exclusive publish: an existing regular file or symlink
      // causes EEXIST instead of being followed or overwritten.
      await link(staging, destination);
      await unlink(staging);
      await this.#assertRootIdentity();
      entry.state = "redeemed";
      return Object.freeze({
        state: "redeemed",
        relativePath: envelope.relativePath,
        payloadSha256: sha256(immutablePayload),
        bytesWritten: immutablePayload.length,
      });
    } catch (error) {
      try {
        if (handle) await handle.close();
      } catch {
        // Continue to bounded staging cleanup.
      }
      await rm(staging, { force: true });
      entry.state = "failed_closed";
      if (error instanceof SinkRedemptionError) throw error;
      sinkError("SINK_EFFECT_FAILED");
    }
  }
}

async function loadProductionModules() {
  const [policy, capability] = await Promise.all([
    tsImport("../apps/server/src/effect-policy.ts", import.meta.url),
    tsImport("../apps/server/src/effect-capability.ts", import.meta.url),
  ]);
  return { policy, capability };
}

function capabilityErrorCode(operation, EffectCapabilityError) {
  try {
    operation();
  } catch (error) {
    return error instanceof EffectCapabilityError ? error.code : String(error?.message ?? error);
  }
  return null;
}

function sinkErrorCode(error) {
  return error instanceof SinkRedemptionError ? error.code : String(error?.message ?? error);
}

function createClock(start = 1_800_000_000_000) {
  return { value: start, now() { return this.value; } };
}

function boundedOperationTraces(alphabet, maximumLength) {
  const traces = [];
  let frontier = [[]];
  for (let length = 1; length <= maximumLength; length += 1) {
    frontier = frontier.flatMap((prefix) => alphabet.map((operation) => [...prefix, operation]));
    traces.push(...frontier);
  }
  return traces;
}

function capabilityOracleStep(state, operation) {
  if (operation === "claim_binding_drift") {
    return { state, error: "EFFECT_CAPABILITY_BINDING_MISMATCH" };
  }
  if (operation === "claim_valid") {
    return state === "issued"
      ? { state: "claimed", error: null }
      : { state, error: "EFFECT_CAPABILITY_ALREADY_CLAIMED" };
  }
  if (state === "issued") return { state, error: "EFFECT_CAPABILITY_NOT_CLAIMED" };
  return state === "claimed"
    ? { state: "consumed", error: null }
    : { state, error: "EFFECT_CAPABILITY_ALREADY_CONSUMED" };
}

function runCapabilityLifecycleOracle(modules) {
  const alphabet = ["claim_valid", "claim_binding_drift", "consume_valid"];
  const traces = boundedOperationTraces(alphabet, 4);
  let operations = 0;
  let mismatches = 0;
  let maximumSuccessfulClaims = 0;
  let maximumSuccessfulConsumes = 0;

  for (const [traceIndex, trace] of traces.entries()) {
    let milliseconds = 1_850_000_000_000;
    const registry = new modules.capability.EffectCapabilityRegistry({
      now: () => milliseconds,
      grantId: () => `sink_model_parent_${traceIndex}`,
    });
    const decision = modules.policy.decideEffect({
      version: 1,
      action: SINK_ACTION,
      targetClass: SINK_TARGET,
    });
    let latest = registry.issue({
      runId: `run_model_${traceIndex}`,
      agentId: "agent_model",
      decision,
    });
    const binding = modules.capability.bindingFromCapability(latest);
    const drifted = { ...binding, action: "read_asset_metadata" };
    let oracleState = "issued";
    let successfulClaims = 0;
    let successfulConsumes = 0;

    for (const operation of trace) {
      operations += 1;
      milliseconds += 1;
      const expected = capabilityOracleStep(oracleState, operation);
      let actualError = null;
      try {
        if (operation === "claim_valid") latest = registry.claim(latest, binding);
        else if (operation === "claim_binding_drift") latest = registry.claim(latest, drifted);
        else latest = registry.consume(latest, binding);
      } catch (error) {
        actualError = capabilityErrorCode(() => { throw error; }, modules.capability.EffectCapabilityError);
      }
      if (actualError === null && operation === "claim_valid") successfulClaims += 1;
      if (actualError === null && operation === "consume_valid") successfulConsumes += 1;
      oracleState = expected.state;
      const observed = registry.inspect(latest.grantId);
      if (actualError !== expected.error || observed?.state !== oracleState ||
          observed?.usesClaimed !== (oracleState === "issued" ? 0 : 1) ||
          successfulClaims > 1 || successfulConsumes > 1 || successfulConsumes > successfulClaims) {
        mismatches += 1;
      }
    }
    maximumSuccessfulClaims = Math.max(maximumSuccessfulClaims, successfulClaims);
    maximumSuccessfulConsumes = Math.max(maximumSuccessfulConsumes, successfulConsumes);
  }

  return {
    alphabet,
    maximumTraceLength: 4,
    traces: traces.length,
    operations,
    mismatches,
    maximumSuccessfulClaims,
    maximumSuccessfulConsumes,
  };
}

function exactRequest(envelope, payload = FIXTURE_PAYLOAD) {
  return {
    runId: envelope.runId,
    agentId: envelope.agentId,
    action: envelope.action,
    targetClass: envelope.targetClass,
    relativePath: envelope.relativePath,
    payload: Buffer.from(payload),
  };
}

function mutationValue(field, current) {
  switch (field) {
    case "sinkGrantId": return `${current}x`;
    case "parentGrantId": return `${current}x`;
    case "runId": return `${current}_other`;
    case "agentId": return `${current}_other`;
    case "action": return "read_asset_metadata";
    case "targetClass": return "scratch";
    case "policy": return "effect-firewall-v2";
    case "policyVersion": return 2;
    case "policyDigest": return "f".repeat(64);
    case "workspaceRootIdentitySha256": return "e".repeat(64);
    case "relativePath": return "other-result.md";
    case "payloadSha256": return "0".repeat(64);
    case "issuedAtMs": return current + 1;
    case "expiresAtMs": return current + 1;
    case "tag": return `${current[0] === "0" ? "1" : "0"}${current.slice(1)}`;
    default: throw new Error(`UNKNOWN_MUTATION_FIELD:${field}`);
  }
}

async function freshHarness(modules, label, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), `nerveloop-sink-${label}-`));
  const clock = options.clock ?? createClock();
  const registry = new modules.capability.EffectCapabilityRegistry({
    now: () => clock.now(),
    grantId: () => `parent_${label}`,
  });
  const decision = modules.policy.decideEffect({
    version: 1,
    action: SINK_ACTION,
    targetClass: SINK_TARGET,
  });
  const issued = registry.issue({
    runId: `run_${label}`,
    agentId: `agent_${label}`,
    decision,
    ttlMs: options.parentTtlMs ?? 5_000,
  });
  const binding = modules.capability.bindingFromCapability(issued);
  const claimed = registry.claim(issued, binding);
  const consumed = registry.consume(claimed, binding);
  let sinkGrantSequence = 0;
  const sink = new ProcessLocalEffectSink({
    root,
    registry,
    now: () => clock.now(),
    key: Buffer.alloc(32, 0x42),
    sinkGrantId: () => `sink_${label}_${++sinkGrantSequence}`,
    beforeIo: options.beforeIo ?? (async () => {}),
  });
  const envelope = sink.mint(consumed, {
    relativePath: FIXTURE_RELATIVE_PATH,
    payloadSha256: sha256(FIXTURE_PAYLOAD),
    ttlMs: options.sinkTtlMs ?? 1_000,
  });
  return { root, clock, registry, consumed, sink, envelope };
}

async function runLatticeAttenuation(modules) {
  const outcomes = [];
  let allowed = 0;
  let denied = 0;
  let deniedCapabilitiesIssued = 0;
  let allowedCapabilitiesConsumed = 0;
  let sinkMintable = 0;
  let broaderAllowedScopesRejectedBySink = 0;
  let sequence = 0;

  for (const action of modules.policy.EFFECT_ACTIONS_BY_RISK) {
    for (const targetClass of modules.policy.EFFECT_TARGETS_BY_SENSITIVITY) {
      sequence += 1;
      const clock = createClock();
      const registry = new modules.capability.EffectCapabilityRegistry({
        now: () => clock.now(),
        grantId: () => `lattice_parent_${sequence}`,
      });
      const decision = modules.policy.decideEffect({ version: 1, action, targetClass });
      if (decision.verdict === "denied") {
        denied += 1;
        const error = capabilityErrorCode(() => registry.issue({
          runId: `run_lattice_${sequence}`,
          agentId: "agent_lattice",
          decision,
        }), modules.capability.EffectCapabilityError);
        if (error === null) deniedCapabilitiesIssued += 1;
        outcomes.push({ action, targetClass, decision: "denied", issueError: error });
        continue;
      }

      allowed += 1;
      const issued = registry.issue({
        runId: `run_lattice_${sequence}`,
        agentId: "agent_lattice",
        decision,
      });
      const binding = modules.capability.bindingFromCapability(issued);
      const claimed = registry.claim(issued, binding);
      const consumed = registry.consume(claimed, binding);
      allowedCapabilitiesConsumed += consumed.state === "consumed" ? 1 : 0;
      const root = await mkdtemp(path.join(tmpdir(), "nerveloop-sink-lattice-"));
      const sink = new ProcessLocalEffectSink({
        root,
        registry,
        now: () => clock.now(),
        key: Buffer.alloc(32, 0x43),
        sinkGrantId: () => `lattice_sink_${sequence}`,
      });
      let sinkResult = "minted";
      try {
        sink.mint(consumed, {
          relativePath: FIXTURE_RELATIVE_PATH,
          payloadSha256: sha256(FIXTURE_PAYLOAD),
        });
        sinkMintable += 1;
      } catch (error) {
        sinkResult = sinkErrorCode(error);
        if (sinkResult === "SINK_CAPABILITY_SCOPE_MISMATCH") {
          broaderAllowedScopesRejectedBySink += 1;
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
      outcomes.push({ action, targetClass, decision: "allowed", capabilityState: consumed.state, sinkResult });
    }
  }

  return {
    totalCells: outcomes.length,
    allowed,
    denied,
    deniedCapabilitiesIssued,
    allowedCapabilitiesConsumed,
    sinkMintable,
    broaderAllowedScopesRejectedBySink,
    outcomes,
  };
}

async function runCombinatorialTamperMatrix(modules) {
  const harness = await freshHarness(modules, "tamper");
  try {
    const fields = [
      "sinkGrantId",
      "parentGrantId",
      "runId",
      "agentId",
      "action",
      "targetClass",
      "policy",
      "policyVersion",
      "policyDigest",
      "workspaceRootIdentitySha256",
      "relativePath",
      "payloadSha256",
      "issuedAtMs",
      "expiresAtMs",
      "tag",
    ];
    let envelopeMutationsRejected = 0;
    const envelopeErrors = {};
    for (let mask = 1; mask < 2 ** fields.length; mask += 1) {
      const mutated = { ...harness.envelope };
      for (let bit = 0; bit < fields.length; bit += 1) {
        if ((mask & (1 << bit)) !== 0) {
          const field = fields[bit];
          mutated[field] = mutationValue(field, mutated[field]);
        }
      }
      try {
        await harness.sink.redeemAndWrite(mutated, exactRequest(harness.envelope));
      } catch (error) {
        const code = sinkErrorCode(error);
        envelopeErrors[code] = (envelopeErrors[code] ?? 0) + 1;
        envelopeMutationsRejected += 1;
      }
    }

    const requestFields = ["runId", "agentId", "action", "targetClass", "relativePath", "payload"];
    let contextualMutationsRejected = 0;
    const contextualErrors = {};
    for (let mask = 1; mask < 2 ** requestFields.length; mask += 1) {
      const mutated = exactRequest(harness.envelope);
      for (let bit = 0; bit < requestFields.length; bit += 1) {
        if ((mask & (1 << bit)) === 0) continue;
        const field = requestFields[bit];
        mutated[field] = field === "payload"
          ? Buffer.from("different payload\n", "utf8")
          : mutationValue(field, mutated[field]);
      }
      try {
        await harness.sink.redeemAndWrite(harness.envelope, mutated);
      } catch (error) {
        const code = sinkErrorCode(error);
        contextualErrors[code] = (contextualErrors[code] ?? 0) + 1;
        contextualMutationsRejected += 1;
      }
    }

    const stateBeforeValid = harness.sink.inspect(harness.envelope.sinkGrantId)?.state;
    const valid = await harness.sink.redeemAndWrite(
      harness.envelope,
      exactRequest(harness.envelope),
    );
    const written = await readFile(path.join(harness.root, FIXTURE_RELATIVE_PATH));
    let replayError = null;
    try {
      await harness.sink.redeemAndWrite(harness.envelope, exactRequest(harness.envelope));
    } catch (error) {
      replayError = sinkErrorCode(error);
    }

    return {
      envelopeFieldsMutated: fields.length,
      envelopeMutationCombinations: 2 ** fields.length - 1,
      envelopeMutationsRejected,
      envelopeMutationEscapes: 2 ** fields.length - 1 - envelopeMutationsRejected,
      envelopeErrors,
      contextualFieldsMutated: requestFields.length,
      contextualMutationCombinations: 2 ** requestFields.length - 1,
      contextualMutationsRejected,
      contextualMutationEscapes: 2 ** requestFields.length - 1 - contextualMutationsRejected,
      contextualErrors,
      stateBeforeValid,
      validWrite: valid,
      writtenPayloadSha256: sha256(written),
      replayError,
      finalState: harness.sink.inspect(harness.envelope.sinkGrantId)?.state,
    };
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
}

async function runConcurrentRedemption(modules) {
  const harness = await freshHarness(modules, "concurrent");
  try {
    const attempts = await Promise.allSettled(
      Array.from({ length: 64 }, () =>
        harness.sink.redeemAndWrite(harness.envelope, exactRequest(harness.envelope))),
    );
    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    const rejectionCodes = {};
    for (const attempt of rejected) {
      const code = sinkErrorCode(attempt.reason);
      rejectionCodes[code] = (rejectionCodes[code] ?? 0) + 1;
    }
    const bytes = await readFile(path.join(harness.root, FIXTURE_RELATIVE_PATH));
    return {
      attempts: attempts.length,
      successes: fulfilled.length,
      rejections: rejected.length,
      rejectionCodes,
      finalState: harness.sink.inspect(harness.envelope.sinkGrantId)?.state,
      writtenPayloadSha256: sha256(bytes),
    };
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
}

async function runExpiryBoundary(modules) {
  const harness = await freshHarness(modules, "expiry", { sinkTtlMs: 10 });
  try {
    const sinkExpiresAtMs = harness.envelope.expiresAtMs;
    const parentExpiresAtMs = Date.parse(harness.consumed.expiresAt);
    harness.clock.value = sinkExpiresAtMs;
    let error = null;
    try {
      await harness.sink.redeemAndWrite(harness.envelope, exactRequest(harness.envelope));
    } catch (caught) {
      error = sinkErrorCode(caught);
    }
    let fileCreated = true;
    try {
      await access(path.join(harness.root, FIXTURE_RELATIVE_PATH));
    } catch {
      fileCreated = false;
    }
    return {
      exactBoundaryRejected: error === "SINK_CAPABILITY_EXPIRED",
      error,
      fileCreated,
      state: harness.sink.inspect(harness.envelope.sinkGrantId)?.state,
      sinkExpiresNoLaterThanParent: sinkExpiresAtMs <= parentExpiresAtMs,
      sinkTtlMs: sinkExpiresAtMs - harness.envelope.issuedAtMs,
    };
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
}

async function runSymlinkFault(modules) {
  const harness = await freshHarness(modules, "symlink");
  const externalRoot = await mkdtemp(path.join(tmpdir(), "nerveloop-sink-external-"));
  const externalPath = path.join(externalRoot, "sentinel.txt");
  const sentinel = Buffer.from("external sentinel must remain unchanged\n", "utf8");
  try {
    await writeFile(externalPath, sentinel, { mode: 0o600 });
    await symlink(externalPath, path.join(harness.root, FIXTURE_RELATIVE_PATH));
    let error = null;
    try {
      await harness.sink.redeemAndWrite(harness.envelope, exactRequest(harness.envelope));
    } catch (caught) {
      error = sinkErrorCode(caught);
    }
    const after = await readFile(externalPath);
    const destination = await lstat(path.join(harness.root, FIXTURE_RELATIVE_PATH));
    let retryError = null;
    try {
      await harness.sink.redeemAndWrite(harness.envelope, exactRequest(harness.envelope));
    } catch (caught) {
      retryError = sinkErrorCode(caught);
    }
    return {
      effectError: error,
      externalSentinelUnchanged: after.equals(sentinel),
      destinationStillSymlink: destination.isSymbolicLink(),
      stateAfterFault: harness.sink.inspect(harness.envelope.sinkGrantId)?.state,
      retryError,
      failStopSpentGrant: retryError === "SINK_CAPABILITY_ALREADY_REDEEMED",
    };
  } finally {
    await rm(harness.root, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
}

async function runSingleParentDerivation(modules) {
  const harness = await freshHarness(modules, "parent-once");
  try {
    let secondMintError = null;
    try {
      harness.sink.mint(harness.consumed, {
        relativePath: "second-result.md",
        payloadSha256: sha256(Buffer.from("second payload\n", "utf8")),
      });
    } catch (error) {
      secondMintError = sinkErrorCode(error);
    }
    return {
      firstChildState: harness.sink.inspect(harness.envelope.sinkGrantId)?.state,
      secondMintError,
      oneParentOneChild: secondMintError === "SINK_PARENT_ALREADY_DERIVED",
    };
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
}

async function runRootReplacementFault(modules) {
  const harness = await freshHarness(modules, "root-swap");
  const movedRoot = `${harness.root}-moved`;
  const externalRoot = await mkdtemp(path.join(tmpdir(), "nerveloop-sink-root-external-"));
  const externalDestination = path.join(externalRoot, FIXTURE_RELATIVE_PATH);
  try {
    await rename(harness.root, movedRoot);
    await symlink(externalRoot, harness.root, "dir");
    let error = null;
    try {
      await harness.sink.redeemAndWrite(harness.envelope, exactRequest(harness.envelope));
    } catch (caught) {
      error = sinkErrorCode(caught);
    }
    let externalFileCreated = true;
    try {
      await access(externalDestination);
    } catch {
      externalFileCreated = false;
    }
    let retryError = null;
    try {
      await harness.sink.redeemAndWrite(harness.envelope, exactRequest(harness.envelope));
    } catch (caught) {
      retryError = sinkErrorCode(caught);
    }
    return {
      error,
      externalFileCreated,
      stateAfterFault: harness.sink.inspect(harness.envelope.sinkGrantId)?.state,
      retryError,
      deterministicReplacementRejected: error === "SINK_ROOT_CHANGED" && !externalFileCreated,
    };
  } finally {
    await rm(harness.root, { recursive: true, force: true });
    await rm(movedRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
}

async function runMutablePayloadSnapshot(modules) {
  let enteredIo;
  let releaseIo;
  const entered = new Promise((resolve) => { enteredIo = resolve; });
  const released = new Promise((resolve) => { releaseIo = resolve; });
  const harness = await freshHarness(modules, "mutable-payload", {
    beforeIo: async () => {
      enteredIo();
      await released;
    },
  });
  try {
    const callerBuffer = Buffer.from(FIXTURE_PAYLOAD);
    const originalSha256 = sha256(callerBuffer);
    const request = exactRequest(harness.envelope, callerBuffer);
    // exactRequest makes its own caller-owned Buffer. Mutate that exact Buffer
    // after redemption has copied and validated it but before filesystem I/O.
    const redemption = harness.sink.redeemAndWrite(harness.envelope, request);
    await entered;
    request.payload.fill(0x78);
    const mutatedCallerSha256 = sha256(request.payload);
    releaseIo();
    const result = await redemption;
    const written = await readFile(path.join(harness.root, FIXTURE_RELATIVE_PATH));
    return {
      originalSha256,
      mutatedCallerSha256,
      writtenSha256: sha256(written),
      receiptSha256: result.payloadSha256,
      callerMutationDidNotChangeWrite:
        mutatedCallerSha256 !== originalSha256 &&
        sha256(written) === originalSha256 &&
        result.payloadSha256 === originalSha256,
    };
  } finally {
    if (releaseIo) releaseIo();
    await rm(harness.root, { recursive: true, force: true });
  }
}

function receiptWithoutHash(receipt) {
  const { receiptPayloadSha256: _ignored, ...payload } = receipt;
  return payload;
}

export function computeSinkLabReceiptSha256(receipt) {
  return sha256(Buffer.from(canonicalJson(receiptWithoutHash(receipt)), "utf8"));
}

export function validateSinkLabReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
      receipt.schemaVersion !== "nerveloop.effect-sink-redemption-lab.v3" ||
      receipt.kind !== "source-bound-process-local-sink-redemption-experiment" ||
      receipt.officialTrack !== OFFICIAL_TRACK || receipt.scenario !== SCENARIO ||
      receipt.verdict !== "PASS") {
    throw new Error("SINK_LAB_RECEIPT_IDENTITY_INVALID");
  }
  if (!validSha256(receipt.receiptPayloadSha256) ||
      computeSinkLabReceiptSha256(receipt) !== receipt.receiptPayloadSha256) {
    throw new Error("SINK_LAB_RECEIPT_HASH_INVALID");
  }
  const {
    lattice,
    tamperMatrix,
    concurrency,
    expiry,
    symlinkFault,
    parentDerivation,
    rootReplacement,
    mutablePayload,
    capabilityLifecycle,
  } = receipt.results;
  if (lattice.totalCells !== 20 || lattice.allowed !== 6 || lattice.denied !== 14 ||
      lattice.deniedCapabilitiesIssued !== 0 || lattice.allowedCapabilitiesConsumed !== 6 ||
      lattice.sinkMintable !== 1 || lattice.broaderAllowedScopesRejectedBySink !== 5) {
    throw new Error("SINK_LAB_LATTICE_INVALID");
  }
  if (tamperMatrix.envelopeMutationCombinations !== 32_767 ||
      tamperMatrix.envelopeMutationEscapes !== 0 ||
      tamperMatrix.contextualMutationCombinations !== 63 ||
      tamperMatrix.contextualMutationEscapes !== 0 ||
      tamperMatrix.stateBeforeValid !== "dispatch_ready" ||
      tamperMatrix.finalState !== "redeemed" ||
      tamperMatrix.replayError !== "SINK_CAPABILITY_ALREADY_REDEEMED" ||
      tamperMatrix.writtenPayloadSha256 !== sha256(FIXTURE_PAYLOAD)) {
    throw new Error("SINK_LAB_TAMPER_MATRIX_INVALID");
  }
  if (concurrency.attempts !== 64 || concurrency.successes !== 1 || concurrency.rejections !== 63 ||
      concurrency.rejectionCodes.SINK_CAPABILITY_ALREADY_REDEEMED !== 63 ||
      concurrency.finalState !== "redeemed" || concurrency.writtenPayloadSha256 !== sha256(FIXTURE_PAYLOAD)) {
    throw new Error("SINK_LAB_CONCURRENCY_INVALID");
  }
  if (!expiry.exactBoundaryRejected || expiry.fileCreated ||
      !expiry.sinkExpiresNoLaterThanParent || expiry.state !== "dispatch_ready") {
    throw new Error("SINK_LAB_EXPIRY_INVALID");
  }
  if (symlinkFault.effectError !== "SINK_EFFECT_FAILED" ||
      !symlinkFault.externalSentinelUnchanged || !symlinkFault.destinationStillSymlink ||
      symlinkFault.stateAfterFault !== "failed_closed" || !symlinkFault.failStopSpentGrant) {
    throw new Error("SINK_LAB_SYMLINK_FAULT_INVALID");
  }
  if (!parentDerivation.oneParentOneChild ||
      parentDerivation.secondMintError !== "SINK_PARENT_ALREADY_DERIVED" ||
      parentDerivation.firstChildState !== "dispatch_ready") {
    throw new Error("SINK_LAB_PARENT_DERIVATION_INVALID");
  }
  if (!rootReplacement.deterministicReplacementRejected || rootReplacement.externalFileCreated ||
      rootReplacement.error !== "SINK_ROOT_CHANGED" ||
      rootReplacement.stateAfterFault !== "failed_closed" ||
      rootReplacement.retryError !== "SINK_CAPABILITY_ALREADY_REDEEMED") {
    throw new Error("SINK_LAB_ROOT_REPLACEMENT_INVALID");
  }
  if (!mutablePayload.callerMutationDidNotChangeWrite ||
      mutablePayload.originalSha256 !== sha256(FIXTURE_PAYLOAD) ||
      mutablePayload.writtenSha256 !== sha256(FIXTURE_PAYLOAD) ||
      mutablePayload.receiptSha256 !== sha256(FIXTURE_PAYLOAD)) {
    throw new Error("SINK_LAB_MUTABLE_PAYLOAD_INVALID");
  }
  if (capabilityLifecycle.traces !== 120 || capabilityLifecycle.operations !== 426 ||
      capabilityLifecycle.maximumTraceLength !== 4 || capabilityLifecycle.mismatches !== 0 ||
      capabilityLifecycle.maximumSuccessfulClaims !== 1 ||
      capabilityLifecycle.maximumSuccessfulConsumes !== 1) {
    throw new Error("SINK_LAB_CAPABILITY_LIFECYCLE_INVALID");
  }
  if (!Object.values(receipt.gates).every(Boolean)) throw new Error("SINK_LAB_GATE_INVALID");
  if (receipt.proofBoundary.externalCalls !== 0 || receipt.proofBoundary.modelCalls !== 0 ||
      receipt.proofBoundary.credentialsRead !== false || receipt.proofBoundary.productionSecurity !== false ||
      receipt.proofBoundary.hardenedSandbox !== false ||
      receipt.proofBoundary.labHarnessExecutedProductBroker !== false) {
    throw new Error("SINK_LAB_BOUNDARY_INVALID");
  }
  return receipt;
}

export async function runSinkRedemptionLab() {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const modules = await loadProductionModules();
  const lattice = await runLatticeAttenuation(modules);
  const tamperMatrix = await runCombinatorialTamperMatrix(modules);
  const concurrency = await runConcurrentRedemption(modules);
  const expiry = await runExpiryBoundary(modules);
  const symlinkFault = await runSymlinkFault(modules);
  const parentDerivation = await runSingleParentDerivation(modules);
  const rootReplacement = await runRootReplacementFault(modules);
  const mutablePayload = await runMutablePayloadSnapshot(modules);
  const capabilityLifecycle = runCapabilityLifecycleOracle(modules);
  const gates = Object.freeze({
    fullPolicyLatticeFailsClosed: lattice.totalCells === 20 && lattice.denied === 14 &&
      lattice.deniedCapabilitiesIssued === 0,
    sinkAuthorityIsAttenuated: lattice.allowedCapabilitiesConsumed === 6 &&
      lattice.sinkMintable === 1 && lattice.broaderAllowedScopesRejectedBySink === 5,
    allDeclaredEnvelopeMutationsRejected: tamperMatrix.envelopeMutationEscapes === 0,
    allDeclaredContextMutationsRejected: tamperMatrix.contextualMutationEscapes === 0,
    failedMutationsDoNotSpendValidGrant: tamperMatrix.stateBeforeValid === "dispatch_ready",
    exactEffectSucceedsOnce: tamperMatrix.finalState === "redeemed" &&
      tamperMatrix.writtenPayloadSha256 === sha256(FIXTURE_PAYLOAD) &&
      tamperMatrix.replayError === "SINK_CAPABILITY_ALREADY_REDEEMED",
    concurrentRedemptionIsAtMostOnce: concurrency.successes === 1 && concurrency.rejections === 63,
    expiryBoundaryFailsClosed: expiry.exactBoundaryRejected && !expiry.fileCreated,
    derivedLeaseDoesNotOutliveParent: expiry.sinkExpiresNoLaterThanParent,
    symlinkFaultCannotChangeExternalTarget: symlinkFault.externalSentinelUnchanged &&
      symlinkFault.destinationStillSymlink,
    sinkFaultConsumesAuthorityBeforeIo: symlinkFault.failStopSpentGrant,
    oneParentDerivesOnlyOneChild: parentDerivation.oneParentOneChild,
    deterministicRootReplacementFailsClosed: rootReplacement.deterministicReplacementRejected,
    mutableCallerPayloadIsSnapshottedBeforeAwait: mutablePayload.callerMutationDidNotChangeWrite,
    capabilityLifecycleMatchesIndependentOracle: capabilityLifecycle.mismatches === 0 &&
      capabilityLifecycle.traces === 120 && capabilityLifecycle.operations === 426,
  });
  const sourceBindings = Object.freeze({
    harness: Object.freeze({
      path: "scripts/effect-sink-redemption-lab.mjs",
      sha256: await sha256RegularFile(scriptPath),
    }),
    effectCapability: Object.freeze({
      path: "apps/server/src/effect-capability.ts",
      sha256: await sha256RegularFile(path.join(projectRoot, "apps/server/src/effect-capability.ts")),
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
  const verdict = Object.values(gates).every(Boolean) ? "PASS" : "FAIL";
  const baseReceipt = {
    schemaVersion: "nerveloop.effect-sink-redemption-lab.v3",
    kind: "source-bound-process-local-sink-redemption-experiment",
    officialTrack: OFFICIAL_TRACK,
    scenario: SCENARIO,
    capturedAtUtc: startedAt,
    completedAtUtc: new Date().toISOString(),
    durationMs: Math.round((performance.now() - started) * 1_000) / 1_000,
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    verdict,
    researchSources: RESEARCH_SOURCES,
    design:
      "Attenuate a consumed host dispatch capability into one HMAC-bound, path-bound, payload-bound, time-bound sink envelope; redeem atomically at the filesystem effect boundary before I/O.",
    results: {
      lattice,
      tamperMatrix,
      concurrency,
      expiry,
      symlinkFault,
      parentDerivation,
      rootReplacement,
      mutablePayload,
      capabilityLifecycle,
    },
    gates,
    sourceBindings,
    proofBoundary: {
      classification: "deterministic local sink-side reference-monitor prototype and adversarial experiment",
      externalCalls: 0,
      modelCalls: 0,
      credentialsRead: false,
      localFilesystemEffects: true,
      syntheticFixtureOnly: true,
      productionSecurity: false,
      hardenedSandbox: false,
      labHarnessExecutedProductBroker: false,
      durableAuthority: false,
      crossProcessAuthority: false,
      deterministicRootReplacementResistance: true,
      concurrentAncestorSwapExhausted: false,
      claimsSupported: [
        "the current host registry's six allowed lattice cells can be consumed and fourteen denied cells mint no parent capability",
        "the experimental sink narrows those six allowed cells to one exact write/workspace scope",
        "all 32767 declared envelope mutation combinations and all 63 declared request-context mutation combinations were rejected locally",
        "one of 64 concurrent exact redemptions succeeded and 63 were rejected in one Node process",
        "the exact expiry boundary and a pre-existing symlink target failed closed in the declared fixture",
        "one consumed parent derived only one child grant in the declared process-local registry",
        "a deterministic pre-redemption workspace-root replacement was rejected before filesystem I/O",
        "mutating the caller-owned payload after redemption began did not change the snapshotted bytes written",
        "all 120 bounded capability traces covering 426 operations matched the independent lifecycle oracle",
      ],
      claimsNotSupported: [
        "this isolated lab receipt by itself proves the separate cooperative AgentService-to-FixtureRunner product integration; that path has its own functional receipt and server tests",
        "arbitrary JavaScript, filesystem, symlink, hard-link, process, concurrent ancestor-swap, or race-state exhaustion",
        "authentication, durable or distributed authority, provider interception, kernel isolation, hardened sandboxing, production scale, or TikTok integration",
      ],
    },
  };
  const receipt = {
    ...baseReceipt,
    receiptPayloadSha256: sha256(Buffer.from(canonicalJson(baseReceipt), "utf8")),
  };
  if (verdict === "PASS") validateSinkLabReceipt(receipt);
  return receipt;
}

function evidenceMarkdown(receipt, resultsSha256) {
  const {
    lattice,
    tamperMatrix,
    concurrency,
    expiry,
    symlinkFault,
    parentDerivation,
    rootReplacement,
    mutablePayload,
    capabilityLifecycle,
  } = receipt.results;
  return `# Final algorithm lab: sink-side effect redemption\n\n` +
    `Official entry: **${receipt.officialTrack}**  \n` +
    `Scenario: **${receipt.scenario}**\n\n` +
    `## Outcome\n\n` +
    `This isolated experiment tests a stronger sink-side architecture: attenuate a consumed dispatch capability into a one-use envelope bound to the exact Run, Agent, action, target class, policy digest, file path, payload digest, and expiry; then spend it inside a filesystem reference monitor before I/O. The product now has a separately tested cooperative broker for its one exact \`demo-result.md\` fixture effect; this lab remains an independent adversarial oracle rather than the integration proof.\n\n` +
    `| Check | Exact local result |\n` +
    `| --- | ---: |\n` +
    `| Production policy lattice | ${lattice.allowed} allowed / ${lattice.denied} denied; ${lattice.deniedCapabilitiesIssued} capabilities issued for denied cells |\n` +
    `| Sink attenuation | ${lattice.sinkMintable} exact sink scope accepted / ${lattice.broaderAllowedScopesRejectedBySink} other allowed scopes rejected |\n` +
    `| HMAC envelope mutation combinations | ${tamperMatrix.envelopeMutationsRejected}/${tamperMatrix.envelopeMutationCombinations} rejected; ${tamperMatrix.envelopeMutationEscapes} escapes |\n` +
    `| Request-context mutation combinations | ${tamperMatrix.contextualMutationsRejected}/${tamperMatrix.contextualMutationCombinations} rejected; ${tamperMatrix.contextualMutationEscapes} escapes |\n` +
    `| Exact concurrent redemptions | ${concurrency.successes}/${concurrency.attempts} succeeded; ${concurrency.rejections} rejected |\n` +
    `| Exact expiry boundary | ${expiry.error}; file created: ${expiry.fileCreated} |\n` +
    `| Pre-existing symlink fault | ${symlinkFault.effectError}; external sentinel unchanged: ${symlinkFault.externalSentinelUnchanged}; grant fail-stopped: ${symlinkFault.failStopSpentGrant} |\n` +
    `| Parent attenuation | second child: ${parentDerivation.secondMintError}; one parent/one child: ${parentDerivation.oneParentOneChild} |\n` +
    `| Workspace-root replacement | ${rootReplacement.error}; external file created: ${rootReplacement.externalFileCreated} |\n` +
    `| Mutable payload after validation | snapshotted bytes preserved: ${mutablePayload.callerMutationDidNotChangeWrite} |\n\n` +
    `| Capability lifecycle oracle | ${capabilityLifecycle.traces} traces / ${capabilityLifecycle.operations} operations; ${capabilityLifecycle.mismatches} mismatches |\n\n` +
    `Verdict: **${receipt.verdict}** in ${receipt.durationMs.toFixed(3)} ms on ${receipt.runtime.platform}/${receipt.runtime.architecture}.\n\n` +
    `## Research to design\n\n` +
    receipt.researchSources.map((source) =>
      `- [${source.title}](${source.url}): ${source.designUse} ${source.nonClaim}`).join("\n") +
    `\n\n## Honest boundary\n\n` +
    `This is a deterministic, local, synthetic reference-monitor prototype. The lab harness does **not execute the product broker**; the separate functional receipt and server tests cover the cooperative \`AgentService -> FixtureRunner -> demo-result.md\` path. The product still leaves ambient Node filesystem authority available to fixture code, so RunGuard remains the rollback backstop. Node's path-based APIs do not close every concurrent ancestor-swap race. This is not authentication, durable/distributed authority, arbitrary race exhaustion, a hardened sandbox, provider interception, production evidence, TikTok integration, or judge acceptance. A production design would need mediation at every real effect sink plus removal of raw sink access from workers.\n\n` +
    `## Reproduce\n\n` +
    `\`\`\`sh\nnode --test scripts/effect-sink-redemption-lab.test.mjs\nnode scripts/effect-sink-redemption-lab.mjs --write-evidence --json\n\`\`\`\n\n` +
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

async function writeEvidence(receipt, outputDirectory) {
  const resultsPath = path.join(outputDirectory, "results.json");
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  const resultsSha256 = sha256(Buffer.from(serialized, "utf8"));
  await atomicWrite(resultsPath, serialized);
  await atomicWrite(path.join(outputDirectory, "README.md"), evidenceMarkdown(receipt, resultsSha256));
  return { outputDirectory, resultsPath, resultsSha256 };
}

export function parseSinkLabArguments(argv) {
  const options = { writeEvidence: false, jsonOnly: false, outputDirectory: defaultEvidenceDirectory };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write-evidence") options.writeEvidence = true;
    else if (argument === "--json") options.jsonOnly = true;
    else if (argument === "--output-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--output-dir_REQUIRES_VALUE");
      options.outputDirectory = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`UNKNOWN_ARGUMENT:${argument}`);
    }
  }
  return options;
}

async function main() {
  const options = parseSinkLabArguments(process.argv.slice(2));
  const receipt = await runSinkRedemptionLab();
  const evidence = options.writeEvidence
    ? await writeEvidence(receipt, options.outputDirectory)
    : null;
  if (options.jsonOnly) {
    process.stdout.write(`${JSON.stringify({ receipt, evidence }, null, 2)}\n`);
  } else {
    const totalAdversarial = receipt.results.tamperMatrix.envelopeMutationCombinations +
      receipt.results.tamperMatrix.contextualMutationCombinations;
    process.stdout.write(
      `Sink redemption ${receipt.verdict}: ${totalAdversarial}/${totalAdversarial} declared mutation combinations rejected; ` +
      `${receipt.results.concurrency.successes}/${receipt.results.concurrency.attempts} concurrent redemptions succeeded.\n`,
    );
    if (evidence) process.stdout.write(`Evidence: ${evidence.outputDirectory}\n`);
  }
  if (receipt.verdict !== "PASS") process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
