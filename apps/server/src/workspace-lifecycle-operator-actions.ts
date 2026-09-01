import {routingSha256} from "./run-router.js";
import {
  cancelWorkspaceLifecycleIntent,
  parseWorkspaceResourceState,
  reopenWorkspaceLifecycleIntent,
  type WorkspaceLifecycleIntent,
  type WorkspaceResourceState,
} from "./workspace-resource-governor.js";

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_ACCEPTED_ACTIONS = 32;
const MAX_TERMINAL_ACTIONS = 128;
const PROOF_BOUNDARY =
  "Durable local operator-transition evidence and bounded replay cache; not operator identity, authorization, filesystem-content proof, or an unbounded audit log." as const;

type JsonObject = {[key: string]: unknown};

export type WorkspaceLifecycleOperatorAction = "retry" | "cancel";
export type WorkspaceLifecycleOperatorOutcome = "completed" | "cancelled" | "unresolved";

export interface WorkspaceLifecycleOperatorRequest {
  actionId: string;
  action: WorkspaceLifecycleOperatorAction;
  intentId: string;
  agentId: string;
  intentSha256: string;
  ledgerSha256: string;
  evidenceSha256: string;
}

export interface WorkspaceLifecycleOperatorActionReceipt {
  version: 1;
  actionId: string;
  action: WorkspaceLifecycleOperatorAction;
  intentId: string;
  agentId: string;
  kind: WorkspaceLifecycleIntent["kind"];
  requestSha256: string;
  beforeLedgerSha256: string;
  beforeIntentSha256: string;
  evidenceSha256: string;
  status: "accepted" | "terminal";
  effect: "reopened" | "cancelled";
  afterIntentSha256: string | null;
  outcome: WorkspaceLifecycleOperatorOutcome | null;
  acceptedAt: string;
  terminalAt: string | null;
  resultLedgerSha256: string | null;
  receiptSha256: string;
}

export interface WorkspaceLifecycleOperatorActionState {
  version: 1;
  runtimeInstanceId: string;
  policySha256: string;
  maxAcceptedActions: typeof MAX_ACCEPTED_ACTIONS;
  maxTerminalActions: typeof MAX_TERMINAL_ACTIONS;
  receipts: readonly Readonly<WorkspaceLifecycleOperatorActionReceipt>[];
  createdAt: string;
  updatedAt: string;
  proofBoundary: typeof PROOF_BOUNDARY;
  sha256: string;
}

export class WorkspaceLifecycleOperatorActionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WorkspaceLifecycleOperatorActionError";
  }
}

function fail(code: string): never {
  throw new WorkspaceLifecycleOperatorActionError(code);
}

function object(value: unknown, code = "WORKSPACE_OPERATOR_ACTION_SCHEMA_INVALID"): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  return value as JsonObject;
}

function exact(value: JsonObject, keys: readonly string[], code = "WORKSPACE_OPERATOR_ACTION_SCHEMA_INVALID"): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
}

function sha(value: unknown, code = "WORKSPACE_OPERATOR_ACTION_DIGEST_INVALID"): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) fail("WORKSPACE_OPERATOR_ACTION_TIME_INVALID");
  return value;
}

function identifier(value: unknown, code = "WORKSPACE_OPERATOR_ACTION_BINDING_INVALID"): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(code);
  return value;
}

function actionId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) fail("WORKSPACE_OPERATOR_ACTION_ID_INVALID");
  return value.toLowerCase();
}

function immutable<T>(value: T): T {
  return Object.freeze(structuredClone(value));
}

function receiptWithoutSha(receipt: WorkspaceLifecycleOperatorActionReceipt):
Omit<WorkspaceLifecycleOperatorActionReceipt, "receiptSha256"> {
  const {receiptSha256: _ignored, ...body} = receipt;
  return body;
}

function sealReceipt(body: Omit<WorkspaceLifecycleOperatorActionReceipt, "receiptSha256">):
WorkspaceLifecycleOperatorActionReceipt {
  return immutable({...body, receiptSha256: routingSha256(body)});
}

