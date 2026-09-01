import {createHash} from "node:crypto";
import {routingSha256} from "./run-router.js";

const SHA256 = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const INTENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_LIFECYCLE_PAYLOAD_BYTES = 8_000_000;
const DIGEST_BOUNDARY =
  "Canonical SHA-256 trusted-store integrity digest; not a signature or authenticity proof." as const;
const PROOF_BOUNDARY =
  "Local workspace-byte accounting only; not filesystem quota, complete containment, or production capacity proof." as const;

type JsonObject = {[key: string]: unknown};

export class WorkspaceResourceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WorkspaceResourceError";
  }
}

export interface WorkspaceResourcePolicyInput {
  version: 1;
  policyId: string;
  runtimeInstanceId: string;
  maxRetainedBytes: number;
  maxGrowthPerRunBytes: number;
}

export interface WorkspaceResourcePolicy extends WorkspaceResourcePolicyInput {
  policySha256: string;
}

export type WorkspaceInventoryKind = "active" | "archived" | "quarantine";

export interface WorkspaceInventoryMeasurement {
  inventoryId: string;
  agentId: string;
  kind: WorkspaceInventoryKind;
  bytes: number;
  inventorySha256: string;
}

export interface WorkspaceInventorySnapshot {
  version: 1;
  complete: boolean;
  inventories: readonly WorkspaceInventoryMeasurement[];
}

export interface WorkspaceGrowthReservation {
  runId: string;
  agentId: string;
  inventoryId: string;
  maxGrowthBytes: number;
  status: "reserved" | "dispatched" | "reconciliation_required" | "cancelled" | "settled";
  settledSnapshotSha256: string | null;
  reservedAt: string;
  updatedAt: string;
}

export interface WorkspaceLifecycleAgentSnapshot {
  version: 1;
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: "ready" | "stopped" | "error";
  codexThreadId: string | null;
  lastError: string | null;
  recoveryHold: {
    runId: string | null;
    reason: "rollback_failed" | "interrupted_run" | "routing_reconciliation";
    since: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceLifecyclePayloadFile {
  relativePath: string;
  mode: number;
  utf8: string;
  sha256: string;
}

export interface WorkspaceLifecycleIntent {
  version: 1;
  intentId: string;
  kind: "create" | "instruction_update" | "archive";
  status: "prepared" | "reconciliation_required";
  agentId: string;
  runtimeInstanceId: string;
  policySha256: string;
  expectedAgentBeforeSha256: string | null;
  candidateAgent: Readonly<WorkspaceLifecycleAgentSnapshot> | null;
  candidateAgentSha256: string | null;
  sourceRelative: string | null;
  stageRelative: string | null;
  destinationRelative: string;
  beforeInventory: Readonly<WorkspaceInventoryMeasurement> | null;
  reservedStagingBytes: number;
  payload: readonly Readonly<WorkspaceLifecyclePayloadFile>[];
  payloadManifestSha256: string;
  createdAt: string;
  updatedAt: string;
  intentSha256: string;
}

export interface PrepareWorkspaceLifecycleIntentInput {
  intentId: string;
  kind: WorkspaceLifecycleIntent["kind"];
  agentId: string;
  expectedAgentBeforeSha256: string | null;
  candidateAgent: WorkspaceLifecycleAgentSnapshot | null;
  sourceRelative: string | null;
  stageRelative: string | null;
  destinationRelative: string;
  beforeInventory: WorkspaceInventoryMeasurement | null;
  reservedStagingBytes: number;
  payload: readonly WorkspaceLifecyclePayloadFile[];
}

export interface WorkspaceResourceState {
  version: 1;
  policy: Readonly<WorkspaceResourcePolicy>;
  inventories: readonly Readonly<WorkspaceInventoryMeasurement>[];
  reservations: readonly Readonly<WorkspaceGrowthReservation>[];
  lifecycleIntents: readonly Readonly<WorkspaceLifecycleIntent>[];
  totals: Readonly<{
    retainedBytes: string;
    reservedGrowthBytes: string;
    lifecycleReservedBytes: string;
    availableBytes: string;
    overageBytes: string;
  }>;
  reconciliationRequired: boolean;
  createdAt: string;
  updatedAt: string;
  digestBoundary: typeof DIGEST_BOUNDARY;
  proofBoundary: typeof PROOF_BOUNDARY;
  sha256: string;
}

function fail(code: string): never {
  throw new WorkspaceResourceError(code);
}

function object(value: unknown, code = "WORKSPACE_RESOURCE_SCHEMA_INVALID"): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  return value as JsonObject;
}

function exact(value: JsonObject, keys: readonly string[], code = "WORKSPACE_RESOURCE_SCHEMA_INVALID"): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
}

function literal<T extends string | number | boolean>(
  value: unknown, expected: T, code = "WORKSPACE_RESOURCE_SCHEMA_INVALID",
): T {
  if (value !== expected) fail(code);
  return expected;
}

function name(value: unknown, code = "WORKSPACE_RESOURCE_SCHEMA_INVALID"): string {
  if (typeof value !== "string" || !NAME.test(value)) fail(code);
  return value;
}

function sha(value: unknown, code = "WORKSPACE_RESOURCE_SCHEMA_INVALID"): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function integer(value: unknown, minimum = 0, code = "WORKSPACE_RESOURCE_SCHEMA_INVALID"): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(code);
  return value as number;
}

function decimal(value: unknown, code = "WORKSPACE_RESOURCE_SCHEMA_INVALID"): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) fail(code);
  return value;
}

function timestamp(value: unknown, code = "WORKSPACE_RESOURCE_TIME_INVALID"): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail(code);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail(code);
  return value;
}

function boundedText(value: unknown, maxBytes: number, code: string, allowEmpty = true): string {
  if (typeof value !== "string" || value.includes("\0") ||
      (!allowEmpty && value.length === 0) || Buffer.byteLength(value, "utf8") > maxBytes) fail(code);
  return value;
}

function nullableBoundedText(value: unknown, maxBytes: number, code: string): string | null {
  return value === null ? null : boundedText(value, maxBytes, code);
}

function relativePath(value: unknown, code = "WORKSPACE_RESOURCE_RELATIVE_PATH_INVALID"): string {
  const candidate = boundedText(value, 512, code, false);
  if (candidate.startsWith("/") || candidate.startsWith("\\") || candidate.includes("\\") ||
      /^[A-Za-z]:/.test(candidate) || candidate.split("/").some(segment => segment === "" || segment === "." || segment === "..")) {
    fail(code);
  }
  return candidate;
}

function nullableRelativePath(value: unknown): string | null {
  return value === null ? null : relativePath(value);
}

function parseRecoveryHold(raw: unknown): WorkspaceLifecycleAgentSnapshot["recoveryHold"] {
  if (raw === null) return null;
  const value = object(raw, "WORKSPACE_RESOURCE_AGENT_SNAPSHOT_INVALID");
  exact(value, ["runId", "reason", "since"], "WORKSPACE_RESOURCE_AGENT_SNAPSHOT_INVALID");
  const reason = value.reason;
  if (reason !== "rollback_failed" && reason !== "interrupted_run" &&
      reason !== "routing_reconciliation") fail("WORKSPACE_RESOURCE_AGENT_SNAPSHOT_INVALID");
  return immutable({
    runId: value.runId === null ? null : name(value.runId, "WORKSPACE_RESOURCE_AGENT_SNAPSHOT_INVALID"),
    reason,
    since: timestamp(value.since, "WORKSPACE_RESOURCE_AGENT_SNAPSHOT_INVALID"),
  });
}

