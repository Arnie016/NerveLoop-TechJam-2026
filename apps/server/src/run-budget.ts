import {
  parseRunRoutingReceipt, routingSha256,
  type RunRouteReceipt, type RunRoutingReceipt,
} from "./run-router.js";

const SHA256 = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST_BOUNDARY = "Canonical SHA-256 trusted-store integrity digest; not a signature or authenticity proof." as const;
const PROOF_BOUNDARY = "Synthetic admission accounting only; not provider prices, invoices, billing, or model-quality proof." as const;

type JsonObject = {[key: string]: unknown};

export class RunBudgetError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RunBudgetError";
  }
}

export interface RunBudgetPolicy {
  version: 1;
  policyId: string;
  validFrom: string;
  expiresAt: string;
  maxReservedAggregateMicrounits: number;
  costUnit: "synthetic-microunit";
  policySha256: string;
}

export type RunBudgetEntryStatus = "reserved" | "dispatched" | "settled"
  | "reconciliation_required" | "cancelled" | "denied";

export interface RunBudgetAppliedEvent {
  operation: "reserve" | "settle";
  routingReceiptSha256: string;
}

export interface RunBudgetEntry {
  runId: string;
  agentId: string;
  routingIdentitySha256: string;
  reservationReceipt: RunRouteReceipt | null;
  currentReceipt: RunRoutingReceipt;
  status: RunBudgetEntryStatus;
  initialReservationMicrounits: number;
  retainedMinimumMicrounits: number;
  appliedEvents: readonly Readonly<RunBudgetAppliedEvent>[];
  createdAt: string;
  updatedAt: string;
}

export interface RunBudgetState {
  version: 1;
  policy: Readonly<RunBudgetPolicy>;
  entries: readonly Readonly<RunBudgetEntry>[];
  totals: Readonly<{
    retainedMinimumMicrounits: string;
    availableForNewReservationsMicrounits: string;
    overageMicrounits: string;
  }>;
  createdAt: string;
  updatedAt: string;
  digestBoundary: typeof DIGEST_BOUNDARY;
  proofBoundary: typeof PROOF_BOUNDARY;
  sha256: string;
}

function fail(code: string): never {
  throw new RunBudgetError(code);
}

function object(value: unknown, code = "RUN_BUDGET_SCHEMA_INVALID"): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  return value as JsonObject;
}

function exact(value: JsonObject, keys: readonly string[], code = "RUN_BUDGET_SCHEMA_INVALID"): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
}

function literal<T extends string | number>(value: unknown, expected: T, code = "RUN_BUDGET_SCHEMA_INVALID"): T {
  if (value !== expected) fail(code);
  return expected;
}

function name(value: unknown, code = "RUN_BUDGET_SCHEMA_INVALID"): string {
  if (typeof value !== "string" || !NAME.test(value)) fail(code);
  return value;
}

function sha(value: unknown, code = "RUN_BUDGET_SCHEMA_INVALID"): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function integer(value: unknown, minimum = 0, code = "RUN_BUDGET_SCHEMA_INVALID"): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(code);
  return value as number;
}

function timestamp(value: unknown, code = "RUN_BUDGET_SCHEMA_INVALID"): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail(code);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail(code);
  return value;
}

function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as object)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function decimal(value: unknown, code = "RUN_BUDGET_SCHEMA_INVALID"): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) fail(code);
  return value;
}

function policyBody(policy: RunBudgetPolicy): Omit<RunBudgetPolicy, "policySha256"> {
  const {policySha256: _ignored, ...body} = policy;
  return body;
}