function parseReceipt(raw: unknown): WorkspaceLifecycleOperatorActionReceipt {
  const value = object(raw, "WORKSPACE_OPERATOR_ACTION_RECEIPT_INVALID");
  exact(value, ["version", "actionId", "action", "intentId", "agentId", "kind", "requestSha256",
    "beforeLedgerSha256", "beforeIntentSha256", "evidenceSha256", "status", "effect",
    "afterIntentSha256", "outcome", "acceptedAt", "terminalAt", "resultLedgerSha256",
    "receiptSha256"], "WORKSPACE_OPERATOR_ACTION_RECEIPT_INVALID");
  if (value.version !== 1) fail("WORKSPACE_OPERATOR_ACTION_VERSION_UNKNOWN");
  const action = value.action;
  if (action !== "retry" && action !== "cancel") fail("WORKSPACE_OPERATOR_ACTION_BINDING_INVALID");
  const kind = value.kind;
  if (kind !== "create" && kind !== "instruction_update" && kind !== "archive") {
    fail("WORKSPACE_OPERATOR_ACTION_BINDING_INVALID");
  }
  const status = value.status;
  if (status !== "accepted" && status !== "terminal") fail("WORKSPACE_OPERATOR_ACTION_STATUS_INVALID");
  const effect = value.effect;
  if (effect !== "reopened" && effect !== "cancelled" ||
      (action === "retry") !== (effect === "reopened")) {
    fail("WORKSPACE_OPERATOR_ACTION_BINDING_INVALID");
  }
  const outcome = value.outcome;
  if (outcome !== null && outcome !== "completed" && outcome !== "cancelled" && outcome !== "unresolved") {
    fail("WORKSPACE_OPERATOR_ACTION_OUTCOME_INVALID");
  }
  const acceptedAt = timestamp(value.acceptedAt);
  const terminalAt = value.terminalAt === null ? null : timestamp(value.terminalAt);
  const afterIntentSha256 = value.afterIntentSha256 === null ? null : sha(value.afterIntentSha256);
  const resultLedgerSha256 = value.resultLedgerSha256 === null ? null : sha(value.resultLedgerSha256);
  if (status === "accepted") {
    if (action !== "retry" || outcome !== null || terminalAt !== null || resultLedgerSha256 !== null ||
        afterIntentSha256 === null) fail("WORKSPACE_OPERATOR_ACTION_STATUS_CONTRADICTORY");
  } else {
    if (outcome === null || terminalAt === null || resultLedgerSha256 === null ||
        Date.parse(terminalAt) < Date.parse(acceptedAt) ||
        (action === "cancel" && (outcome !== "cancelled" || afterIntentSha256 !== null)) ||
        (action === "retry" && (outcome === "cancelled" || afterIntentSha256 === null))) {
      fail("WORKSPACE_OPERATOR_ACTION_STATUS_CONTRADICTORY");
    }
  }
  const receipt: WorkspaceLifecycleOperatorActionReceipt = {
    version: 1,
    actionId: actionId(value.actionId),
    action,
    intentId: identifier(value.intentId),
    agentId: identifier(value.agentId),
    kind,
    requestSha256: sha(value.requestSha256),
    beforeLedgerSha256: sha(value.beforeLedgerSha256),
    beforeIntentSha256: sha(value.beforeIntentSha256),
    evidenceSha256: sha(value.evidenceSha256),
    status,
    effect,
    afterIntentSha256,
    outcome,
    acceptedAt,
    terminalAt,
    resultLedgerSha256,
    receiptSha256: sha(value.receiptSha256),
  };
  if (receipt.requestSha256 !== routingSha256({version: 1, actionId: receipt.actionId,
    action: receipt.action, intentId: receipt.intentId, agentId: receipt.agentId,
    intentSha256: receipt.beforeIntentSha256, ledgerSha256: receipt.beforeLedgerSha256,
    evidenceSha256: receipt.evidenceSha256})) {
    fail("WORKSPACE_OPERATOR_ACTION_REQUEST_DIGEST_INVALID");
  }
  if (routingSha256(receiptWithoutSha(receipt)) !== receipt.receiptSha256) {
    fail("WORKSPACE_OPERATOR_ACTION_RECEIPT_DIGEST_INVALID");
  }
  return immutable(receipt);
}