export function workspaceLifecycleAgentSnapshot(agentLike: unknown): WorkspaceLifecycleAgentSnapshot {
  const value = object(agentLike, "WORKSPACE_RESOURCE_AGENT_SNAPSHOT_INVALID");
  const status = value.status;
  if (status !== "ready" && status !== "stopped" && status !== "error") {
    fail("WORKSPACE_RESOURCE_AGENT_SNAPSHOT_INVALID");
  }
  const createdAt = timestamp(value.createdAt, "WORKSPACE_RESOURCE_AGENT_SNAPSHOT_INVALID");
  const updatedAt = timestamp(value.updatedAt, "WORKSPACE_RESOURCE_AGENT_SNAPSHOT_INVALID");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) fail("WORKSPACE_RESOURCE_AGENT_SNAPSHOT_INVALID");
  return immutable({
    version: 1,
    id: name(value.id, "WORKSPACE_RESOURCE_AGENT_SNAPSHOT_INVALID"),
    name: boundedText(value.name, 320, "WORKSPACE_RESOURCE_AGENT_SNAPSHOT_INVALID", false),
    description: boundedText(value.description, 2_000, "WORKSPACE_RESOURCE_AGENT_SNAPSHOT_INVALID"),
    instructions: boundedText(value.instructions, 40_000, "WORKSPACE_RESOURCE_AGENT_SNAPSHOT_INVALID"),
    status,
    codexThreadId: nullableBoundedText(value.codexThreadId, 512, "WORKSPACE_RESOURCE_AGENT_SNAPSHOT_INVALID"),
    lastError: nullableBoundedText(value.lastError, 16_000, "WORKSPACE_RESOURCE_AGENT_SNAPSHOT_INVALID"),
    recoveryHold: parseRecoveryHold(value.recoveryHold),
    createdAt,
    updatedAt,
  });
}

export function workspaceLifecycleAgentSha256(agentLike: unknown): string {
  return routingSha256(workspaceLifecycleAgentSnapshot(agentLike));
}

function parseExactAgentSnapshot(raw: unknown): WorkspaceLifecycleAgentSnapshot {
  const value = object(raw, "WORKSPACE_RESOURCE_AGENT_SNAPSHOT_INVALID");
  exact(value, ["version", "id", "name", "description", "instructions", "status", "codexThreadId",
    "lastError", "recoveryHold", "createdAt", "updatedAt"], "WORKSPACE_RESOURCE_AGENT_SNAPSHOT_INVALID");
  literal(value.version, 1, "WORKSPACE_RESOURCE_AGENT_SNAPSHOT_INVALID");
  return workspaceLifecycleAgentSnapshot(value);
}

function payloadFileSha256(utf8: string): string {
  return createHash("sha256").update(Buffer.from(utf8, "utf8")).digest("hex");
}

function parsePayloadFile(raw: unknown): WorkspaceLifecyclePayloadFile {
  const value = object(raw, "WORKSPACE_RESOURCE_PAYLOAD_INVALID");
  exact(value, ["relativePath", "mode", "utf8", "sha256"], "WORKSPACE_RESOURCE_PAYLOAD_INVALID");
  const utf8 = boundedText(value.utf8, 1_000_000, "WORKSPACE_RESOURCE_PAYLOAD_INVALID");
  const storedSha = sha(value.sha256, "WORKSPACE_RESOURCE_PAYLOAD_INVALID");
  if (payloadFileSha256(utf8) !== storedSha) fail("WORKSPACE_RESOURCE_PAYLOAD_DIGEST_INVALID");
  const mode = integer(value.mode, 0, "WORKSPACE_RESOURCE_PAYLOAD_INVALID");
  if (mode > 0o777) fail("WORKSPACE_RESOURCE_PAYLOAD_INVALID");
  return immutable({relativePath: relativePath(value.relativePath), mode, utf8, sha256: storedSha});
}

function parsePayload(raw: unknown, requireCanonicalOrder: boolean): readonly WorkspaceLifecyclePayloadFile[] {
  if (!Array.isArray(raw)) fail("WORKSPACE_RESOURCE_PAYLOAD_INVALID");
  const payload = raw.map(parsePayloadFile);
  if (payload.reduce((sum, item) => sum + Buffer.byteLength(item.utf8, "utf8"), 0) >
      MAX_LIFECYCLE_PAYLOAD_BYTES) fail("WORKSPACE_RESOURCE_PAYLOAD_INVALID");
  const sorted = [...payload].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (sorted.some((item, index) => index > 0 && sorted[index - 1]!.relativePath === item.relativePath)) {
    fail("WORKSPACE_RESOURCE_PAYLOAD_PATH_DUPLICATE");
  }
  if (requireCanonicalOrder && sorted.some((item, index) => item.relativePath !== payload[index]!.relativePath)) {
    fail("WORKSPACE_RESOURCE_PAYLOAD_ORDER_INVALID");
  }
  return immutable(sorted);
}

function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as object)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

export function parseWorkspaceResourcePolicy(raw: unknown): WorkspaceResourcePolicy {
  const value = object(raw, "WORKSPACE_RESOURCE_POLICY_INVALID");
  const hasDigest = "policySha256" in value;
  exact(value, hasDigest
    ? ["version", "policyId", "runtimeInstanceId", "maxRetainedBytes", "maxGrowthPerRunBytes", "policySha256"]
    : ["version", "policyId", "runtimeInstanceId", "maxRetainedBytes", "maxGrowthPerRunBytes"],
  "WORKSPACE_RESOURCE_POLICY_SCHEMA_INVALID");
  literal(value.version, 1, "WORKSPACE_RESOURCE_POLICY_VERSION_UNKNOWN");
  const body: WorkspaceResourcePolicyInput = {
    version: 1,
    policyId: name(value.policyId, "WORKSPACE_RESOURCE_POLICY_ID_INVALID"),
    runtimeInstanceId: name(value.runtimeInstanceId, "WORKSPACE_RESOURCE_RUNTIME_ID_INVALID"),
    maxRetainedBytes: integer(value.maxRetainedBytes, 1, "WORKSPACE_RESOURCE_POLICY_LIMIT_INVALID"),
    maxGrowthPerRunBytes: integer(value.maxGrowthPerRunBytes, 1, "WORKSPACE_RESOURCE_POLICY_GROWTH_INVALID"),
  };
  if (body.maxGrowthPerRunBytes > body.maxRetainedBytes) fail("WORKSPACE_RESOURCE_POLICY_GROWTH_INVALID");
  const policySha256 = routingSha256(body);
  if (hasDigest && sha(value.policySha256, "WORKSPACE_RESOURCE_POLICY_DIGEST_INVALID") !== policySha256) {
    fail("WORKSPACE_RESOURCE_POLICY_DIGEST_INVALID");
  }
  return immutable({...body, policySha256});
}

function parseMeasurement(raw: unknown): WorkspaceInventoryMeasurement {
  const value = object(raw);
  exact(value, ["inventoryId", "agentId", "kind", "bytes", "inventorySha256"]);
  const kind = value.kind;
  if (kind !== "active" && kind !== "archived" && kind !== "quarantine") fail("WORKSPACE_RESOURCE_KIND_INVALID");
  return immutable({
    inventoryId: name(value.inventoryId),
    agentId: name(value.agentId),
    kind,
    bytes: integer(value.bytes),
    inventorySha256: sha(value.inventorySha256),
  });
}

