import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_RUN_HOME_MODE: z.enum(["shared", "run-scoped"]).default("shared"),
  CODEX_NATIVE_TOOL_POLICY: z.enum(["default", "reduced-native"]).default("default"),
  CODEX_PROVIDER_GATE: z.enum(["off", "bounded-video-v1"]).default("off"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  MAX_CONCURRENT_RUNS: z.coerce.number().int().min(1).max(8).default(4),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  MODEL_ROUTING_MODE: z.enum(["off", "least-cost-qualified-v1"]).default("off"),
  MODEL_ROUTING_CATALOG_JSON: z.string().max(65_536).optional(),
  MODEL_ROUTING_MIN_QUALITY_SCORE: z.coerce.number().int().min(1).max(1_000).default(800),
  MODEL_ROUTING_MAX_INPUT_TOKENS: z.coerce.number().int().positive().max(10_000_000).default(100_000),
  MODEL_ROUTING_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(1_000_000).default(10_000),
  MODEL_ROUTING_MAX_COST_MICRO_UNITS: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  MODEL_ROUTING_GLOBAL_BUDGET_MICRO_UNITS: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  MODEL_ROUTING_GLOBAL_BUDGET_EXPIRES_AT: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).optional(),
  WORKSPACE_RESOURCE_MODE: z.enum(["off", "logical-bytes-v1"]).default("off"),
  WORKSPACE_RESOURCE_MAX_RETAINED_BYTES: z.coerce.number().int().positive()
    .max(Number.MAX_SAFE_INTEGER).optional(),
  WORKSPACE_RESOURCE_MAX_GROWTH_PER_RUN_BYTES: z.coerce.number().int().positive()
    .max(Number.MAX_SAFE_INTEGER).optional(),
  DEMO_RUNNER: z.enum(["0", "1"]).default("0"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  if (env.CODEX_PROVIDER_GATE !== "off" && (env.CODEX_NATIVE_TOOL_POLICY !== "reduced-native" ||
      env.CODEX_RUN_HOME_MODE !== "run-scoped" || env.RUNTIME_PROVIDER !== "local-process")) {
    throw new Error("PROVIDER_GATE_REQUIRES_REDUCED_LOCAL_SCOPED");
  }
  if (env.CODEX_NATIVE_TOOL_POLICY !== "default" &&
      (env.CODEX_RUN_HOME_MODE !== "run-scoped" || env.RUNTIME_PROVIDER !== "local-process")) {
    throw new Error("NATIVE_TOOL_POLICY_REQUIRES_LOCAL_RUN_SCOPED");
  }
  const globalBudgetConfigured = env.MODEL_ROUTING_GLOBAL_BUDGET_MICRO_UNITS !== undefined;
  if (globalBudgetConfigured !== (env.MODEL_ROUTING_GLOBAL_BUDGET_EXPIRES_AT !== undefined)) {
    throw new Error("GLOBAL_ROUTING_BUDGET_REQUIRES_LIMIT_AND_EXPIRY");
  }
  if (globalBudgetConfigured && env.MODEL_ROUTING_MODE === "off") {
    throw new Error("GLOBAL_ROUTING_BUDGET_REQUIRES_ROUTING");
  }
  if (env.MODEL_ROUTING_GLOBAL_BUDGET_EXPIRES_AT &&
      new Date(env.MODEL_ROUTING_GLOBAL_BUDGET_EXPIRES_AT).toISOString() !==
        env.MODEL_ROUTING_GLOBAL_BUDGET_EXPIRES_AT) {
    throw new Error("GLOBAL_ROUTING_BUDGET_EXPIRY_INVALID");
  }
  const workspaceRetainedConfigured = env.WORKSPACE_RESOURCE_MAX_RETAINED_BYTES !== undefined;
  const workspaceGrowthConfigured = env.WORKSPACE_RESOURCE_MAX_GROWTH_PER_RUN_BYTES !== undefined;
  if (env.WORKSPACE_RESOURCE_MODE === "off" &&
      (workspaceRetainedConfigured || workspaceGrowthConfigured)) {
    throw new Error("WORKSPACE_RESOURCE_LIMITS_REQUIRE_MODE");
  }
  if (env.WORKSPACE_RESOURCE_MODE !== "off" &&
      (!workspaceRetainedConfigured || !workspaceGrowthConfigured)) {
    throw new Error("WORKSPACE_RESOURCE_MODE_REQUIRES_LIMITS");
  }
  if (env.WORKSPACE_RESOURCE_MODE !== "off" &&
      env.WORKSPACE_RESOURCE_MAX_GROWTH_PER_RUN_BYTES! >
        env.WORKSPACE_RESOURCE_MAX_RETAINED_BYTES!) {
    throw new Error("WORKSPACE_RESOURCE_GROWTH_EXCEEDS_RETAINED");
  }
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 non-placeholder characters for any non-loopback server",
      );
    }
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexRunHomeMode: env.CODEX_RUN_HOME_MODE,
    codexNativeToolPolicy: env.CODEX_NATIVE_TOOL_POLICY,
    codexProviderGate: env.CODEX_PROVIDER_GATE,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    maxConcurrentRuns: env.MAX_CONCURRENT_RUNS,
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel: env.ARK_MODEL?.trim() ?? "",
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    modelRoutingMode: env.MODEL_ROUTING_MODE,
    modelRoutingCatalogJson: env.MODEL_ROUTING_CATALOG_JSON ?? "",
    modelRoutingMinQualityScore: env.MODEL_ROUTING_MIN_QUALITY_SCORE,
    modelRoutingMaxInputTokens: env.MODEL_ROUTING_MAX_INPUT_TOKENS,
    modelRoutingMaxOutputTokens: env.MODEL_ROUTING_MAX_OUTPUT_TOKENS,
    modelRoutingMaxCostMicroUnits: env.MODEL_ROUTING_MAX_COST_MICRO_UNITS ?? null,
    modelRoutingGlobalBudgetMicroUnits: env.MODEL_ROUTING_GLOBAL_BUDGET_MICRO_UNITS ?? null,
    modelRoutingGlobalBudgetExpiresAt: env.MODEL_ROUTING_GLOBAL_BUDGET_EXPIRES_AT ?? null,
    workspaceResourceMode: env.WORKSPACE_RESOURCE_MODE,
    workspaceResourceMaxRetainedBytes: env.WORKSPACE_RESOURCE_MAX_RETAINED_BYTES ?? null,
    workspaceResourceMaxGrowthPerRunBytes: env.WORKSPACE_RESOURCE_MAX_GROWTH_PER_RUN_BYTES ?? null,
    demoRunner: env.DEMO_RUNNER === "1",
    nodeEnv: env.NODE_ENV,
  };
}

export function isArkConfigured(config: AppConfig): boolean {
  return (
    config.arkApiKey.length > 0 &&
    !config.arkApiKey.startsWith("replace-") &&
    config.arkModel.length > 0 &&
    !config.arkModel.includes("replace-")
  );
}

export async function writeCodexConfig(config: AppConfig): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });
  const toml = [
    "# Generated by NerveLoop. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.arkModel || "ep-not-configured"),
    'model_provider = "volcengine_ark"',
    "",
    "[model_providers.volcengine_ark]",
    'name = "Volcengine Ark"',
    "base_url = " + JSON.stringify(config.arkBaseUrl),
    'env_key = "ARK_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}