function stateWithoutSha(state: WorkspaceLifecycleOperatorActionState):
Omit<WorkspaceLifecycleOperatorActionState, "sha256"> {
  const {sha256: _ignored, ...body} = state;
  return body;
}

function sealState(body: Omit<WorkspaceLifecycleOperatorActionState, "sha256">):
WorkspaceLifecycleOperatorActionState {
  return immutable({...body, sha256: routingSha256(body)});
}

function receiptOrder(left: WorkspaceLifecycleOperatorActionReceipt,
  right: WorkspaceLifecycleOperatorActionReceipt): number {
  return left.acceptedAt.localeCompare(right.acceptedAt) || left.actionId.localeCompare(right.actionId);
}

function boundedReceipts(receipts: readonly WorkspaceLifecycleOperatorActionReceipt[]):
WorkspaceLifecycleOperatorActionReceipt[] {
  const ordered = [...receipts].sort(receiptOrder);
  const accepted = ordered.filter(receipt => receipt.status === "accepted");
  if (accepted.length > MAX_ACCEPTED_ACTIONS) fail("WORKSPACE_OPERATOR_ACTION_PENDING_LIMIT");
  const terminal = ordered.filter(receipt => receipt.status === "terminal");
  const retainedTerminal = terminal.slice(Math.max(0, terminal.length - MAX_TERMINAL_ACTIONS));
  return [...accepted, ...retainedTerminal].sort(receiptOrder);
}

export function parseWorkspaceLifecycleOperatorActionState(
  raw: unknown,
  expected: {runtimeInstanceId: string; policySha256: string},
): WorkspaceLifecycleOperatorActionState {
  const value = object(raw);
  exact(value, ["version", "runtimeInstanceId", "policySha256", "maxAcceptedActions",
    "maxTerminalActions", "receipts", "createdAt", "updatedAt", "proofBoundary", "sha256"]);
  const storedSha256 = sha(value.sha256);
  const {sha256: _ignored, ...unsealed} = value;
  if (routingSha256(unsealed) !== storedSha256) fail("WORKSPACE_OPERATOR_ACTION_DIGEST_INVALID");
  if (value.version !== 1 || value.maxAcceptedActions !== MAX_ACCEPTED_ACTIONS ||
      value.maxTerminalActions !== MAX_TERMINAL_ACTIONS || value.proofBoundary !== PROOF_BOUNDARY ||
      !Array.isArray(value.receipts)) fail("WORKSPACE_OPERATOR_ACTION_SCHEMA_INVALID");
  const runtimeInstanceId = identifier(value.runtimeInstanceId);
  const policySha256 = sha(value.policySha256);
  if (runtimeInstanceId !== expected.runtimeInstanceId || policySha256 !== expected.policySha256) {
    fail("WORKSPACE_OPERATOR_ACTION_POLICY_MISMATCH");
  }
  const receipts = value.receipts.map(parseReceipt);
  if (receipts.length > MAX_ACCEPTED_ACTIONS + MAX_TERMINAL_ACTIONS ||
      receipts.some((receipt, index) => index > 0 && receiptOrder(receipts[index - 1]!, receipt) >= 0) ||
      new Set(receipts.map(receipt => receipt.actionId)).size !== receipts.length ||
      receipts.filter(receipt => receipt.status === "accepted").length > MAX_ACCEPTED_ACTIONS ||
      receipts.filter(receipt => receipt.status === "terminal").length > MAX_TERMINAL_ACTIONS) {
    fail("WORKSPACE_OPERATOR_ACTION_ORDER_INVALID");
  }
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt) || receipts.some(receipt =>
    Date.parse(receipt.acceptedAt) < Date.parse(createdAt) ||
    Date.parse(receipt.acceptedAt) > Date.parse(updatedAt) ||
    (receipt.terminalAt !== null && Date.parse(receipt.terminalAt) > Date.parse(updatedAt)))) {
    fail("WORKSPACE_OPERATOR_ACTION_TIME_INVALID");
  }
  return immutable({version: 1, runtimeInstanceId, policySha256,
    maxAcceptedActions: MAX_ACCEPTED_ACTIONS, maxTerminalActions: MAX_TERMINAL_ACTIONS,
    receipts, createdAt, updatedAt, proofBoundary: PROOF_BOUNDARY, sha256: storedSha256});
}