function parseSnapshot(raw: unknown): WorkspaceInventorySnapshot {
  const value = object(raw, "WORKSPACE_RESOURCE_SNAPSHOT_INVALID");
  exact(value, ["version", "complete", "inventories"], "WORKSPACE_RESOURCE_SNAPSHOT_INVALID");
  literal(value.version, 1, "WORKSPACE_RESOURCE_SNAPSHOT_VERSION_UNKNOWN");
  if (typeof value.complete !== "boolean" || !Array.isArray(value.inventories)) {
    fail("WORKSPACE_RESOURCE_SNAPSHOT_INVALID");
  }
  const inventories = value.inventories.map(parseMeasurement)
    .sort((left, right) => left.inventoryId.localeCompare(right.inventoryId));
  const ids = inventories.map(item => item.inventoryId);
  if (new Set(ids).size !== ids.length) fail("WORKSPACE_RESOURCE_INVENTORY_DUPLICATE");
  const activeAgents = inventories.filter(item => item.kind === "active").map(item => item.agentId);
  if (new Set(activeAgents).size !== activeAgents.length) fail("WORKSPACE_RESOURCE_ACTIVE_AGENT_DUPLICATE");
  return immutable({version: 1, complete: value.complete, inventories});
}

function measurementSha256(measurement: WorkspaceInventoryMeasurement): string {
  return routingSha256(measurement);
}

function parseLifecycleIntent(
  raw: unknown, policy: WorkspaceResourcePolicy,
): WorkspaceLifecycleIntent {
  const value = object(raw, "WORKSPACE_RESOURCE_INTENT_INVALID");
  exact(value, ["version", "intentId", "kind", "status", "agentId", "runtimeInstanceId",
    "policySha256", "expectedAgentBeforeSha256", "candidateAgent", "candidateAgentSha256",
    "sourceRelative", "stageRelative", "destinationRelative", "beforeInventory",
    "reservedStagingBytes", "payload", "payloadManifestSha256", "createdAt", "updatedAt",
    "intentSha256"], "WORKSPACE_RESOURCE_INTENT_INVALID");
  const storedIntentSha = sha(value.intentSha256, "WORKSPACE_RESOURCE_INTENT_DIGEST_INVALID");
  const {intentSha256: _ignored, ...unsealed} = value;
  if (routingSha256(unsealed) !== storedIntentSha) fail("WORKSPACE_RESOURCE_INTENT_DIGEST_INVALID");
  literal(value.version, 1, "WORKSPACE_RESOURCE_INTENT_VERSION_UNKNOWN");
  const kind = value.kind;
  if (kind !== "create" && kind !== "instruction_update" && kind !== "archive") {
    fail("WORKSPACE_RESOURCE_INTENT_KIND_INVALID");
  }
  const status = value.status;
  if (status !== "prepared" && status !== "reconciliation_required") {
    fail("WORKSPACE_RESOURCE_INTENT_STATUS_INVALID");
  }
  const intentId = boundedText(value.intentId, 128, "WORKSPACE_RESOURCE_INTENT_ID_INVALID", false);
  if (!INTENT_ID.test(intentId)) fail("WORKSPACE_RESOURCE_INTENT_ID_INVALID");
  const agentId = name(value.agentId, "WORKSPACE_RESOURCE_INTENT_AGENT_INVALID");
  const runtimeInstanceId = name(value.runtimeInstanceId, "WORKSPACE_RESOURCE_INTENT_BINDING_INVALID");
  const policySha256 = sha(value.policySha256, "WORKSPACE_RESOURCE_INTENT_BINDING_INVALID");
  if (runtimeInstanceId !== policy.runtimeInstanceId || policySha256 !== policy.policySha256) {
    fail("WORKSPACE_RESOURCE_INTENT_BINDING_INVALID");
  }
  const expectedAgentBeforeSha256 = value.expectedAgentBeforeSha256 === null ? null
    : sha(value.expectedAgentBeforeSha256, "WORKSPACE_RESOURCE_INTENT_BINDING_INVALID");
  const candidateAgent = value.candidateAgent === null ? null : parseExactAgentSnapshot(value.candidateAgent);
  if (candidateAgent && candidateAgent.id !== agentId) fail("WORKSPACE_RESOURCE_INTENT_BINDING_INVALID");
  const candidateAgentSha256 = value.candidateAgentSha256 === null ? null
    : sha(value.candidateAgentSha256, "WORKSPACE_RESOURCE_INTENT_BINDING_INVALID");
  if ((candidateAgent === null) !== (candidateAgentSha256 === null) ||
      (candidateAgent && routingSha256(candidateAgent) !== candidateAgentSha256)) {
    fail("WORKSPACE_RESOURCE_INTENT_BINDING_INVALID");
  }
  const sourceRelative = nullableRelativePath(value.sourceRelative);
  const stageRelative = nullableRelativePath(value.stageRelative);
  const destinationRelative = relativePath(value.destinationRelative);
  if ((kind !== "instruction_update" && sourceRelative === destinationRelative) ||
      stageRelative === destinationRelative ||
      (sourceRelative !== null && sourceRelative === stageRelative)) {
    fail("WORKSPACE_RESOURCE_INTENT_PATH_CONFLICT");
  }
  const beforeInventory = value.beforeInventory === null ? null : parseMeasurement(value.beforeInventory);
  if (beforeInventory && (beforeInventory.kind !== "active" || beforeInventory.agentId !== agentId)) {
    fail("WORKSPACE_RESOURCE_INTENT_BINDING_INVALID");
  }
  const reservedStagingBytes = integer(value.reservedStagingBytes, 0,
    "WORKSPACE_RESOURCE_INTENT_RESERVATION_INVALID");
  const payload = parsePayload(value.payload, true);
  const payloadBytes = payload.reduce((sum, item) => sum + Buffer.byteLength(item.utf8, "utf8"), 0);
  if (payloadBytes !== reservedStagingBytes) fail("WORKSPACE_RESOURCE_INTENT_RESERVATION_INVALID");
  const payloadManifestSha256 = sha(value.payloadManifestSha256,
    "WORKSPACE_RESOURCE_PAYLOAD_MANIFEST_INVALID");
  if (routingSha256(payload) !== payloadManifestSha256) {
    fail("WORKSPACE_RESOURCE_PAYLOAD_MANIFEST_INVALID");
  }
  const createdAt = timestamp(value.createdAt), updatedAt = timestamp(value.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) fail("WORKSPACE_RESOURCE_TIME_INVALID");
  if (kind === "create") {
    if (expectedAgentBeforeSha256 !== null || candidateAgent === null || sourceRelative !== null ||
        stageRelative === null || beforeInventory !== null) fail("WORKSPACE_RESOURCE_INTENT_BINDING_INVALID");
  } else if (kind === "instruction_update") {
    if (expectedAgentBeforeSha256 === null || candidateAgent === null || sourceRelative === null ||
        stageRelative === null || beforeInventory === null) fail("WORKSPACE_RESOURCE_INTENT_BINDING_INVALID");
  } else if (expectedAgentBeforeSha256 === null || candidateAgent !== null || sourceRelative === null ||
      stageRelative !== null || beforeInventory === null || payload.length !== 0 || reservedStagingBytes !== 0) {
    fail("WORKSPACE_RESOURCE_INTENT_BINDING_INVALID");
  }
  return immutable({version: 1, intentId, kind, status, agentId, runtimeInstanceId, policySha256,
    expectedAgentBeforeSha256, candidateAgent, candidateAgentSha256, sourceRelative, stageRelative,
    destinationRelative, beforeInventory, reservedStagingBytes, payload, payloadManifestSha256,
    createdAt, updatedAt, intentSha256: storedIntentSha});
}

