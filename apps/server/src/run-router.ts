import {createHash} from "node:crypto";

const SHA256 = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_QUALITY = 1_000;
const ONE_MILLION = 1_000_000n;

export class RunRoutingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RunRoutingError";
  }
}

export interface RoutingPrice {
  requestMicrounits: number;
  inputPerMillionMicrounits: number;
  outputPerMillionMicrounits: number;
}

export interface RoutingCatalogRoute {
  routeId: string;
  provider: string;
  model: string;
  qualityScore: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: readonly string[];
  pricing: Readonly<RoutingPrice>;
}

export interface RoutingCatalog {
  schemaVersion: 1;
  catalogId: string;
  sourceId: string;
  pricingVersion: string;
  publishedAt: string;
  expiresAt: string;
  costUnit: "synthetic-microunit";
  routes: readonly Readonly<RoutingCatalogRoute>[];
  sha256: string;
}

export interface RunRoutingRequirements {
  schemaVersion: 1;
  minQualityScore: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxReservedCostMicrounits: number;
  requiredCapabilities: readonly string[];
}

export interface ReportedRouteUsage {
  inputTokens: number;
  outputTokens: number;
}

interface RouteSettlement {
  state: "settled" | "reconciliation_required";
  reason: "reported_usage_accepted" | "usage_missing_or_invalid" | "usage_exceeds_reservation";
  usage: ReportedRouteUsage | null;
  estimatedCostMicrounits: number | null;
  retainedMinimumCostMicrounits: number;
  releasedCostMicrounits: number;
  usageEvidence: "reported_unverified" | "unavailable";
  billingProof: false;
  qualityProof: false;
}

export interface RunRouteReceipt {
  version: 1;
  status: "reserved" | "dispatched" | "settled" | "reconciliation_required";
  binding: Readonly<{
    runId: string;
    agentId: string;
    toolPolicySha256: string;
    requirementsSha256: string;
  }>;
  catalog: Readonly<{
    catalogId: string;
    sourceId: string;
    pricingVersion: string;
    catalogSha256: string;
    publishedAt: string;
    expiresAt: string;
  }>;
  requirements: Readonly<RunRoutingRequirements>;
  selection: Readonly<{
    routeId: string;
    provider: string;
    model: string;
    routeSha256: string;
    qualityScore: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    capabilities: readonly string[];
    pricing: Readonly<RoutingPrice>;
  }>;
  reservation: Readonly<{
    inputTokens: number;
    outputTokens: number;
    reservedCostMicrounits: number;
  }>;
  maxAttempts: 1;
  attemptsUsed: 0 | 1;
  decidedAt: string;
  dispatchedAt: string | null;
  settledAt: string | null;
  settlement: Readonly<RouteSettlement> | null;
  proofBoundary: "Routing uses host-owned estimates; reported usage is not provider billing or model-quality proof.";
  receiptSha256: string;
}

export type RouteDenialReason = "catalog_invalid" | "catalog_stale" | "catalog_not_yet_valid"
  | "requirements_invalid" | "no_eligible_route";

export interface RunRouteDeniedReceipt {
  version: 1;
  status: "denied";
  binding: Readonly<{
    runId: string;
    agentId: string;
    toolPolicySha256: string;
    requirementsSha256: string | null;
  }>;
  catalog: Readonly<{
    catalogId: string;
    sourceId: string;
    pricingVersion: string;
    catalogSha256: string;
  }> | null;
  reason: RouteDenialReason;
  errorCode: string;
  maxAttempts: 1;
  attemptsUsed: 0;
  decidedAt: string;
  proofBoundary: "Terminal host denial; no model dispatch, provider billing, or model-quality proof.";
  receiptSha256: string;
}

export type RunRoutingReceipt = RunRouteReceipt | RunRouteDeniedReceipt;

type JsonObject = {[key: string]: unknown};

function fail(code: string): never {
  throw new RunRoutingError(code);
}

function object(value: unknown, code: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  return value as JsonObject;
}

function exact(value: JsonObject, keys: readonly string[], code: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
}

function name(value: unknown, code: string): string {
  if (typeof value !== "string" || !NAME.test(value)) fail(code);
  return value;
}

function safeInteger(value: unknown, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail(code);
  return value as number;
}

function timestamp(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) fail(code);
  return value;
}

function stringSet(value: unknown, code: string): string[] {
  if (!Array.isArray(value)) fail(code);
  const result = value.map(item => name(item, code)).sort();
  if (new Set(result).size !== result.length) fail(code);
  return result;
}

/** Canonical JSON for already validated JSON-like data. Object keys are sorted; arrays retain their order. */
export function canonicalRoutingJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalRoutingJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalRoutingJson(item)}`).join(",")}}`;
  }
  return fail("ROUTING_CANONICAL_VALUE_INVALID");
}

export function routingSha256(value: unknown): string {
  return createHash("sha256").update(canonicalRoutingJson(value)).digest("hex");
}