export function createWorkspaceLifecycleOperatorActionState(
  binding: {runtimeInstanceId: string; policySha256: string}, createdAt: string,
): WorkspaceLifecycleOperatorActionState {
  const at = timestamp(createdAt);
  return sealState({version: 1, runtimeInstanceId: identifier(binding.runtimeInstanceId),
    policySha256: sha(binding.policySha256), maxAcceptedActions: MAX_ACCEPTED_ACTIONS,
    maxTerminalActions: MAX_TERMINAL_ACTIONS, receipts: [], createdAt: at, updatedAt: at,
    proofBoundary: PROOF_BOUNDARY});
}

export function workspaceLifecycleOperatorRequestSha256(
  raw: WorkspaceLifecycleOperatorRequest,
): string {
  const request = parseRequest(raw);
  return routingSha256({version: 1, ...request});
}

function parseRequest(raw: WorkspaceLifecycleOperatorRequest): WorkspaceLifecycleOperatorRequest {
  const value = object(raw);
  exact(value, ["actionId", "action", "intentId", "agentId", "intentSha256", "ledgerSha256",
    "evidenceSha256"]);
  if (value.action !== "retry" && value.action !== "cancel") {
    fail("WORKSPACE_OPERATOR_ACTION_BINDING_INVALID");
  }
  return {actionId: actionId(value.actionId), action: value.action,
    intentId: identifier(value.intentId), agentId: identifier(value.agentId),
    intentSha256: sha(value.intentSha256), ledgerSha256: sha(value.ledgerSha256),
    evidenceSha256: sha(value.evidenceSha256)};
}

function actionState(
  raw: unknown,
  resources: WorkspaceResourceState,
  at: string,
): WorkspaceLifecycleOperatorActionState {
  return raw === null || raw === undefined
    ? createWorkspaceLifecycleOperatorActionState(resources.policy, at)
    : parseWorkspaceLifecycleOperatorActionState(raw, resources.policy);
}

function appendReceipt(
  state: WorkspaceLifecycleOperatorActionState,
  receipt: WorkspaceLifecycleOperatorActionReceipt,
  at: string,
): WorkspaceLifecycleOperatorActionState {
  if (Date.parse(at) < Date.parse(state.updatedAt)) fail("WORKSPACE_OPERATOR_ACTION_TIME_INVALID");
  const existing = state.receipts.find(item => item.actionId === receipt.actionId);
  if (existing) {
    if (existing.requestSha256 !== receipt.requestSha256) fail("WORKSPACE_OPERATOR_ACTION_ID_REUSED");
    return state;
  }
  const receipts = boundedReceipts([...state.receipts, receipt]);
  return sealState({...stateWithoutSha(state), receipts, updatedAt: at});
}

export function findWorkspaceLifecycleOperatorAction(
  raw: unknown,
  binding: {runtimeInstanceId: string; policySha256: string},
  requestedActionId: string,
): WorkspaceLifecycleOperatorActionReceipt | null {
  if (raw === null || raw === undefined) return null;
  const state = parseWorkspaceLifecycleOperatorActionState(raw, binding);
  const normalized = actionId(requestedActionId);
  return state.receipts.find(receipt => receipt.actionId === normalized) ?? null;
}