function parseReservation(raw: unknown): WorkspaceGrowthReservation {
  const value = object(raw);
  exact(value, ["runId", "agentId", "inventoryId", "maxGrowthBytes", "status",
    "settledSnapshotSha256", "reservedAt", "updatedAt"]);
  const status = value.status;
  if (status !== "reserved" && status !== "dispatched" &&
      status !== "reconciliation_required" && status !== "cancelled" && status !== "settled") {
    fail("WORKSPACE_RESOURCE_RESERVATION_STATUS_INVALID");
  }
  const settledSnapshotSha256 = value.settledSnapshotSha256 === null
    ? null : sha(value.settledSnapshotSha256);
  if ((status === "settled") !== (settledSnapshotSha256 !== null)) {
    fail("WORKSPACE_RESOURCE_RESERVATION_CONTRADICTORY");
  }
  const reservedAt = timestamp(value.reservedAt), updatedAt = timestamp(value.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(reservedAt)) fail("WORKSPACE_RESOURCE_TIME_INVALID");
  return immutable({
    runId: name(value.runId),
    agentId: name(value.agentId),
    inventoryId: name(value.inventoryId),
    maxGrowthBytes: integer(value.maxGrowthBytes, 1),
    status,
    settledSnapshotSha256,
    reservedAt,
    updatedAt,
  });
}

function totals(
  inventories: readonly WorkspaceInventoryMeasurement[],
  reservations: readonly WorkspaceGrowthReservation[],
  lifecycleIntents: readonly WorkspaceLifecycleIntent[],
  limit: number,
): WorkspaceResourceState["totals"] {
  let retained = 0n;
  let reserved = 0n;
  let lifecycleReserved = 0n;
  for (const inventory of inventories) retained += BigInt(inventory.bytes);
  for (const reservation of reservations) {
    if (reservation.status === "reserved" || reservation.status === "dispatched" ||
        reservation.status === "reconciliation_required") {
      reserved += BigInt(reservation.maxGrowthBytes);
    }
  }
  for (const intent of lifecycleIntents) lifecycleReserved += BigInt(intent.reservedStagingBytes);
  const cap = BigInt(limit);
  const committed = retained + reserved + lifecycleReserved;
  return immutable({
    retainedBytes: retained.toString(),
    reservedGrowthBytes: reserved.toString(),
    lifecycleReservedBytes: lifecycleReserved.toString(),
    availableBytes: (committed < cap ? cap - committed : 0n).toString(),
    overageBytes: (retained > cap ? retained - cap : 0n).toString(),
  });
}

function withoutSha(state: WorkspaceResourceState): Omit<WorkspaceResourceState, "sha256"> {
  const {sha256: _ignored, ...body} = state;
  return body;
}

function seal(body: Omit<WorkspaceResourceState, "sha256">): WorkspaceResourceState {
  return immutable({...body, sha256: routingSha256(body)});
}

function operationTime(raw: string, state: WorkspaceResourceState): string {
  const at = timestamp(raw);
  if (Date.parse(at) < Date.parse(state.updatedAt)) fail("WORKSPACE_RESOURCE_TIME_INVALID");
  return at;
}

function nextState(
  state: WorkspaceResourceState,
  inventories: readonly WorkspaceInventoryMeasurement[],
  reservations: readonly WorkspaceGrowthReservation[],
  reconciliationRequired: boolean,
  updatedAt: string,
  lifecycleIntents: readonly WorkspaceLifecycleIntent[] = state.lifecycleIntents,
): WorkspaceResourceState {
  const orderedInventories = [...inventories].sort((a, b) => a.inventoryId.localeCompare(b.inventoryId));
  const orderedReservations = [...reservations].sort((a, b) => a.runId.localeCompare(b.runId));
  const orderedIntents = [...lifecycleIntents].sort((a, b) => a.intentId.localeCompare(b.intentId));
  return seal({...withoutSha(state), inventories: orderedInventories, reservations: orderedReservations,
    lifecycleIntents: orderedIntents,
    totals: totals(orderedInventories, orderedReservations, orderedIntents, state.policy.maxRetainedBytes),
    reconciliationRequired, updatedAt});
}

export function parseWorkspaceResourceState(raw: unknown): WorkspaceResourceState {
  const value = object(raw);
  const hasLifecycleIntents = Object.prototype.hasOwnProperty.call(value, "lifecycleIntents");
  const storedTotals = object(value.totals);
  const hasLifecycleTotal = Object.prototype.hasOwnProperty.call(storedTotals, "lifecycleReservedBytes");
  if (hasLifecycleIntents !== hasLifecycleTotal) fail("WORKSPACE_RESOURCE_SCHEMA_INVALID");
  exact(value, hasLifecycleIntents
    ? ["version", "policy", "inventories", "reservations", "lifecycleIntents", "totals",
      "reconciliationRequired", "createdAt", "updatedAt", "digestBoundary", "proofBoundary", "sha256"]
    : ["version", "policy", "inventories", "reservations", "totals", "reconciliationRequired",
      "createdAt", "updatedAt", "digestBoundary", "proofBoundary", "sha256"]);
  const storedSha = sha(value.sha256, "WORKSPACE_RESOURCE_DIGEST_INVALID");
  const {sha256: _ignored, ...unsealed} = value;
  // A legacy state's original digest is verified before the new empty intent
  // ledger and zero lifecycle reservation are introduced and resealed.
  if (routingSha256(unsealed) !== storedSha) fail("WORKSPACE_RESOURCE_DIGEST_INVALID");
  literal(value.version, 1, "WORKSPACE_RESOURCE_VERSION_UNKNOWN");
  const policy = parseWorkspaceResourcePolicy(value.policy);
  if (!Array.isArray(value.inventories) || !Array.isArray(value.reservations) ||
      typeof value.reconciliationRequired !== "boolean") fail("WORKSPACE_RESOURCE_SCHEMA_INVALID");
  const inventories = value.inventories.map(parseMeasurement);
  const reservations = value.reservations.map(parseReservation);
  const lifecycleIntents = hasLifecycleIntents
    ? Array.isArray(value.lifecycleIntents)
      ? value.lifecycleIntents.map(item => parseLifecycleIntent(item, policy))
      : fail("WORKSPACE_RESOURCE_SCHEMA_INVALID")
    : [];
  if (inventories.some((item, index) => index > 0 && inventories[index - 1]!.inventoryId >= item.inventoryId) ||
      new Set(inventories.map(item => item.inventoryId)).size !== inventories.length) {
    fail("WORKSPACE_RESOURCE_INVENTORY_ORDER_INVALID");
  }
  if (reservations.some((item, index) => index > 0 && reservations[index - 1]!.runId >= item.runId) ||
      new Set(reservations.map(item => item.runId)).size !== reservations.length) {
    fail("WORKSPACE_RESOURCE_RESERVATION_ORDER_INVALID");
  }
  if (lifecycleIntents.some((item, index) =>
      index > 0 && lifecycleIntents[index - 1]!.intentId >= item.intentId) ||
      new Set(lifecycleIntents.map(item => item.intentId)).size !== lifecycleIntents.length) {
    fail("WORKSPACE_RESOURCE_INTENT_ORDER_INVALID");
  }
  if (new Set(lifecycleIntents.map(item => item.agentId)).size !== lifecycleIntents.length) {
    fail("WORKSPACE_RESOURCE_AGENT_INTENT_DUPLICATE");
  }
  const activeByAgent = new Map(inventories.filter(item => item.kind === "active")
    .map(item => [item.agentId, item.inventoryId]));
  if (activeByAgent.size !== inventories.filter(item => item.kind === "active").length ||
      reservations.some(item => (item.status === "reserved" || item.status === "dispatched" ||
        item.status === "reconciliation_required") &&
        activeByAgent.get(item.agentId) !== item.inventoryId)) {
    fail("WORKSPACE_RESOURCE_RESERVATION_REBOUND");
  }
  if (reservations.some(item => item.status === "reconciliation_required") &&
      value.reconciliationRequired !== true) {
    fail("WORKSPACE_RESOURCE_RECONCILIATION_CONTRADICTORY");
  }
  if (lifecycleIntents.some(item => item.status === "reconciliation_required") &&
      value.reconciliationRequired !== true) {
    fail("WORKSPACE_RESOURCE_RECONCILIATION_CONTRADICTORY");
  }
  const expectedTotals = totals(inventories, reservations, lifecycleIntents, policy.maxRetainedBytes);
  const totalKeys = hasLifecycleTotal
    ? ["retainedBytes", "reservedGrowthBytes", "lifecycleReservedBytes", "availableBytes", "overageBytes"] as const
    : ["retainedBytes", "reservedGrowthBytes", "availableBytes", "overageBytes"] as const;
  exact(storedTotals, totalKeys);
  for (const key of totalKeys) {
    if (decimal(storedTotals[key]) !== expectedTotals[key]) fail("WORKSPACE_RESOURCE_TOTALS_CONTRADICTORY");
  }
  const createdAt = timestamp(value.createdAt), updatedAt = timestamp(value.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt) || reservations.some(item =>
    Date.parse(item.reservedAt) < Date.parse(createdAt) || Date.parse(item.updatedAt) > Date.parse(updatedAt)) ||
      lifecycleIntents.some(item => Date.parse(item.createdAt) < Date.parse(createdAt) ||
        Date.parse(item.updatedAt) > Date.parse(updatedAt))) {
    fail("WORKSPACE_RESOURCE_TIME_INVALID");
  }
  literal(value.digestBoundary, DIGEST_BOUNDARY);
  literal(value.proofBoundary, PROOF_BOUNDARY);
  const body = {version: 1 as const, policy, inventories, reservations, lifecycleIntents,
    totals: expectedTotals,
    reconciliationRequired: value.reconciliationRequired, createdAt, updatedAt,
    digestBoundary: DIGEST_BOUNDARY, proofBoundary: PROOF_BOUNDARY};
  return hasLifecycleIntents ? immutable({...body, sha256: storedSha}) : seal(body);
}