/** Parse, normalize, digest, and freeze a host-owned exact-schema synthetic budget policy. */
export function parseRunBudgetPolicy(raw: unknown): RunBudgetPolicy {
  const value = object(raw, "RUN_BUDGET_POLICY_INVALID");
  exact(value, ["version", "policyId", "validFrom", "expiresAt", "maxReservedAggregateMicrounits", "costUnit"],
    "RUN_BUDGET_POLICY_SCHEMA_INVALID");
  literal(value.version, 1, "RUN_BUDGET_POLICY_VERSION_UNKNOWN");
  literal(value.costUnit, "synthetic-microunit", "RUN_BUDGET_COST_UNIT_UNKNOWN");
  const validFrom = timestamp(value.validFrom, "RUN_BUDGET_POLICY_TIME_INVALID");
  const expiresAt = timestamp(value.expiresAt, "RUN_BUDGET_POLICY_TIME_INVALID");
  if (Date.parse(expiresAt) <= Date.parse(validFrom)) fail("RUN_BUDGET_POLICY_WINDOW_INVALID");
  const body = {version: 1 as const, policyId: name(value.policyId, "RUN_BUDGET_POLICY_ID_INVALID"),
    validFrom, expiresAt,
    maxReservedAggregateMicrounits: integer(value.maxReservedAggregateMicrounits, 1, "RUN_BUDGET_POLICY_LIMIT_INVALID"),
    costUnit: "synthetic-microunit" as const};
  return immutable({...body, policySha256: routingSha256(body)});
}

function parseStoredPolicy(raw: unknown): RunBudgetPolicy {
  const value = object(raw);
  exact(value, ["version", "policyId", "validFrom", "expiresAt", "maxReservedAggregateMicrounits", "costUnit", "policySha256"]);
  const policy = parseRunBudgetPolicy({version: value.version, policyId: value.policyId,
    validFrom: value.validFrom, expiresAt: value.expiresAt,
    maxReservedAggregateMicrounits: value.maxReservedAggregateMicrounits, costUnit: value.costUnit});
  if (sha(value.policySha256) !== policy.policySha256) fail("RUN_BUDGET_POLICY_DIGEST_INVALID");
  return policy;
}

function routingIdentity(receipt: RunRoutingReceipt): string {
  if (receipt.status === "denied") {
    return routingSha256({kind: "denied", binding: receipt.binding, catalog: receipt.catalog,
      decidedAt: receipt.decidedAt});
  }
  return routingSha256({kind: "selected", binding: receipt.binding, catalog: receipt.catalog,
    requirements: receipt.requirements, selection: receipt.selection, reservation: receipt.reservation,
    maxAttempts: receipt.maxAttempts, decidedAt: receipt.decidedAt});
}

function expectedAccounting(receipt: RunRoutingReceipt, operation: "reserve" | "settle"):
  {status: RunBudgetEntryStatus; initial: number; retained: number} {
  if (operation === "reserve") {
    if (receipt.status === "denied" || receipt.status !== "reserved" || receipt.attemptsUsed !== 0) {
      fail("RUN_BUDGET_RESERVATION_RECEIPT_INVALID");
    }
    return {status: "reserved", initial: receipt.reservation.reservedCostMicrounits,
      retained: receipt.reservation.reservedCostMicrounits};
  }
  if (receipt.status === "denied") return {status: "denied", initial: 0, retained: 0};
  if (receipt.status === "reserved") return {status: "cancelled", initial: receipt.reservation.reservedCostMicrounits, retained: 0};
  if (receipt.status === "dispatched") return {status: "dispatched", initial: receipt.reservation.reservedCostMicrounits,
    retained: receipt.reservation.reservedCostMicrounits};
  if (!receipt.settlement) fail("RUN_BUDGET_ROUTING_SETTLEMENT_INVALID");
  return {status: receipt.status, initial: receipt.reservation.reservedCostMicrounits,
    retained: receipt.settlement.retainedMinimumCostMicrounits};
}

function parseEvent(raw: unknown): RunBudgetAppliedEvent {
  const value = object(raw);
  exact(value, ["operation", "routingReceiptSha256"]);
  if (value.operation !== "reserve" && value.operation !== "settle") fail("RUN_BUDGET_SCHEMA_INVALID");
  return {operation: value.operation, routingReceiptSha256: sha(value.routingReceiptSha256)};
}

