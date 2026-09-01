import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import { loadJudgeEvidence, type JudgeEvidenceSourceLoader } from "./judge-evidence.js";
import {
  loadDecodeBridgeEvidence,
  type DecodeBridgeEvidenceLoader,
} from "./decodebridge-evidence.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const lifecycleIntentParams = z.object({
  intentId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
});
const lifecycleActionParams = z.object({actionId: z.string().uuid()});
const lifecycleOperatorBody = z.object({
  actionId: z.string().uuid(),
  agentId: z.string().uuid(),
  intentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  ledgerSha256: z.string().regex(/^[0-9a-f]{64}$/),
  evidenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});

export interface CreateAppOptions {
  judgeEvidenceSourceLoader?: JudgeEvidenceSourceLoader;
  decodeBridgeEvidenceLoader?: DecodeBridgeEvidenceLoader;
}

export async function createApp(
  config: AppConfig,
  service: AgentService,
  options: CreateAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  // Register before routes/plugins are booted. The production static plugin
  // otherwise leaves existing API routes with Fastify's generic error shape.
  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/judge-evidence", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      return options.judgeEvidenceSourceLoader
        ? await loadJudgeEvidence(options.judgeEvidenceSourceLoader)
        : await loadJudgeEvidence();
    } catch {
      throw new HttpError(503, "Judge evidence is unavailable");
    }
  });

  app.get("/api/decodebridge-evidence", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      return options.decodeBridgeEvidenceLoader
        ? await options.decodeBridgeEvidenceLoader()
        : await loadDecodeBridgeEvidence();
    } catch {
      throw new HttpError(503, "DecodeBridge evidence is unavailable");
    }
  });

  // Lightweight polling: no CLI/provider availability probe on each refresh.
  app.get("/api/capacity", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return service.runCapacity();
  });

  app.get("/api/workspace-reconciliation", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return service.inspectWorkspaceLifecycleReconciliation();
  });

  app.get("/api/workspace-reconciliation/actions/:actionId", async (request, reply) => {
    const {actionId} = lifecycleActionParams.parse(request.params);
    reply.header("Cache-Control", "no-store");
    return service.getWorkspaceLifecycleOperatorAction(actionId);
  });

  app.post("/api/workspace-reconciliation/:intentId/retry", async (request, reply) => {
    if (!config.authToken) {
      throw new HttpError(503,
        "Operator reconciliation mutations require APP_AUTH_TOKEN to be configured");
    }
    const {intentId} = lifecycleIntentParams.parse(request.params);
    const body = lifecycleOperatorBody.parse(request.body);
    reply.header("Cache-Control", "no-store");
    return service.retryWorkspaceLifecycleIntent({intentId, ...body});
  });

  app.post("/api/workspace-reconciliation/:intentId/cancel", async (request, reply) => {
    if (!config.authToken) {
      throw new HttpError(503,
        "Operator reconciliation mutations require APP_AUTH_TOKEN to be configured");
    }
    const {intentId} = lifecycleIntentParams.parse(request.params);
    const body = lifecycleOperatorBody.parse(request.body);
    reply.header("Cache-Control", "no-store");
    return service.cancelWorkspaceLifecycleIntent({intentId, ...body});
  });

  app.get("/api/agents", async () => ({ agents: service.listAgents() }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content);
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id) };
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