export function createWorkspaceResourceState(
  rawPolicy: unknown, rawSnapshot: unknown, createdAt: string,
): WorkspaceResourceState {
  const policy = parseWorkspaceResourcePolicy(rawPolicy);
  const snapshot = parseSnapshot(rawSnapshot);
  const at = timestamp(createdAt);
  return seal({version: 1, policy, inventories: snapshot.inventories, reservations: [], lifecycleIntents: [],
    totals: totals(snapshot.inventories, [], [], policy.maxRetainedBytes),
    reconciliationRequired: !snapshot.complete, createdAt: at, updatedAt: at,
    digestBoundary: DIGEST_BOUNDARY, proofBoundary: PROOF_BOUNDARY});
}

function assertOpen(state: WorkspaceResourceState): void {
  if (state.reconciliationRequired) fail("WORKSPACE_RESOURCE_RECONCILIATION_REQUIRED");
}

export function admitWorkspace(
  rawState: unknown, rawMeasurement: unknown, admittedAt: string,
): WorkspaceResourceState {
  const state = parseWorkspaceResourceState(rawState);
  assertOpen(state);
  const measurement = parseMeasurement(rawMeasurement);
  if (measurement.kind !== "active") fail("WORKSPACE_RESOURCE_ACTIVE_REQUIRED");
  const existing = state.inventories.find(item => item.inventoryId === measurement.inventoryId);
  if (existing) {
    if (measurementSha256(existing) === measurementSha256(measurement)) return state;
    fail("WORKSPACE_RESOURCE_INVENTORY_CONFLICT");
  }
  if (state.inventories.some(item => item.kind === "active" && item.agentId === measurement.agentId)) {
    fail("WORKSPACE_RESOURCE_ACTIVE_AGENT_DUPLICATE");
  }
  if (state.lifecycleIntents.some(item => item.agentId === measurement.agentId)) {
    fail("WORKSPACE_RESOURCE_ACTIVE_LIFECYCLE_INTENT");
  }
  if (BigInt(measurement.bytes) > BigInt(state.totals.availableBytes)) {
    fail("WORKSPACE_RESOURCE_INSUFFICIENT_AVAILABLE");
  }
  const at = operationTime(admittedAt, state);
  return nextState(state, [...state.inventories, measurement], state.reservations, false, at);
}

function intentRequestSha256(intent: WorkspaceLifecycleIntent): string {
  return routingSha256({
    intentId: intent.intentId,
    kind: intent.kind,
    agentId: intent.agentId,
    expectedAgentBeforeSha256: intent.expectedAgentBeforeSha256,
    candidateAgent: intent.candidateAgent,
    sourceRelative: intent.sourceRelative,
    stageRelative: intent.stageRelative,
    destinationRelative: intent.destinationRelative,
    beforeInventory: intent.beforeInventory,
    reservedStagingBytes: intent.reservedStagingBytes,
    payload: intent.payload,
  });
}

export function prepareWorkspaceLifecycleIntent(
  rawState: unknown, rawInput: PrepareWorkspaceLifecycleIntentInput, preparedAt: string,
): WorkspaceResourceState {
  const state = parseWorkspaceResourceState(rawState);
  assertOpen(state);
  const input = object(rawInput, "WORKSPACE_RESOURCE_INTENT_INVALID");
  exact(input, ["intentId", "kind", "agentId", "expectedAgentBeforeSha256", "candidateAgent",
    "sourceRelative", "stageRelative", "destinationRelative", "beforeInventory",
    "reservedStagingBytes", "payload"], "WORKSPACE_RESOURCE_INTENT_INVALID");
  const at = operationTime(preparedAt, state);
  const payload = parsePayload(input.payload, false);
  const candidateAgent = input.candidateAgent === null ? null : parseExactAgentSnapshot(input.candidateAgent);
  const body = {
    version: 1 as const,
    intentId: input.intentId,
    kind: input.kind,
    status: "prepared" as const,
    agentId: input.agentId,
    runtimeInstanceId: state.policy.runtimeInstanceId,
    policySha256: state.policy.policySha256,
    expectedAgentBeforeSha256: input.expectedAgentBeforeSha256,
    candidateAgent,
    candidateAgentSha256: candidateAgent ? routingSha256(candidateAgent) : null,
    sourceRelative: input.sourceRelative,
    stageRelative: input.stageRelative,
    destinationRelative: input.destinationRelative,
    beforeInventory: input.beforeInventory,
    reservedStagingBytes: input.reservedStagingBytes,
    payload,
    payloadManifestSha256: routingSha256(payload),
    createdAt: at,
    updatedAt: at,
  };
  const intent = parseLifecycleIntent({...body, intentSha256: routingSha256(body)}, state.policy);
  const existingById = state.lifecycleIntents.find(item => item.intentId === intent.intentId);
  if (existingById) {
    if (existingById.status === "prepared" &&
        intentRequestSha256(existingById) === intentRequestSha256(intent)) return state;
    fail("WORKSPACE_RESOURCE_INTENT_CONFLICT");
  }
  if (state.lifecycleIntents.some(item => item.agentId === intent.agentId)) {
    fail("WORKSPACE_RESOURCE_AGENT_INTENT_DUPLICATE");
  }
  const active = state.inventories.find(item => item.kind === "active" && item.agentId === intent.agentId);
  if (intent.kind === "create") {
    if (active) fail("WORKSPACE_RESOURCE_ACTIVE_AGENT_DUPLICATE");
  } else if (!active || !intent.beforeInventory ||
      measurementSha256(active) !== measurementSha256(intent.beforeInventory)) {
    fail("WORKSPACE_RESOURCE_INTENT_INVENTORY_CONFLICT");
  }
  if (state.reservations.some(item => item.agentId === intent.agentId &&
      (item.status === "reserved" || item.status === "dispatched" ||
        item.status === "reconciliation_required"))) {
    fail("WORKSPACE_RESOURCE_ACTIVE_RESERVATION");
  }
  if (BigInt(intent.reservedStagingBytes) > BigInt(state.totals.availableBytes)) {
    fail("WORKSPACE_RESOURCE_INSUFFICIENT_AVAILABLE");
  }
  return nextState(state, state.inventories, state.reservations, false, at,
    [...state.lifecycleIntents, intent]);
}