export function acceptWorkspaceLifecycleOperatorAction(
  rawResources: unknown,
  rawActions: unknown,
  rawRequest: WorkspaceLifecycleOperatorRequest,
  acceptedAt: string,
): {workspaceResources: WorkspaceResourceState;
  operatorActions: WorkspaceLifecycleOperatorActionState;
  receipt: WorkspaceLifecycleOperatorActionReceipt;
} {
  const resources = parseWorkspaceResourceState(rawResources);
  const request = parseRequest(rawRequest);
  if (resources.sha256 !== request.ledgerSha256) fail("WORKSPACE_OPERATOR_ACTION_LEDGER_CHANGED");
  const intent = resources.lifecycleIntents.find(item => item.intentId === request.intentId);
  if (!intent || intent.agentId !== request.agentId || intent.intentSha256 !== request.intentSha256 ||
      intent.status !== "reconciliation_required") fail("WORKSPACE_OPERATOR_ACTION_INTENT_CHANGED");
  const at = timestamp(acceptedAt);
  const actions = actionState(rawActions, resources, at);
  const requestSha256 = routingSha256({version: 1, ...request});
  const existing = actions.receipts.find(receipt => receipt.actionId === request.actionId);
  if (existing) {
    if (existing.requestSha256 !== requestSha256) fail("WORKSPACE_OPERATOR_ACTION_ID_REUSED");
    return {workspaceResources: resources, operatorActions: actions, receipt: existing};
  }
  const nextResources = request.action === "retry"
    ? reopenWorkspaceLifecycleIntent(resources, request, at)
    : cancelWorkspaceLifecycleIntent(resources, request, at);
  const afterIntent = nextResources.lifecycleIntents.find(item => item.intentId === intent.intentId);
  const terminal = request.action === "cancel";
  if (!terminal && (!afterIntent || afterIntent.status !== "prepared")) {
    fail("WORKSPACE_OPERATOR_ACTION_EFFECT_INVALID");
  }
  const receipt = sealReceipt({version: 1, actionId: request.actionId, action: request.action,
    intentId: request.intentId, agentId: request.agentId, kind: intent.kind, requestSha256,
    beforeLedgerSha256: request.ledgerSha256, beforeIntentSha256: request.intentSha256,
    evidenceSha256: request.evidenceSha256, status: terminal ? "terminal" : "accepted",
    effect: terminal ? "cancelled" : "reopened", afterIntentSha256: afterIntent?.intentSha256 ?? null,
    outcome: terminal ? "cancelled" : null, acceptedAt: at, terminalAt: terminal ? at : null,
    resultLedgerSha256: terminal ? nextResources.sha256 : null});
  return {workspaceResources: nextResources,
    operatorActions: appendReceipt(actions, receipt, at), receipt};
}

export function terminalizeWorkspaceLifecycleOperatorAction(
  raw: unknown,
  binding: {runtimeInstanceId: string; policySha256: string},
  input: {actionId: string; requestSha256: string;
    outcome: "completed" | "unresolved"; resultLedgerSha256: string},
  terminalAt: string,
): WorkspaceLifecycleOperatorActionState {
  const state = parseWorkspaceLifecycleOperatorActionState(raw, binding);
  const id = actionId(input.actionId);
  const receipt = state.receipts.find(item => item.actionId === id);
  if (!receipt || receipt.action !== "retry" || receipt.requestSha256 !== sha(input.requestSha256)) {
    fail("WORKSPACE_OPERATOR_ACTION_BINDING_INVALID");
  }
  if (receipt.status === "terminal") {
    if (receipt.outcome !== input.outcome || receipt.resultLedgerSha256 !== input.resultLedgerSha256) {
      fail("WORKSPACE_OPERATOR_ACTION_TERMINAL_CONFLICT");
    }
    return state;
  }
  const at = timestamp(terminalAt);
  if (Date.parse(at) < Date.parse(state.updatedAt)) fail("WORKSPACE_OPERATOR_ACTION_TIME_INVALID");
  const terminal = sealReceipt({...receiptWithoutSha(receipt), status: "terminal", outcome: input.outcome,
    terminalAt: at, resultLedgerSha256: sha(input.resultLedgerSha256)});
  const receipts = boundedReceipts(state.receipts.map(item => item.actionId === id ? terminal : item));
  return sealState({...stateWithoutSha(state), receipts, updatedAt: at});
}

export function pendingWorkspaceLifecycleOperatorActionForIntent(
  raw: unknown,
  binding: {runtimeInstanceId: string; policySha256: string},
  intent: Pick<WorkspaceLifecycleIntent, "intentId" | "agentId" | "intentSha256">,
): WorkspaceLifecycleOperatorActionReceipt | null {
  if (raw === null || raw === undefined) return null;
  const state = parseWorkspaceLifecycleOperatorActionState(raw, binding);
  return state.receipts.find(receipt => receipt.status === "accepted" && receipt.action === "retry" &&
    receipt.intentId === intent.intentId && receipt.agentId === intent.agentId &&
    receipt.afterIntentSha256 === intent.intentSha256) ?? null;
}

export const workspaceLifecycleOperatorActionProofBoundary = PROOF_BOUNDARY;