function parseEntry(raw: unknown): RunBudgetEntry {
  const value = object(raw);
  exact(value, ["runId", "agentId", "routingIdentitySha256", "reservationReceipt", "currentReceipt", "status",
    "initialReservationMicrounits", "retainedMinimumMicrounits", "appliedEvents", "createdAt", "updatedAt"]);
  const currentReceipt = parseRunRoutingReceipt(value.currentReceipt);
  const reservationReceipt = value.reservationReceipt === null ? null : parseRunRoutingReceipt(value.reservationReceipt);
  if (reservationReceipt?.status === "denied" || (reservationReceipt && reservationReceipt.status !== "reserved")) {
    fail("RUN_BUDGET_ENTRY_CONTRADICTORY");
  }
  const runId = name(value.runId), agentId = name(value.agentId);
  if (currentReceipt.binding.runId !== runId || currentReceipt.binding.agentId !== agentId ||
      (reservationReceipt && (reservationReceipt.binding.runId !== runId || reservationReceipt.binding.agentId !== agentId))) {
    fail("RUN_BUDGET_ENTRY_REBOUND");
  }
  const identity = routingIdentity(currentReceipt);
  if (sha(value.routingIdentitySha256) !== identity ||
      (reservationReceipt && routingIdentity(reservationReceipt) !== identity)) fail("RUN_BUDGET_ENTRY_REBOUND");
  const status = value.status;
  if (status !== "reserved" && status !== "dispatched" && status !== "settled" &&
      status !== "reconciliation_required" && status !== "cancelled" && status !== "denied") {
    fail("RUN_BUDGET_SCHEMA_INVALID");
  }
  const initial = integer(value.initialReservationMicrounits);
  const retained = integer(value.retainedMinimumMicrounits);
  const expected = expectedAccounting(currentReceipt, status === "reserved" ? "reserve" : "settle");
  if (expected.status !== status || expected.initial !== initial || expected.retained !== retained) {
    fail("RUN_BUDGET_ENTRY_CONTRADICTORY");
  }
  if ((status === "denied") !== (reservationReceipt === null)) fail("RUN_BUDGET_ENTRY_CONTRADICTORY");
  if (!Array.isArray(value.appliedEvents) || value.appliedEvents.length < 1 || value.appliedEvents.length > 3) {
    fail("RUN_BUDGET_ENTRY_EVENTS_INVALID");
  }
  const appliedEvents = value.appliedEvents.map(parseEvent);
  const eventKeys = appliedEvents.map(event => `${event.operation}:${event.routingReceiptSha256}`);
  if (new Set(eventKeys).size !== eventKeys.length ||
      !appliedEvents.some(event => event.routingReceiptSha256 === currentReceipt.receiptSha256) ||
      (reservationReceipt && !appliedEvents.some(event => event.operation === "reserve" &&
        event.routingReceiptSha256 === reservationReceipt.receiptSha256))) fail("RUN_BUDGET_ENTRY_EVENTS_INVALID");
  const first = appliedEvents[0]!, last = appliedEvents[appliedEvents.length - 1]!;
  if (reservationReceipt) {
    if (first.operation !== "reserve" || first.routingReceiptSha256 !== reservationReceipt.receiptSha256 ||
        (status === "reserved" && appliedEvents.length !== 1) ||
        (status !== "reserved" && (appliedEvents.length < 2 || last.operation !== "settle" ||
          last.routingReceiptSha256 !== currentReceipt.receiptSha256)) ||
        appliedEvents.slice(1).some(event => event.operation !== "settle")) {
      fail("RUN_BUDGET_ENTRY_EVENTS_INVALID");
    }
  } else if (appliedEvents.length !== 1 || first.operation !== "settle" ||
      first.routingReceiptSha256 !== currentReceipt.receiptSha256) {
    fail("RUN_BUDGET_ENTRY_EVENTS_INVALID");
  }
  const createdAt = timestamp(value.createdAt), updatedAt = timestamp(value.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) fail("RUN_BUDGET_ENTRY_TIME_INVALID");
  return immutable({runId, agentId, routingIdentitySha256: identity,
    reservationReceipt: reservationReceipt as RunRouteReceipt | null, currentReceipt, status, initialReservationMicrounits: initial,
    retainedMinimumMicrounits: retained, appliedEvents, createdAt, updatedAt});
}