function boundLifecycleIntent(
  state: WorkspaceResourceState,
  rawInput: {intentId: string; agentId: string; intentSha256?: string},
  kind?: WorkspaceLifecycleIntent["kind"],
): WorkspaceLifecycleIntent {
  const intentId = boundedText(rawInput?.intentId, 128, "WORKSPACE_RESOURCE_INTENT_ID_INVALID", false);
  if (!INTENT_ID.test(intentId)) fail("WORKSPACE_RESOURCE_INTENT_ID_INVALID");
  const agentId = name(rawInput?.agentId, "WORKSPACE_RESOURCE_INTENT_AGENT_INVALID");
  const intent = state.lifecycleIntents.find(item => item.intentId === intentId);
  if (!intent || intent.agentId !== agentId || (kind !== undefined && intent.kind !== kind)) {
    fail("WORKSPACE_RESOURCE_INTENT_BINDING_INVALID");
  }
  if (rawInput.intentSha256 !== undefined &&
      intent.intentSha256 !== sha(rawInput.intentSha256, "WORKSPACE_RESOURCE_INTENT_DIGEST_INVALID")) {
    fail("WORKSPACE_RESOURCE_INTENT_CHANGED");
  }
  return intent;
}

function resealLifecycleIntentStatus(
  intent: WorkspaceLifecycleIntent,
  status: WorkspaceLifecycleIntent["status"],
  updatedAt: string,
): WorkspaceLifecycleIntent {
  const body = {...intent, status, updatedAt};
  const {intentSha256: _ignored, ...unsealed} = body;
  return immutable({...unsealed, intentSha256: routingSha256(unsealed)});
}

export function markWorkspaceLifecycleIntentReconciliation(
  rawState: unknown, rawInput: {intentId: string; agentId: string}, markedAt: string,
): WorkspaceResourceState {
  const state = parseWorkspaceResourceState(rawState);
  const intent = boundLifecycleIntent(state, rawInput);
  if (intent.status === "reconciliation_required") return state;
  if (intent.status !== "prepared") fail("WORKSPACE_RESOURCE_INTENT_STATUS_INVALID");
  const at = operationTime(markedAt, state);
  const marked = resealLifecycleIntentStatus(intent, "reconciliation_required", at);
  const intents = state.lifecycleIntents.map(item => item.intentId === intent.intentId ? marked : item);
  return nextState(state, state.inventories, state.reservations, true, at, intents);
}

/**
 * Reopens only the exact digest-sealed reconciliation intent selected by an
 * authenticated operator. The global hold stays closed until a fresh complete
 * inventory scan proves the whole ledger exact again.
 */
export function reopenWorkspaceLifecycleIntent(
  rawState: unknown,
  rawInput: {intentId: string; agentId: string; intentSha256: string},
  reopenedAt: string,
): WorkspaceResourceState {
  const state = parseWorkspaceResourceState(rawState);
  const intent = boundLifecycleIntent(state, rawInput);
  if (intent.status !== "reconciliation_required") {
    fail("WORKSPACE_RESOURCE_INTENT_STATUS_INVALID");
  }
  const at = operationTime(reopenedAt, state);
  const reopened = resealLifecycleIntentStatus(intent, "prepared", at);
  const intents = state.lifecycleIntents.map(item => item.intentId === intent.intentId ? reopened : item);
  return nextState(state, state.inventories, state.reservations, true, at, intents);
}

/**
 * Cancels only an operator-selected intent after the service has independently
 * proved the filesystem is still at exact-before. This pure transition does
 * not authorize cleanup and deliberately preserves the global hold.
 */
export function cancelWorkspaceLifecycleIntent(
  rawState: unknown,
  rawInput: {intentId: string; agentId: string; intentSha256: string},
  cancelledAt: string,
): WorkspaceResourceState {
  const state = parseWorkspaceResourceState(rawState);
  const intent = boundLifecycleIntent(state, rawInput);
  if (intent.status !== "reconciliation_required") {
    fail("WORKSPACE_RESOURCE_INTENT_STATUS_INVALID");
  }
  const at = operationTime(cancelledAt, state);
  return nextState(state, state.inventories, state.reservations, true, at,
    withoutLifecycleIntent(state, intent));
}

function assertPreparedCompletion(
  state: WorkspaceResourceState,
  input: {intentId: string; agentId: string},
  kind: WorkspaceLifecycleIntent["kind"],
): WorkspaceLifecycleIntent {
  const intent = boundLifecycleIntent(state, input, kind);
  if (intent.status !== "prepared") fail("WORKSPACE_RESOURCE_INTENT_STATUS_INVALID");
  return intent;
}

function withoutLifecycleIntent(
  state: WorkspaceResourceState, intent: WorkspaceLifecycleIntent,
): WorkspaceLifecycleIntent[] {
  return state.lifecycleIntents.filter(item => item.intentId !== intent.intentId);
}

function completionFits(
  state: WorkspaceResourceState, intent: WorkspaceLifecycleIntent, positiveRetainedDelta: bigint,
): void {
  const releasedHeadroom = BigInt(state.totals.availableBytes) + BigInt(intent.reservedStagingBytes);
  if (positiveRetainedDelta > releasedHeadroom) fail("WORKSPACE_RESOURCE_INSUFFICIENT_AVAILABLE");
}

export function completeWorkspaceLifecycleCreate(
  rawState: unknown,
  rawInput: {intentId: string; agentId: string; measurement: WorkspaceInventoryMeasurement},
  completedAt: string,
): WorkspaceResourceState {
  const state = parseWorkspaceResourceState(rawState);
  const intent = assertPreparedCompletion(state, rawInput, "create");
  const measurement = parseMeasurement(rawInput?.measurement);
  if (measurement.kind !== "active" || measurement.agentId !== intent.agentId ||
      state.inventories.some(item => item.inventoryId === measurement.inventoryId ||
        (item.kind === "active" && item.agentId === intent.agentId))) {
    fail("WORKSPACE_RESOURCE_INTENT_COMPLETION_MISMATCH");
  }
  completionFits(state, intent, BigInt(measurement.bytes));
  const at = operationTime(completedAt, state);
  return nextState(state, [...state.inventories, measurement], state.reservations,
    state.reconciliationRequired, at,
    withoutLifecycleIntent(state, intent));
}