function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as object)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function parsePrice(raw: unknown): RoutingPrice {
  const value = object(raw, "ROUTING_PRICE_INVALID");
  exact(value, ["requestMicrounits", "inputPerMillionMicrounits", "outputPerMillionMicrounits"], "ROUTING_PRICE_SCHEMA_INVALID");
  const price = {
    requestMicrounits: safeInteger(value.requestMicrounits, 0, Number.MAX_SAFE_INTEGER, "ROUTING_PRICE_INVALID"),
    inputPerMillionMicrounits: safeInteger(value.inputPerMillionMicrounits, 0, Number.MAX_SAFE_INTEGER, "ROUTING_PRICE_INVALID"),
    outputPerMillionMicrounits: safeInteger(value.outputPerMillionMicrounits, 0, Number.MAX_SAFE_INTEGER, "ROUTING_PRICE_INVALID"),
  };
  if (price.requestMicrounits === 0 && price.inputPerMillionMicrounits === 0 && price.outputPerMillionMicrounits === 0) fail("ROUTING_PRICE_INVALID");
  return price;
}

function parseRoute(raw: unknown): RoutingCatalogRoute {
  const value = object(raw, "ROUTING_ROUTE_INVALID");
  exact(value, ["routeId", "provider", "model", "qualityScore", "maxInputTokens", "maxOutputTokens", "capabilities", "pricing"], "ROUTING_ROUTE_SCHEMA_INVALID");
  return {
    routeId: name(value.routeId, "ROUTING_ROUTE_ID_INVALID"),
    provider: name(value.provider, "ROUTING_PROVIDER_INVALID"),
    model: name(value.model, "ROUTING_MODEL_INVALID"),
    qualityScore: safeInteger(value.qualityScore, 1, MAX_QUALITY, "ROUTING_QUALITY_INVALID"),
    maxInputTokens: safeInteger(value.maxInputTokens, 1, Number.MAX_SAFE_INTEGER, "ROUTING_TOKEN_LIMIT_INVALID"),
    maxOutputTokens: safeInteger(value.maxOutputTokens, 1, Number.MAX_SAFE_INTEGER, "ROUTING_TOKEN_LIMIT_INVALID"),
    capabilities: stringSet(value.capabilities, "ROUTING_CAPABILITY_INVALID"),
    pricing: parsePrice(value.pricing),
  };
}

/** Parse, normalize, digest, and deeply freeze a host-owned, versioned exact-schema catalog. */
export function parseRoutingCatalog(raw: unknown): RoutingCatalog {
  const value = object(raw, "ROUTING_CATALOG_INVALID");
  exact(value, ["schemaVersion", "catalogId", "sourceId", "pricingVersion", "publishedAt", "expiresAt", "costUnit", "routes"], "ROUTING_CATALOG_SCHEMA_INVALID");
  if (value.schemaVersion !== 1) fail("ROUTING_CATALOG_VERSION_UNKNOWN");
  if (value.costUnit !== "synthetic-microunit") fail("ROUTING_COST_UNIT_UNKNOWN");
  if (!Array.isArray(value.routes) || value.routes.length === 0) fail("ROUTING_ROUTES_INVALID");
  const routes = value.routes.map(parseRoute).sort((a, b) => a.routeId.localeCompare(b.routeId));
  if (new Set(routes.map(route => route.routeId)).size !== routes.length) fail("ROUTING_ROUTE_ID_DUPLICATE");
  const publishedAt = timestamp(value.publishedAt, "ROUTING_PUBLISHED_AT_INVALID");
  const expiresAt = timestamp(value.expiresAt, "ROUTING_EXPIRES_AT_INVALID");
  if (Date.parse(expiresAt) <= Date.parse(publishedAt)) fail("ROUTING_CATALOG_WINDOW_INVALID");
  const normalized = {
    schemaVersion: 1 as const,
    catalogId: name(value.catalogId, "ROUTING_CATALOG_ID_INVALID"),
    sourceId: name(value.sourceId, "ROUTING_SOURCE_ID_INVALID"),
    pricingVersion: name(value.pricingVersion, "ROUTING_PRICING_VERSION_INVALID"), publishedAt, expiresAt,
    costUnit: "synthetic-microunit" as const, routes,
  };
  return immutable({...normalized, sha256: routingSha256(normalized)});
}

function parseRequirements(raw: unknown): RunRoutingRequirements {
  const value = object(raw, "ROUTING_REQUIREMENTS_INVALID");
  exact(value, ["schemaVersion", "minQualityScore", "maxInputTokens", "maxOutputTokens", "maxReservedCostMicrounits", "requiredCapabilities"], "ROUTING_REQUIREMENTS_SCHEMA_INVALID");
  if (value.schemaVersion !== 1) fail("ROUTING_REQUIREMENTS_VERSION_UNKNOWN");
  return {
    schemaVersion: 1,
    minQualityScore: safeInteger(value.minQualityScore, 1, MAX_QUALITY, "ROUTING_MIN_QUALITY_INVALID"),
    maxInputTokens: safeInteger(value.maxInputTokens, 1, Number.MAX_SAFE_INTEGER, "ROUTING_MAX_INPUT_INVALID"),
    maxOutputTokens: safeInteger(value.maxOutputTokens, 1, Number.MAX_SAFE_INTEGER, "ROUTING_MAX_OUTPUT_INVALID"),
    maxReservedCostMicrounits: safeInteger(value.maxReservedCostMicrounits, 1, Number.MAX_SAFE_INTEGER, "ROUTING_COST_CAP_INVALID"),
    requiredCapabilities: stringSet(value.requiredCapabilities, "ROUTING_REQUIRED_CAPABILITY_INVALID"),
  };
}