function totals(entries: readonly RunBudgetEntry[], limit: number): RunBudgetState["totals"] {
  let retained = 0n;
  for (const entry of entries) retained += BigInt(entry.retainedMinimumMicrounits);
  const cap = BigInt(limit);
  return immutable({retainedMinimumMicrounits: retained.toString(),
    availableForNewReservationsMicrounits: (retained < cap ? cap - retained : 0n).toString(),
    overageMicrounits: (retained > cap ? retained - cap : 0n).toString()});
}

function withoutStateSha256(state: RunBudgetState): Omit<RunBudgetState, "sha256"> {
  const {sha256: _ignored, ...body} = state;
  return body;
}

function sealState(body: Omit<RunBudgetState, "sha256">): RunBudgetState {
  return immutable({...body, sha256: routingSha256(body)});
}

/** Exact parser for trusted-store reload: verifies schemas, receipts, lineage, totals, order, and digest. */
export function parseRunBudgetState(raw: unknown): RunBudgetState {
  const value = object(raw);
  exact(value, ["version", "policy", "entries", "totals", "createdAt", "updatedAt", "digestBoundary", "proofBoundary", "sha256"]);
  if (!SHA256.test(String(value.sha256 ?? ""))) fail("RUN_BUDGET_DIGEST_INVALID");
  const {sha256: _ignored, ...unsealed} = value;
  if (routingSha256(unsealed) !== value.sha256) fail("RUN_BUDGET_DIGEST_INVALID");
  literal(value.version, 1, "RUN_BUDGET_VERSION_UNKNOWN");
  const policy = parseStoredPolicy(value.policy);
  if (!Array.isArray(value.entries)) fail("RUN_BUDGET_SCHEMA_INVALID");
  const entries = value.entries.map(parseEntry);
  if (entries.some(entry => entry.currentReceipt.status !== "denied" &&
      entry.currentReceipt.status !== "reserved" &&
      Date.parse(entry.currentReceipt.dispatchedAt!) >= Date.parse(policy.expiresAt))) {
    fail("RUN_BUDGET_ENTRY_OUTSIDE_POLICY_WINDOW");
  }
  const runIds = entries.map(entry => entry.runId);
  if (new Set(runIds).size !== runIds.length || runIds.some((runId, index) => index > 0 && runIds[index - 1]! >= runId)) {
    fail("RUN_BUDGET_ENTRY_ORDER_INVALID");
  }
  const expectedTotals = totals(entries, policy.maxReservedAggregateMicrounits);
  const storedTotals = object(value.totals);
  exact(storedTotals, ["retainedMinimumMicrounits", "availableForNewReservationsMicrounits", "overageMicrounits"]);
  let legacyNumericTotals = false;
  for (const key of Object.keys(expectedTotals) as (keyof typeof expectedTotals)[]) {
    const stored = storedTotals[key];
    const canonical = typeof stored === "number"
      ? (legacyNumericTotals = true, String(integer(stored)))
      : decimal(stored);
    if (canonical !== expectedTotals[key]) fail("RUN_BUDGET_TOTALS_CONTRADICTORY");
  }
  const createdAt = timestamp(value.createdAt), updatedAt = timestamp(value.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt) || entries.some(entry =>
    Date.parse(entry.createdAt) < Date.parse(createdAt) || Date.parse(entry.updatedAt) > Date.parse(updatedAt))) {
    fail("RUN_BUDGET_TIME_INVALID");
  }
  literal(value.digestBoundary, DIGEST_BOUNDARY);
  literal(value.proofBoundary, PROOF_BOUNDARY);
  const normalized = {version: 1 as const, policy, entries, totals: expectedTotals, createdAt, updatedAt,
    digestBoundary: DIGEST_BOUNDARY, proofBoundary: PROOF_BOUNDARY};
  return legacyNumericTotals ? sealState(normalized)
    : immutable({...normalized, sha256: value.sha256 as string});
}