export function completeWorkspaceLifecycleUpdate(
  rawState: unknown,
  rawInput: {intentId: string; agentId: string; measurement: WorkspaceInventoryMeasurement},
  completedAt: string,
): WorkspaceResourceState {
  const state = parseWorkspaceResourceState(rawState);
  const intent = assertPreparedCompletion(state, rawInput, "instruction_update");
  const measurement = parseMeasurement(rawInput?.measurement);
  const active = state.inventories.find(item => item.kind === "active" && item.agentId === intent.agentId);
  if (!active || !intent.beforeInventory || measurement.kind !== "active" ||
      measurement.agentId !== intent.agentId || measurement.inventoryId !== active.inventoryId ||
      measurementSha256(active) !== measurementSha256(intent.beforeInventory)) {
    fail("WORKSPACE_RESOURCE_INTENT_COMPLETION_MISMATCH");
  }
  const delta = BigInt(measurement.bytes) - BigInt(active.bytes);
  completionFits(state, intent, delta > 0n ? delta : 0n);
  const at = operationTime(completedAt, state);
  const inventories = state.inventories.map(item => item.inventoryId === active.inventoryId ? measurement : item);
  return nextState(state, inventories, state.reservations, state.reconciliationRequired, at,
    withoutLifecycleIntent(state, intent));
}

export function completeWorkspaceLifecycleArchive(
  rawState: unknown,
  rawInput: {intentId: string; agentId: string; measurement: WorkspaceInventoryMeasurement},
  completedAt: string,
): WorkspaceResourceState {
  const state = parseWorkspaceResourceState(rawState);
  const intent = assertPreparedCompletion(state, rawInput, "archive");
  const measurement = parseMeasurement(rawInput?.measurement);
  const active = state.inventories.find(item => item.kind === "active" && item.agentId === intent.agentId);
  if (!active || !intent.beforeInventory || measurement.kind !== "archived" ||
      measurement.agentId !== intent.agentId ||
      measurementSha256(active) !== measurementSha256(intent.beforeInventory) ||
      measurement.bytes !== active.bytes || measurement.inventorySha256 !== active.inventorySha256 ||
      state.inventories.some(item => item.inventoryId === measurement.inventoryId && item !== active)) {
    fail("WORKSPACE_RESOURCE_INTENT_COMPLETION_MISMATCH");
  }
  const at = operationTime(completedAt, state);
  const inventories = [...state.inventories.filter(item => item.inventoryId !== active.inventoryId), measurement];
  return nextState(state, inventories, state.reservations, state.reconciliationRequired, at,
    withoutLifecycleIntent(state, intent));
}

export function reserveWorkspaceGrowth(
  rawState: unknown,
  rawInput: {runId: string; agentId: string; maxGrowthBytes: number},
  reservedAt: string,
): WorkspaceResourceState {
  const state = parseWorkspaceResourceState(rawState);
  assertOpen(state);
  const runId = name(rawInput?.runId), agentId = name(rawInput?.agentId);
  const maxGrowthBytes = integer(rawInput?.maxGrowthBytes, 1);
  if (maxGrowthBytes > state.policy.maxGrowthPerRunBytes) fail("WORKSPACE_RESOURCE_GROWTH_LIMIT_EXCEEDED");
  const active = state.inventories.find(item => item.kind === "active" && item.agentId === agentId);
  if (!active) fail("WORKSPACE_RESOURCE_ACTIVE_INVENTORY_MISSING");
  if (state.lifecycleIntents.some(item => item.agentId === agentId)) {
    fail("WORKSPACE_RESOURCE_ACTIVE_LIFECYCLE_INTENT");
  }
  const existing = state.reservations.find(item => item.runId === runId);
  if (existing) {
    if (existing.agentId === agentId && existing.inventoryId === active.inventoryId &&
        existing.maxGrowthBytes === maxGrowthBytes && existing.status === "reserved") return state;
    fail("WORKSPACE_RESOURCE_RUN_REBOUND");
  }
  if (BigInt(maxGrowthBytes) > BigInt(state.totals.availableBytes)) {
    fail("WORKSPACE_RESOURCE_INSUFFICIENT_AVAILABLE");
  }
  const at = operationTime(reservedAt, state);
  const reservation: WorkspaceGrowthReservation = immutable({runId, agentId,
    inventoryId: active.inventoryId, maxGrowthBytes, status: "reserved",
    settledSnapshotSha256: null, reservedAt: at, updatedAt: at});
  return nextState(state, state.inventories, [...state.reservations, reservation], false, at);
}

export function dispatchWorkspaceGrowth(
  rawState: unknown, rawInput: {runId: string; agentId: string}, dispatchedAt: string,
): WorkspaceResourceState {
  const state = parseWorkspaceResourceState(rawState);
  const runId = name(rawInput?.runId), agentId = name(rawInput?.agentId);
  const reservation = state.reservations.find(item => item.runId === runId);
  if (!reservation || reservation.agentId !== agentId) fail("WORKSPACE_RESOURCE_RUN_REBOUND");
  if (reservation.status === "dispatched") return state;
  if (reservation.status !== "reserved") fail("WORKSPACE_RESOURCE_TERMINAL_CONFLICT");
  const at = operationTime(dispatchedAt, state);
  const reservations = state.reservations.map(item => item.runId === runId
    ? immutable({...item, status: "dispatched" as const, updatedAt: at}) : item);
  return nextState(state, state.inventories, reservations, state.reconciliationRequired, at);
}

export function settleWorkspaceGrowth(
  rawState: unknown,
  rawInput: {runId: string; agentId: string; snapshot: WorkspaceInventorySnapshot},
  settledAt: string,
): WorkspaceResourceState {
  const state = parseWorkspaceResourceState(rawState);
  const runId = name(rawInput?.runId), agentId = name(rawInput?.agentId);
  const snapshot = parseSnapshot(rawInput?.snapshot);
  if (!snapshot.complete) fail("WORKSPACE_RESOURCE_SETTLEMENT_INCOMPLETE");
  const reservation = state.reservations.find(item => item.runId === runId);
  if (!reservation || reservation.agentId !== agentId) {
    fail("WORKSPACE_RESOURCE_RUN_REBOUND");
  }
  const active = snapshot.inventories.find(item => item.kind === "active" && item.agentId === agentId);
  if (!active || active.inventoryId !== reservation.inventoryId) fail("WORKSPACE_RESOURCE_RUN_REBOUND");
  const settledDigest = routingSha256(snapshot);
  if (reservation.status === "settled") {
    if (reservation.settledSnapshotSha256 === settledDigest) return state;
    fail("WORKSPACE_RESOURCE_TERMINAL_CONFLICT");
  }
  if (reservation.status !== "dispatched") fail("WORKSPACE_RESOURCE_TERMINAL_CONFLICT");
  const storedById = new Map(state.inventories.map(item => [item.inventoryId, item]));
  const observedById = new Map(snapshot.inventories.map(item => [item.inventoryId, item]));
  for (const stored of state.inventories) {
    const observed = observedById.get(stored.inventoryId);
    if (!observed) fail("WORKSPACE_RESOURCE_SETTLEMENT_INVENTORY_CONFLICT");
    if (stored.inventoryId === reservation.inventoryId) {
      if (observed.kind !== "active" || observed.agentId !== agentId) {
        fail("WORKSPACE_RESOURCE_RUN_REBOUND");
      }
    } else if (measurementSha256(stored) !== measurementSha256(observed)) {
      fail("WORKSPACE_RESOURCE_SETTLEMENT_INVENTORY_CONFLICT");
    }
  }
  for (const observed of snapshot.inventories) {
    if (!storedById.has(observed.inventoryId) &&
        (observed.agentId !== agentId || observed.kind !== "quarantine")) {
      fail("WORKSPACE_RESOURCE_SETTLEMENT_INVENTORY_CONFLICT");
    }
  }
  const at = operationTime(settledAt, state);
  const reservations = state.reservations.map(item => item.runId === runId
    ? immutable({...item, status: "settled" as const,
      settledSnapshotSha256: settledDigest, updatedAt: at}) : item);
  return nextState(state, snapshot.inventories, reservations, state.reconciliationRequired, at);
}