function ceilDiv(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

/** Integer-only cost estimate; throws rather than rounding or overflowing silently. */
export function estimateRouteCostMicrounits(route: RoutingCatalogRoute, inputTokens: number, outputTokens: number): number {
  safeInteger(inputTokens, 0, Number.MAX_SAFE_INTEGER, "ROUTING_USAGE_INVALID");
  safeInteger(outputTokens, 0, Number.MAX_SAFE_INTEGER, "ROUTING_USAGE_INVALID");
  const total = BigInt(route.pricing.requestMicrounits)
    + ceilDiv(BigInt(inputTokens) * BigInt(route.pricing.inputPerMillionMicrounits), ONE_MILLION)
    + ceilDiv(BigInt(outputTokens) * BigInt(route.pricing.outputPerMillionMicrounits), ONE_MILLION);
  if (total <= 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) fail("ROUTING_COST_OVERFLOW");
  return Number(total);
}

function withoutReceiptSha256(receipt: RunRouteReceipt): Omit<RunRouteReceipt, "receiptSha256"> {
  const {receiptSha256: _ignored, ...body} = receipt;
  return body;
}

function sealReceipt(body: Omit<RunRouteReceipt, "receiptSha256">): RunRouteReceipt {
  return immutable({...body, receiptSha256: routingSha256(body)});
}

function laterTimestamp(raw: unknown, earliest: string, code: string): string {
  const value = timestamp(raw, code);
  if (Date.parse(value) < Date.parse(earliest)) fail(code);
  return value;
}

export function planRunRoute(input: {
  runId: string;
  agentId: string;
  catalog: RoutingCatalog;
  requirements: RunRoutingRequirements;
  toolPolicyDigest: string;
  decidedAt: string;
}): RunRouteReceipt {
  const runId = name(input.runId, "ROUTING_RUN_ID_INVALID");
  const agentId = name(input.agentId, "ROUTING_AGENT_ID_INVALID");
  if (!SHA256.test(input.toolPolicyDigest)) fail("ROUTING_TOOL_POLICY_DIGEST_INVALID");
  const decidedAt = timestamp(input.decidedAt, "ROUTING_DECIDED_AT_INVALID");
  if (!input.catalog || !Object.isFrozen(input.catalog) || !SHA256.test(input.catalog.sha256)) fail("ROUTING_CATALOG_NOT_PARSED");
  const catalogBody = {
    schemaVersion: input.catalog.schemaVersion, catalogId: input.catalog.catalogId,
    sourceId: input.catalog.sourceId, pricingVersion: input.catalog.pricingVersion,
    publishedAt: input.catalog.publishedAt, expiresAt: input.catalog.expiresAt,
    costUnit: input.catalog.costUnit, routes: input.catalog.routes,
  };
  if (routingSha256(catalogBody) !== input.catalog.sha256) fail("ROUTING_CATALOG_INTEGRITY_INVALID");
  if (Date.parse(decidedAt) < Date.parse(input.catalog.publishedAt)) fail("ROUTING_CATALOG_NOT_YET_VALID");
  if (Date.parse(decidedAt) >= Date.parse(input.catalog.expiresAt)) fail("ROUTING_CATALOG_STALE");
  const requirements = immutable(parseRequirements(input.requirements));
  const required = new Set(requirements.requiredCapabilities);
  const candidates = input.catalog.routes.flatMap(route => {
    if (route.qualityScore < requirements.minQualityScore || route.maxInputTokens < requirements.maxInputTokens
        || route.maxOutputTokens < requirements.maxOutputTokens
        || [...required].some(capability => !route.capabilities.includes(capability))) return [];
    try {
      const reservedCostMicrounits = estimateRouteCostMicrounits(route, requirements.maxInputTokens, requirements.maxOutputTokens);
      return reservedCostMicrounits <= requirements.maxReservedCostMicrounits ? [{route, reservedCostMicrounits}] : [];
    } catch (error) {
      if (error instanceof RunRoutingError && error.code === "ROUTING_COST_OVERFLOW") return [];
      throw error;
    }
  }).sort((a, b) => a.reservedCostMicrounits - b.reservedCostMicrounits || a.route.routeId.localeCompare(b.route.routeId));
  const chosen = candidates[0];
  if (!chosen) fail("ROUTING_NO_ELIGIBLE_ROUTE");
  const route = chosen.route;
  const body: Omit<RunRouteReceipt, "receiptSha256"> = {
    version: 1, status: "reserved",
    binding: {runId, agentId, toolPolicySha256: input.toolPolicyDigest, requirementsSha256: routingSha256(requirements)},
    catalog: {catalogId: input.catalog.catalogId, sourceId: input.catalog.sourceId,
      pricingVersion: input.catalog.pricingVersion, catalogSha256: input.catalog.sha256,
      publishedAt: input.catalog.publishedAt, expiresAt: input.catalog.expiresAt},
    requirements,
    selection: {routeId: route.routeId, provider: route.provider, model: route.model,
      routeSha256: routingSha256(route), qualityScore: route.qualityScore,
      maxInputTokens: route.maxInputTokens, maxOutputTokens: route.maxOutputTokens,
      capabilities: [...route.capabilities], pricing: {...route.pricing}},
    reservation: {inputTokens: requirements.maxInputTokens, outputTokens: requirements.maxOutputTokens,
      reservedCostMicrounits: chosen.reservedCostMicrounits},
    maxAttempts: 1, attemptsUsed: 0, decidedAt, dispatchedAt: null, settledAt: null, settlement: null,
    proofBoundary: "Routing uses host-owned estimates; reported usage is not provider billing or model-quality proof.",
  };
  return sealReceipt(body);
}

function denialReason(code: string): RouteDenialReason | null {
  if (code === "ROUTING_CATALOG_STALE") return "catalog_stale";
  if (code === "ROUTING_CATALOG_NOT_YET_VALID") return "catalog_not_yet_valid";
  if (code === "ROUTING_NO_ELIGIBLE_ROUTE" || code === "ROUTING_COST_OVERFLOW") return "no_eligible_route";
  if (code.startsWith("ROUTING_REQUIREMENTS_") || code.startsWith("ROUTING_MIN_")
      || code.startsWith("ROUTING_MAX_") || code === "ROUTING_COST_CAP_INVALID"
      || code.startsWith("ROUTING_REQUIRED_CAPABILITY_")) return "requirements_invalid";
  if (code.startsWith("ROUTING_CATALOG_") || code.startsWith("ROUTING_ROUTE_")
      || code.startsWith("ROUTING_PRICE_") || code.startsWith("ROUTING_QUALITY_")
      || code.startsWith("ROUTING_TOKEN_LIMIT_") || code.startsWith("ROUTING_CAPABILITY_")
      || code.startsWith("ROUTING_PROVIDER_") || code.startsWith("ROUTING_MODEL_")
      || code.startsWith("ROUTING_SOURCE_") || code.startsWith("ROUTING_PRICING_")
      || code === "ROUTING_PUBLISHED_AT_INVALID" || code === "ROUTING_EXPIRES_AT_INVALID"
      || code === "ROUTING_COST_UNIT_UNKNOWN" || code === "ROUTING_ROUTES_INVALID") return "catalog_invalid";
  return null;
}

/** Create a digest-sealed terminal decision for a trusted-store routing denial. */
export function createRouteDenialReceipt(input: {
  runId: string;
  agentId: string;
  toolPolicyDigest: string;
  decidedAt: string;
  reason: RouteDenialReason;
  errorCode: string;
  catalog?: RoutingCatalog | null;
  requirements?: RunRoutingRequirements | null;
}): RunRouteDeniedReceipt {
  const runId = name(input.runId, "ROUTING_RUN_ID_INVALID");
  const agentId = name(input.agentId, "ROUTING_AGENT_ID_INVALID");
  if (!SHA256.test(input.toolPolicyDigest)) fail("ROUTING_TOOL_POLICY_DIGEST_INVALID");
  const decidedAt = timestamp(input.decidedAt, "ROUTING_DECIDED_AT_INVALID");
  if (!denialReason(input.errorCode) || denialReason(input.errorCode) !== input.reason) fail("ROUTING_DENIAL_REASON_INVALID");
  const requirements = input.requirements ? parseRequirements(input.requirements) : null;
  const catalog = input.catalog ? {catalogId: input.catalog.catalogId, sourceId: input.catalog.sourceId,
    pricingVersion: input.catalog.pricingVersion, catalogSha256: input.catalog.sha256} : null;
  const body: Omit<RunRouteDeniedReceipt, "receiptSha256"> = {
    version: 1, status: "denied",
    binding: {runId, agentId, toolPolicySha256: input.toolPolicyDigest,
      requirementsSha256: requirements ? routingSha256(requirements) : null},
    catalog, reason: input.reason, errorCode: input.errorCode, maxAttempts: 1, attemptsUsed: 0, decidedAt,
    proofBoundary: "Terminal host denial; no model dispatch, provider billing, or model-quality proof.",
  };
  return immutable({...body, receiptSha256: routingSha256(body)});
}

/**
 * Integration boundary that converts policy failures into persistable terminal denials.
 * Invalid caller identity, timestamp, or tool-policy digest still throws because no trustworthy binding can be made.
 */
export function planRunRouteOrDeny(input: {
  runId: string;
  agentId: string;
  catalog: unknown;
  requirements: unknown;
  toolPolicyDigest: string;
  decidedAt: string;
}): RunRoutingReceipt {
  name(input.runId, "ROUTING_RUN_ID_INVALID");
  name(input.agentId, "ROUTING_AGENT_ID_INVALID");
  timestamp(input.decidedAt, "ROUTING_DECIDED_AT_INVALID");
  if (!SHA256.test(input.toolPolicyDigest)) fail("ROUTING_TOOL_POLICY_DIGEST_INVALID");
  let catalog: RoutingCatalog | null = null;
  let requirements: RunRoutingRequirements | null = null;
  try {
    catalog = parseRoutingCatalog(input.catalog);
    requirements = parseRequirements(input.requirements);
    return planRunRoute({...input, catalog, requirements});
  } catch (error) {
    if (!(error instanceof RunRoutingError)) throw error;
    const reason = denialReason(error.code);
    if (!reason) throw error;
    return createRouteDenialReceipt({...input, reason, errorCode: error.code, catalog, requirements});
  }
}

function sha(value: unknown, code = "ROUTING_RECEIPT_SCHEMA_INVALID"): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function literal<T extends string | number | boolean>(value: unknown, expected: T,
  code = "ROUTING_RECEIPT_SCHEMA_INVALID"): T {
  if (value !== expected) fail(code);
  return expected;
}

function parseBinding(raw: unknown, denied: boolean) {
  const value = object(raw, "ROUTING_RECEIPT_SCHEMA_INVALID");
  exact(value, ["runId", "agentId", "toolPolicySha256", "requirementsSha256"], "ROUTING_RECEIPT_SCHEMA_INVALID");
  const requirementsSha256 = denied && value.requirementsSha256 === null
    ? null : sha(value.requirementsSha256);
  return {runId: name(value.runId, "ROUTING_RECEIPT_SCHEMA_INVALID"),
    agentId: name(value.agentId, "ROUTING_RECEIPT_SCHEMA_INVALID"),
    toolPolicySha256: sha(value.toolPolicySha256), requirementsSha256};
}

function parseReceiptCatalog(raw: unknown, denied: boolean) {
  if (denied && raw === null) return null;
  const value = object(raw, "ROUTING_RECEIPT_SCHEMA_INVALID");
  exact(value, denied
    ? ["catalogId", "sourceId", "pricingVersion", "catalogSha256"]
    : ["catalogId", "sourceId", "pricingVersion", "catalogSha256", "publishedAt", "expiresAt"],
  "ROUTING_RECEIPT_SCHEMA_INVALID");
  const base = {catalogId: name(value.catalogId, "ROUTING_RECEIPT_SCHEMA_INVALID"),
    sourceId: name(value.sourceId, "ROUTING_RECEIPT_SCHEMA_INVALID"),
    pricingVersion: name(value.pricingVersion, "ROUTING_RECEIPT_SCHEMA_INVALID"),
    catalogSha256: sha(value.catalogSha256)};
  if (denied) return base;
  const publishedAt = timestamp(value.publishedAt, "ROUTING_RECEIPT_SCHEMA_INVALID");
  const expiresAt = timestamp(value.expiresAt, "ROUTING_RECEIPT_SCHEMA_INVALID");
  if (Date.parse(expiresAt) <= Date.parse(publishedAt)) fail("ROUTING_RECEIPT_SEMANTICS_INVALID");
  return {...base, publishedAt, expiresAt};
}

function parseSelection(raw: unknown): RunRouteReceipt["selection"] {
  const value = object(raw, "ROUTING_RECEIPT_SCHEMA_INVALID");
  exact(value, ["routeId", "provider", "model", "routeSha256", "qualityScore",
    "maxInputTokens", "maxOutputTokens", "capabilities", "pricing"], "ROUTING_RECEIPT_SCHEMA_INVALID");
  const selection = {routeId: name(value.routeId, "ROUTING_RECEIPT_SCHEMA_INVALID"),
    provider: name(value.provider, "ROUTING_RECEIPT_SCHEMA_INVALID"),
    model: name(value.model, "ROUTING_RECEIPT_SCHEMA_INVALID"),
    routeSha256: sha(value.routeSha256),
    qualityScore: safeInteger(value.qualityScore, 1, MAX_QUALITY, "ROUTING_RECEIPT_SCHEMA_INVALID"),
    maxInputTokens: safeInteger(value.maxInputTokens, 1, Number.MAX_SAFE_INTEGER, "ROUTING_RECEIPT_SCHEMA_INVALID"),
    maxOutputTokens: safeInteger(value.maxOutputTokens, 1, Number.MAX_SAFE_INTEGER, "ROUTING_RECEIPT_SCHEMA_INVALID"),
    capabilities: stringSet(value.capabilities, "ROUTING_RECEIPT_SCHEMA_INVALID"),
    pricing: parsePrice(value.pricing)};
  const {routeSha256, ...route} = selection;
  if (routingSha256(route) !== routeSha256) fail("ROUTING_RECEIPT_SEMANTICS_INVALID");
  return selection;
}

function parseReservation(raw: unknown) {
  const value = object(raw, "ROUTING_RECEIPT_SCHEMA_INVALID");
  exact(value, ["inputTokens", "outputTokens", "reservedCostMicrounits"], "ROUTING_RECEIPT_SCHEMA_INVALID");
  return {inputTokens: safeInteger(value.inputTokens, 1, Number.MAX_SAFE_INTEGER, "ROUTING_RECEIPT_SCHEMA_INVALID"),
    outputTokens: safeInteger(value.outputTokens, 1, Number.MAX_SAFE_INTEGER, "ROUTING_RECEIPT_SCHEMA_INVALID"),
    reservedCostMicrounits: safeInteger(value.reservedCostMicrounits, 1, Number.MAX_SAFE_INTEGER,
      "ROUTING_RECEIPT_SCHEMA_INVALID")};
}

function parseUsage(raw: unknown): ReportedRouteUsage {
  const value = object(raw, "ROUTING_RECEIPT_SCHEMA_INVALID");
  exact(value, ["inputTokens", "outputTokens"], "ROUTING_RECEIPT_SCHEMA_INVALID");
  return {inputTokens: safeInteger(value.inputTokens, 0, Number.MAX_SAFE_INTEGER, "ROUTING_RECEIPT_SCHEMA_INVALID"),
    outputTokens: safeInteger(value.outputTokens, 0, Number.MAX_SAFE_INTEGER, "ROUTING_RECEIPT_SCHEMA_INVALID")};
}

function parseSettlement(raw: unknown, reservation: RunRouteReceipt["reservation"],
  selection: RunRouteReceipt["selection"]): RouteSettlement {
  const value = object(raw, "ROUTING_RECEIPT_SCHEMA_INVALID");
  exact(value, ["state", "reason", "usage", "estimatedCostMicrounits", "retainedMinimumCostMicrounits", "releasedCostMicrounits",
    "usageEvidence", "billingProof", "qualityProof"], "ROUTING_RECEIPT_SCHEMA_INVALID");
  const state = value.state;
  if (state !== "settled" && state !== "reconciliation_required") fail("ROUTING_RECEIPT_SCHEMA_INVALID");
  const reason = value.reason;
  if (reason !== "reported_usage_accepted" && reason !== "usage_missing_or_invalid" &&
      reason !== "usage_exceeds_reservation") fail("ROUTING_RECEIPT_SCHEMA_INVALID");
  const usage = value.usage === null ? null : parseUsage(value.usage);
  const estimatedCostMicrounits = value.estimatedCostMicrounits === null ? null
    : safeInteger(value.estimatedCostMicrounits, 1, Number.MAX_SAFE_INTEGER, "ROUTING_RECEIPT_SCHEMA_INVALID");
  const retainedMinimumCostMicrounits = safeInteger(value.retainedMinimumCostMicrounits, 1,
    Number.MAX_SAFE_INTEGER, "ROUTING_RECEIPT_SCHEMA_INVALID");
  const releasedCostMicrounits = safeInteger(value.releasedCostMicrounits, 0, Number.MAX_SAFE_INTEGER,
    "ROUTING_RECEIPT_SCHEMA_INVALID");
  literal(value.billingProof, false); literal(value.qualityProof, false);
  if (state === "settled") {
    if (reason !== "reported_usage_accepted" || !usage || value.usageEvidence !== "reported_unverified" ||
        usage.inputTokens > reservation.inputTokens || usage.outputTokens > reservation.outputTokens) {
      fail("ROUTING_RECEIPT_SEMANTICS_INVALID");
    }
    const route: RoutingCatalogRoute = {...selection};
    const expected = estimateRouteCostMicrounits(route, usage.inputTokens, usage.outputTokens);
    if (estimatedCostMicrounits !== expected || retainedMinimumCostMicrounits !== expected ||
        releasedCostMicrounits !== reservation.reservedCostMicrounits - expected) {
      fail("ROUTING_RECEIPT_SEMANTICS_INVALID");
    }
  } else {
    const missing = reason === "usage_missing_or_invalid" && usage === null && value.usageEvidence === "unavailable";
    const exceeded = reason === "usage_exceeds_reservation" && usage !== null &&
      (usage.inputTokens > reservation.inputTokens || usage.outputTokens > reservation.outputTokens) &&
      value.usageEvidence === "reported_unverified";
    let expectedEstimate: number | null = null;
    if (exceeded && usage) {
      try { expectedEstimate = estimateRouteCostMicrounits(selection, usage.inputTokens, usage.outputTokens); }
      catch (error) { if (!(error instanceof RunRoutingError) || error.code !== "ROUTING_COST_OVERFLOW") throw error; }
    }
    const expectedMinimum = Math.max(reservation.reservedCostMicrounits, expectedEstimate ?? 0);
    if ((!missing && !exceeded) || estimatedCostMicrounits !== expectedEstimate ||
        retainedMinimumCostMicrounits !== expectedMinimum || releasedCostMicrounits !== 0) {
      fail("ROUTING_RECEIPT_SEMANTICS_INVALID");
    }
  }
  return {state, reason, usage, estimatedCostMicrounits, retainedMinimumCostMicrounits, releasedCostMicrounits,
    usageEvidence: value.usageEvidence as RouteSettlement["usageEvidence"], billingProof: false, qualityProof: false};
}

/** Exact-schema, semantic, and digest validation for durable routing data. */
export function parseRunRoutingReceipt(raw: unknown): RunRoutingReceipt {
  const value = object(raw, "ROUTING_RECEIPT_SCHEMA_INVALID");
  if (!SHA256.test(String(value.receiptSha256 ?? ""))) fail("ROUTING_RECEIPT_INTEGRITY_INVALID");
  const {receiptSha256: ignored, ...unsealed} = value;
  if (routingSha256(unsealed) !== value.receiptSha256) fail("ROUTING_RECEIPT_INTEGRITY_INVALID");
  if (value.status === "denied") {
    exact(value, ["version", "status", "binding", "catalog", "reason", "errorCode", "maxAttempts",
      "attemptsUsed", "decidedAt", "proofBoundary", "receiptSha256"], "ROUTING_RECEIPT_SCHEMA_INVALID");
    literal(value.version, 1); literal(value.maxAttempts, 1); literal(value.attemptsUsed, 0);
    const binding = parseBinding(value.binding, true);
    const catalog = parseReceiptCatalog(value.catalog, true) as RunRouteDeniedReceipt["catalog"];
    const reason = value.reason as RouteDenialReason;
    if (!denialReason(String(value.errorCode)) || denialReason(String(value.errorCode)) !== reason) {
      fail("ROUTING_RECEIPT_SEMANTICS_INVALID");
    }
    const receipt: RunRouteDeniedReceipt = {version: 1, status: "denied", binding, catalog, reason,
      errorCode: String(value.errorCode), maxAttempts: 1, attemptsUsed: 0,
      decidedAt: timestamp(value.decidedAt, "ROUTING_RECEIPT_SCHEMA_INVALID"),
      proofBoundary: literal(value.proofBoundary,
        "Terminal host denial; no model dispatch, provider billing, or model-quality proof."),
      receiptSha256: value.receiptSha256 as string};
    return immutable(receipt);
  }
  exact(value, ["version", "status", "binding", "catalog", "requirements", "selection", "reservation",
    "maxAttempts", "attemptsUsed", "decidedAt", "dispatchedAt", "settledAt", "settlement",
    "proofBoundary", "receiptSha256"], "ROUTING_RECEIPT_SCHEMA_INVALID");
  literal(value.version, 1); literal(value.maxAttempts, 1);
  const status = value.status;
  if (status !== "reserved" && status !== "dispatched" && status !== "settled" &&
      status !== "reconciliation_required") fail("ROUTING_RECEIPT_SCHEMA_INVALID");
  const binding = parseBinding(value.binding, false) as RunRouteReceipt["binding"];
  const catalog = parseReceiptCatalog(value.catalog, false) as RunRouteReceipt["catalog"];
  const requirements = immutable(parseRequirements(value.requirements));
  if (routingSha256(requirements) !== binding.requirementsSha256) fail("ROUTING_RECEIPT_SEMANTICS_INVALID");
  const selection = immutable(parseSelection(value.selection));
  const reservation = immutable(parseReservation(value.reservation));
  if (reservation.inputTokens !== requirements.maxInputTokens || reservation.outputTokens !== requirements.maxOutputTokens ||
      selection.qualityScore < requirements.minQualityScore || selection.maxInputTokens < reservation.inputTokens ||
      selection.maxOutputTokens < reservation.outputTokens || requirements.requiredCapabilities.some(capability =>
        !selection.capabilities.includes(capability))) fail("ROUTING_RECEIPT_SEMANTICS_INVALID");
  const expectedReservation = estimateRouteCostMicrounits(selection, reservation.inputTokens, reservation.outputTokens);
  if (reservation.reservedCostMicrounits !== expectedReservation ||
      expectedReservation > requirements.maxReservedCostMicrounits) fail("ROUTING_RECEIPT_SEMANTICS_INVALID");
  const decidedAt = timestamp(value.decidedAt, "ROUTING_RECEIPT_SCHEMA_INVALID");
  if (Date.parse(decidedAt) < Date.parse(catalog.publishedAt) ||
      Date.parse(decidedAt) >= Date.parse(catalog.expiresAt)) {
    fail("ROUTING_RECEIPT_SEMANTICS_INVALID");
  }
  const attemptsUsed = safeInteger(value.attemptsUsed, 0, 1, "ROUTING_RECEIPT_SCHEMA_INVALID") as 0 | 1;
  const dispatchedAt = value.dispatchedAt === null ? null
    : laterTimestamp(value.dispatchedAt, decidedAt, "ROUTING_RECEIPT_SEMANTICS_INVALID");
  const settledAt = value.settledAt === null ? null
    : laterTimestamp(value.settledAt, dispatchedAt ?? decidedAt, "ROUTING_RECEIPT_SEMANTICS_INVALID");
  const settlement = value.settlement === null ? null : parseSettlement(value.settlement, reservation, selection);
  const reservedState = status === "reserved" && attemptsUsed === 0 && !dispatchedAt && !settledAt && !settlement;
  const dispatchedState = status === "dispatched" && attemptsUsed === 1 && !!dispatchedAt && !settledAt && !settlement;
  const terminalState = (status === "settled" || status === "reconciliation_required") && attemptsUsed === 1 &&
    !!dispatchedAt && !!settledAt && settlement?.state === status;
  if (!reservedState && !dispatchedState && !terminalState) fail("ROUTING_RECEIPT_SEMANTICS_INVALID");
  const receipt: RunRouteReceipt = {version: 1, status, binding, catalog, requirements, selection, reservation,
    maxAttempts: 1, attemptsUsed, decidedAt, dispatchedAt, settledAt, settlement,
    proofBoundary: literal(value.proofBoundary,
      "Routing uses host-owned estimates; reported usage is not provider billing or model-quality proof."),
    receiptSha256: value.receiptSha256 as string};
  return immutable(receipt);
}

export function validateRunRoutingReceipt(receipt: unknown): true {
  parseRunRoutingReceipt(receipt);
  return true;
}

export function markRouteDispatched(receipt: RunRouteReceipt, dispatchedAt: string): RunRouteReceipt {
  const parsed = parseRunRoutingReceipt(receipt);
  if (parsed.status === "denied" || parsed.status !== "reserved" || parsed.attemptsUsed !== 0) {
    fail("ROUTING_DISPATCH_STATE_INVALID");
  }
  const at = laterTimestamp(dispatchedAt, parsed.decidedAt, "ROUTING_DISPATCHED_AT_INVALID");
  // Admission may be separated from the actual provider handoff by checkpoint,
  // verifier, or promoter preparation. Never dispatch against a catalog whose
  // host-owned validity window elapsed while that local work was running.
  if (Date.parse(at) >= Date.parse(parsed.catalog.expiresAt)) {
    fail("ROUTING_CATALOG_STALE_BEFORE_DISPATCH");
  }
  return sealReceipt({...withoutReceiptSha256(parsed), status: "dispatched", attemptsUsed: 1, dispatchedAt: at});
}

function reportedUsage(raw: unknown): ReportedRouteUsage | null {
  try {
    const value = object(raw, "ROUTING_USAGE_INVALID");
    exact(value, ["inputTokens", "outputTokens"], "ROUTING_USAGE_INVALID");
    return {inputTokens: safeInteger(value.inputTokens, 0, Number.MAX_SAFE_INTEGER, "ROUTING_USAGE_INVALID"),
      outputTokens: safeInteger(value.outputTokens, 0, Number.MAX_SAFE_INTEGER, "ROUTING_USAGE_INVALID")};
  } catch (error) {
    if (error instanceof RunRoutingError) return null;
    throw error;
  }
}

/** Settle once. Bad or absent usage retains at least the full reservation and requires reconciliation. */
export function settleRunRoute(receipt: RunRouteReceipt, usage: unknown, settledAt: string): RunRouteReceipt {
  const parsedReceipt = parseRunRoutingReceipt(receipt);
  if (parsedReceipt.status === "denied" || parsedReceipt.status !== "dispatched" ||
      parsedReceipt.attemptsUsed !== 1 || !parsedReceipt.dispatchedAt) fail("ROUTING_SETTLEMENT_STATE_INVALID");
  const at = laterTimestamp(settledAt, parsedReceipt.dispatchedAt, "ROUTING_SETTLED_AT_INVALID");
  const parsed = reportedUsage(usage);
  let settlement: RouteSettlement;
  if (!parsed) {
    settlement = {state: "reconciliation_required", reason: "usage_missing_or_invalid", usage: null,
      estimatedCostMicrounits: null, retainedMinimumCostMicrounits: parsedReceipt.reservation.reservedCostMicrounits,
      releasedCostMicrounits: 0,
      usageEvidence: "unavailable", billingProof: false, qualityProof: false};
  } else if (parsed.inputTokens > parsedReceipt.reservation.inputTokens ||
      parsed.outputTokens > parsedReceipt.reservation.outputTokens) {
    let estimatedCostMicrounits: number | null = null;
    try { estimatedCostMicrounits = estimateRouteCostMicrounits(parsedReceipt.selection, parsed.inputTokens, parsed.outputTokens); }
    catch (error) { if (!(error instanceof RunRoutingError) || error.code !== "ROUTING_COST_OVERFLOW") throw error; }
    settlement = {state: "reconciliation_required", reason: "usage_exceeds_reservation", usage: parsed,
      estimatedCostMicrounits,
      retainedMinimumCostMicrounits: Math.max(parsedReceipt.reservation.reservedCostMicrounits,
        estimatedCostMicrounits ?? 0),
      releasedCostMicrounits: 0,
      usageEvidence: "reported_unverified", billingProof: false, qualityProof: false};
  } else {
    const route: RoutingCatalogRoute = {...parsedReceipt.selection,
      maxInputTokens: parsedReceipt.reservation.inputTokens, maxOutputTokens: parsedReceipt.reservation.outputTokens};
    const estimatedCostMicrounits = estimateRouteCostMicrounits(route, parsed.inputTokens, parsed.outputTokens);
    if (estimatedCostMicrounits > parsedReceipt.reservation.reservedCostMicrounits) fail("ROUTING_SETTLEMENT_COST_INVALID");
    settlement = {state: "settled", reason: "reported_usage_accepted", usage: parsed, estimatedCostMicrounits,
      retainedMinimumCostMicrounits: estimatedCostMicrounits,
      releasedCostMicrounits: parsedReceipt.reservation.reservedCostMicrounits - estimatedCostMicrounits,
      usageEvidence: "reported_unverified", billingProof: false, qualityProof: false};
  }
  return sealReceipt({...withoutReceiptSha256(parsedReceipt), status: settlement.state, settledAt: at, settlement});
}