export function createRunBudgetState(policy: RunBudgetPolicy, createdAt: string): RunBudgetState {
  const parsedPolicy = parseStoredPolicy(policy);
  const at = timestamp(createdAt, "RUN_BUDGET_CREATED_AT_INVALID");
  return sealState({version: 1, policy: parsedPolicy, entries: [], totals: totals([], parsedPolicy.maxReservedAggregateMicrounits),
    createdAt: at, updatedAt: at, digestBoundary: DIGEST_BOUNDARY, proofBoundary: PROOF_BOUNDARY});
}

function operationTime(value: string, state: RunBudgetState): string {
  const at = timestamp(value, "RUN_BUDGET_OPERATION_TIME_INVALID");
  if (Date.parse(at) < Date.parse(state.updatedAt)) fail("RUN_BUDGET_OPERATION_TIME_INVALID");
  return at;
}

function withEntry(state: RunBudgetState, entry: RunBudgetEntry, updatedAt: string): RunBudgetState {
  const entries = [...state.entries.filter(existing => existing.runId !== entry.runId), entry]
    .sort((a, b) => a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0);
  return sealState({...withoutStateSha256(state), entries,
    totals: totals(entries, state.policy.maxReservedAggregateMicrounits), updatedAt});
}

/** Atomically reserve a selected Run's full conservative amount before dispatch. */
export function reserveRunBudget(rawState: unknown, rawReceipt: unknown, reservedAt: string): RunBudgetState {
  const state = parseRunBudgetState(rawState);
  const receipt = parseRunRoutingReceipt(rawReceipt);
  const accounting = expectedAccounting(receipt, "reserve");
  if (receipt.status === "denied" || receipt.status !== "reserved") fail("RUN_BUDGET_RESERVATION_RECEIPT_INVALID");
  const existing = state.entries.find(entry => entry.runId === receipt.binding.runId);
  const replay = existing?.appliedEvents.some(event => event.operation === "reserve" &&
    event.routingReceiptSha256 === receipt.receiptSha256);
  if (replay) return state;
  if (existing) fail("RUN_BUDGET_RESERVATION_CONFLICT");
  const at = operationTime(reservedAt, state);
  if (Date.parse(at) < Date.parse(state.policy.validFrom)) fail("RUN_BUDGET_POLICY_NOT_YET_VALID");
  if (Date.parse(at) >= Date.parse(state.policy.expiresAt)) fail("RUN_BUDGET_POLICY_EXPIRED");
  if (BigInt(accounting.retained) > BigInt(state.totals.availableForNewReservationsMicrounits)) {
    fail("RUN_BUDGET_INSUFFICIENT_AVAILABLE");
  }
  const identity = routingIdentity(receipt);
  const entry: RunBudgetEntry = immutable({runId: receipt.binding.runId, agentId: receipt.binding.agentId,
    routingIdentitySha256: identity, reservationReceipt: receipt, currentReceipt: receipt,
    status: "reserved", initialReservationMicrounits: accounting.initial,
    retainedMinimumMicrounits: accounting.retained,
    appliedEvents: [{operation: "reserve", routingReceiptSha256: receipt.receiptSha256}], createdAt: at, updatedAt: at});
  return withEntry(state, entry, at);
}

/**
 * Apply routing progress or settlement. A reserved/no-dispatch receipt is an explicit pre-dispatch cancellation;
 * dispatched/unresolved retains the full reservation, and reconciliation may create a conservative overage.
 */