export function cancelWorkspaceGrowth(
  rawState: unknown, rawInput: {runId: string; agentId: string}, cancelledAt: string,
): WorkspaceResourceState {
  const state = parseWorkspaceResourceState(rawState);
  const runId = name(rawInput?.runId), agentId = name(rawInput?.agentId);
  const reservation = state.reservations.find(item => item.runId === runId);
  if (!reservation || reservation.agentId !== agentId) fail("WORKSPACE_RESOURCE_RUN_REBOUND");
  if (reservation.status === "cancelled") return state;
  if (reservation.status !== "reserved") fail("WORKSPACE_RESOURCE_TERMINAL_CONFLICT");
  const at = operationTime(cancelledAt, state);
  const reservations = state.reservations.map(item => item.runId === runId
    ? immutable({...item, status: "cancelled" as const, updatedAt: at}) : item);
  return nextState(state, state.inventories, reservations, state.reconciliationRequired, at);
}

export function recoverWorkspaceReservations(
  rawState: unknown, recoveredAt: string,
): WorkspaceResourceState {
  const state = parseWorkspaceResourceState(rawState);
  const hasTransition = state.reservations.some(item =>
    item.status === "reserved" || item.status === "dispatched");
  if (!hasTransition) return state;
  const at = operationTime(recoveredAt, state);
  let uncertainDispatch = false;
  const reservations = state.reservations.map(item => {
    if (item.status === "reserved") {
      return immutable({...item, status: "cancelled" as const, updatedAt: at});
    }
    if (item.status === "dispatched") {
      uncertainDispatch = true;
      return immutable({...item, status: "reconciliation_required" as const, updatedAt: at});
    }
    return item;
  });
  return nextState(state, state.inventories, reservations,
    state.reconciliationRequired || uncertainDispatch, at);
}

export function updateWorkspaceInventory(
  rawState: unknown, rawMeasurement: unknown, updatedAt: string,
): WorkspaceResourceState {
  const state = parseWorkspaceResourceState(rawState);
  const measurement = parseMeasurement(rawMeasurement);
  if (measurement.kind !== "active") fail("WORKSPACE_RESOURCE_ACTIVE_REQUIRED");
  const existing = state.inventories.find(item => item.inventoryId === measurement.inventoryId);
  if (!existing || existing.kind !== "active" || existing.agentId !== measurement.agentId) {
    fail("WORKSPACE_RESOURCE_INVENTORY_CONFLICT");
  }
  if (measurementSha256(existing) === measurementSha256(measurement)) return state;
  assertOpen(state);
  if (state.reservations.some(item => item.agentId === measurement.agentId &&
      (item.status === "reserved" || item.status === "dispatched" ||
        item.status === "reconciliation_required"))) {
    fail("WORKSPACE_RESOURCE_ACTIVE_RESERVATION");
  }
  if (state.lifecycleIntents.some(item => item.agentId === measurement.agentId)) {
    fail("WORKSPACE_RESOURCE_ACTIVE_LIFECYCLE_INTENT");
  }
  const growth = BigInt(measurement.bytes) - BigInt(existing.bytes);
  if (growth > BigInt(state.totals.availableBytes)) {
    fail("WORKSPACE_RESOURCE_INSUFFICIENT_AVAILABLE");
  }
  const at = operationTime(updatedAt, state);
  const inventories = state.inventories.map(item =>
    item.inventoryId === measurement.inventoryId ? measurement : item);
  return nextState(state, inventories, state.reservations, false, at);
}

export function archiveWorkspace(
  rawState: unknown,
  rawInput: {agentId: string; inventoryId: string; archiveInventoryId: string;
    measurement: WorkspaceInventoryMeasurement},
  archivedAt: string,
): WorkspaceResourceState {
  const state = parseWorkspaceResourceState(rawState);
  assertOpen(state);
  const agentId = name(rawInput?.agentId), inventoryId = name(rawInput?.inventoryId);
  const archiveInventoryId = name(rawInput?.archiveInventoryId);
  const measurement = parseMeasurement(rawInput?.measurement);
  if (measurement.kind !== "archived" || measurement.agentId !== agentId ||
      measurement.inventoryId !== archiveInventoryId) fail("WORKSPACE_RESOURCE_ARCHIVE_INVALID");
  const replay = state.inventories.find(item => item.inventoryId === archiveInventoryId);
  if (replay) {
    if (measurementSha256(replay) === measurementSha256(measurement)) return state;
    fail("WORKSPACE_RESOURCE_ARCHIVE_CONFLICT");
  }
  const active = state.inventories.find(item => item.inventoryId === inventoryId);
  if (!active || active.kind !== "active" || active.agentId !== agentId ||
      active.bytes !== measurement.bytes) {
    fail("WORKSPACE_RESOURCE_ARCHIVE_INVALID");
  }
  if (state.reservations.some(item => item.agentId === agentId &&
      (item.status === "reserved" || item.status === "dispatched" ||
        item.status === "reconciliation_required"))) {
    fail("WORKSPACE_RESOURCE_ACTIVE_RESERVATION");
  }
  if (state.lifecycleIntents.some(item => item.agentId === agentId)) {
    fail("WORKSPACE_RESOURCE_ACTIVE_LIFECYCLE_INTENT");
  }
  const at = operationTime(archivedAt, state);
  return nextState(state,
    [...state.inventories.filter(item => item.inventoryId !== inventoryId), measurement],
    state.reservations, false, at);
}

export function reconcileWorkspaceInventory(
  rawState: unknown, rawSnapshot: unknown, reconciledAt: string,
): WorkspaceResourceState {
  const state = parseWorkspaceResourceState(rawState);
  const snapshot = parseSnapshot(rawSnapshot);
  const at = operationTime(reconciledAt, state);
  if (!snapshot.complete) {
    return nextState(state, state.inventories, state.reservations, true, at);
  }
  const storedInventoryDigest = routingSha256(state.inventories);
  const observedInventoryDigest = routingSha256(snapshot.inventories);
  if (storedInventoryDigest !== observedInventoryDigest) {
    // A complete scan that disagrees with the durable ledger is valuable
    // evidence, but not authority to erase retained bytes or adopt an unknown
    // workspace. Preserve the last trusted inventory and require an explicit
    // reconciliation workflow before admitting new persistent growth.
    return nextState(state, state.inventories, state.reservations, true, at);
  }
  const activeByAgent = new Map(snapshot.inventories.filter(item => item.kind === "active")
    .map(item => [item.agentId, item.inventoryId]));
  if (state.reservations.some(item =>
      (item.status === "reserved" || item.status === "dispatched" ||
        item.status === "reconciliation_required") &&
      activeByAgent.get(item.agentId) !== item.inventoryId)) {
    return nextState(state, state.inventories, state.reservations, true, at);
  }
  return nextState(state, snapshot.inventories, state.reservations,
    state.reservations.some(item => item.status === "reconciliation_required") ||
      state.lifecycleIntents.some(item => item.status === "reconciliation_required"), at);
}