export function settleRunBudget(rawState: unknown, rawReceipt: unknown, settledAt: string): RunBudgetState {
  const state = parseRunBudgetState(rawState);
  const receipt = parseRunRoutingReceipt(rawReceipt);
  const existing = state.entries.find(entry => entry.runId === receipt.binding.runId);
  const replay = existing?.appliedEvents.some(event => event.operation === "settle" &&
    event.routingReceiptSha256 === receipt.receiptSha256);
  if (replay) return state;
  const at = operationTime(settledAt, state);
  const accounting = expectedAccounting(receipt, "settle");
  if (receipt.status === "denied") {
    if (existing) fail("RUN_BUDGET_RUN_REBOUND");
    const entry: RunBudgetEntry = immutable({runId: receipt.binding.runId, agentId: receipt.binding.agentId,
      routingIdentitySha256: routingIdentity(receipt), reservationReceipt: null, currentReceipt: receipt,
      status: "denied", initialReservationMicrounits: 0, retainedMinimumMicrounits: 0,
      appliedEvents: [{operation: "settle", routingReceiptSha256: receipt.receiptSha256}], createdAt: at, updatedAt: at});
    return withEntry(state, entry, at);
  }
  if (!existing || !existing.reservationReceipt) fail("RUN_BUDGET_RESERVATION_MISSING");
  if (existing.agentId !== receipt.binding.agentId || existing.routingIdentitySha256 !== routingIdentity(receipt)) {
    fail("RUN_BUDGET_RUN_REBOUND");
  }
  if (existing.status === "cancelled" || existing.status === "settled" ||
      existing.status === "reconciliation_required" || existing.status === "denied") fail("RUN_BUDGET_TERMINAL_CONFLICT");
  if (existing.status === "dispatched" && receipt.status === "reserved") fail("RUN_BUDGET_STATE_REGRESSION");
  if (existing.status === "reserved" && receipt.status !== "reserved" &&
      Date.parse(receipt.dispatchedAt!) >= Date.parse(state.policy.expiresAt)) fail("RUN_BUDGET_POLICY_EXPIRED");
  const entry: RunBudgetEntry = immutable({...existing, currentReceipt: receipt, status: accounting.status,
    initialReservationMicrounits: accounting.initial, retainedMinimumMicrounits: accounting.retained,
    appliedEvents: [...existing.appliedEvents, {operation: "settle" as const,
      routingReceiptSha256: receipt.receiptSha256}], updatedAt: at});
  return withEntry(state, entry, at);
}

function reservationForm(receipt: RunRouteReceipt): RunRouteReceipt {
  if (receipt.status === "reserved") return receipt;
  const {receiptSha256: _ignored, ...body} = receipt;
  const reservedBody = {...body, status: "reserved" as const, attemptsUsed: 0 as const,
    dispatchedAt: null, settledAt: null, settlement: null};
  const reserved = parseRunRoutingReceipt({...reservedBody, receiptSha256: routingSha256(reservedBody)});
  if (reserved.status === "denied") fail("RUN_BUDGET_RESERVATION_RECEIPT_INVALID");
  return reserved;
}

/**
 * One-time conservative migration for a valid historical routing receipt. It
 * bypasses admission availability because past work already happened, so the
 * recomputed state may intentionally be over its current synthetic limit.
 * A historical reserved receipt is cancelled because no pre-restart process is
 * allowed to dispatch it.
 */
export function backfillRunBudget(rawState: unknown, rawReceipt: unknown, migratedAt: string): RunBudgetState {
  const state = parseRunBudgetState(rawState);
  const receipt = parseRunRoutingReceipt(rawReceipt);
  const existing = state.entries.find(entry => entry.runId === receipt.binding.runId);
  if (existing) return settleRunBudget(state, receipt, migratedAt);
  const at = operationTime(migratedAt, state);
  if (receipt.status === "denied") return settleRunBudget(state, receipt, at);
  if (receipt.status !== "reserved" &&
      Date.parse(receipt.dispatchedAt!) >= Date.parse(state.policy.expiresAt)) {
    fail("RUN_BUDGET_ENTRY_OUTSIDE_POLICY_WINDOW");
  }
  const reserved = reservationForm(receipt);
  const accounting = expectedAccounting(receipt, "settle");
  const entry: RunBudgetEntry = immutable({runId: receipt.binding.runId, agentId: receipt.binding.agentId,
    routingIdentitySha256: routingIdentity(receipt), reservationReceipt: reserved, currentReceipt: receipt,
    status: accounting.status, initialReservationMicrounits: accounting.initial,
    retainedMinimumMicrounits: accounting.retained,
    appliedEvents: [
      {operation: "reserve" as const, routingReceiptSha256: reserved.receiptSha256},
      {operation: "settle" as const, routingReceiptSha256: receipt.receiptSha256},
    ], createdAt: at, updatedAt: at});
  return withEntry(state, entry, at);
}
