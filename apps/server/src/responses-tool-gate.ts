import {createHash, randomBytes} from "node:crypto";
import {createServer, type IncomingMessage} from "node:http";
import type {Socket} from "node:net";

const actions = ["inspect-video-window", "apply-video-boundary", "apply-video-empty", "apply-video-complete", "check-video-window"] as const;
const policy = {version: 1, name: "bounded-video-v1", namespace: "mcp__bounded", tool: "run_action", actions, maxCalls: 3};
const policySha256 = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
const requestLimit = 512_000, responseLimit = 1_048_576;
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OBJECT_REQUIRED");
  return value as RecordValue;
}
function requireValue(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
function identifier(value: unknown): string {
  requireValue(typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value), "IDENTIFIER_INVALID");
  return value;
}
export function gateCatalog(bodyValue: unknown, model: string) {
  const body = object(bodyValue);
  requireValue(body.model === model && body.stream === true, "REQUEST_MODEL_OR_STREAM");
  requireValue(Array.isArray(body.tools) && body.tools.length <= 64, "CATALOG_INVALID");
  let found = false, removed = 0;
  for (const raw of body.tools) {
    const tool = object(raw);
    if (tool.type !== "namespace" || tool.name !== policy.namespace) { removed++; continue; }
    requireValue(!found && Array.isArray(tool.tools) && tool.tools.length === 1, "NAMESPACE_AMBIGUOUS");
    const child = object(tool.tools[0]);
    requireValue(child.type === "function" && child.name === policy.tool, "TOOL_INVALID");
    found = true;
  }
  // Replace the declaration with host-owned arguments; never trust a repository's schema.
  const tools = found ? [{type: "namespace", name: policy.namespace, description: "Reviewed Run-bound video repair actions",
    tools: [{type: "function", name: policy.tool, description: "One reviewed action; independent worker authority is still required",
      strict: true, parameters: {type: "object", properties: {action: {type: "string", enum: [...actions]}}, required: ["action"], additionalProperties: false}}]}] : [];
  return {body: {...body, tools, tool_choice: found ? "auto" : "none", parallel_tool_calls: false, store: false}, callsAllowed: found, removed};
}

function checkedCall(item: RecordValue, allowed: boolean) {
  requireValue(allowed && item.type === "function_call" && item.namespace === policy.namespace && item.name === policy.tool, "TOOL_CALL_DENIED");
  requireValue(typeof item.arguments === "string" && Buffer.byteLength(item.arguments) <= 1024, "ARGUMENTS_INVALID");
  const args = object(JSON.parse(item.arguments));
  requireValue(Object.keys(args).length === 1 && Object.hasOwn(args, "action") && actions.includes(args.action as typeof actions[number]), "ACTION_DENIED");
  return {type: "function_call", id: identifier(item.id), call_id: identifier(item.call_id), name: policy.tool,
    namespace: policy.namespace, arguments: JSON.stringify(args), status: "completed"};
}

/** Buffer first, then emit only rebuilt events. No unvalidated upstream byte reaches the CLI. */
export function validateResponseStream(bytes: Uint8Array, callsAllowed: boolean, model: string) {
  requireValue(bytes.byteLength <= responseLimit, "RESPONSE_TOO_LARGE");
  const text = new TextDecoder("utf-8", {fatal: true}).decode(bytes).replace(/\r\n/g, "\n");
  requireValue(text.endsWith("\n\n"), "STREAM_TRUNCATED");
  let final: RecordValue | undefined, events = 0;
  for (const frame of text.split("\n\n")) {
    if (!frame.trim()) continue;
    requireValue(!final && ++events <= 4096, "STREAM_AFTER_COMPLETION_OR_TOO_MANY_EVENTS");
    const lines = frame.split("\n"), data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    requireValue(data.length > 0, "STREAM_FRAME_INVALID");
    const event = object(JSON.parse(data));
    requireValue(typeof event.type === "string" && event.type.startsWith("response."), "STREAM_EVENT_INVALID");
    requireValue(!["response.failed", "response.incomplete", "response.error"].includes(event.type), "UPSTREAM_INCOMPLETE");
    // A forbidden early item poisons the complete response, even if omitted later.
    if (event.item) {
      const item = object(event.item);
      requireValue(["function_call", "message", "reasoning"].includes(String(item.type)), "OUTPUT_TYPE_DENIED");
      if (item.type === "function_call") {
        requireValue(callsAllowed && item.namespace === policy.namespace && item.name === policy.tool, "TOOL_CALL_DENIED");
      }
    }
    if (event.type === "response.completed") final = object(event.response);
  }
  requireValue(final && final.status === "completed" && Array.isArray(final.output) && final.output.length <= 16, "COMPLETION_REQUIRED");
  requireValue(final.model === model, "UPSTREAM_MODEL_MISMATCH");
  const responseId = identifier(final.id), seen = new Set<string>();
  const output: RecordValue[] = [], calledActions: string[] = [];
  for (const raw of final.output) {
    const item = object(raw);
    if (item.type === "function_call") {
      const call = checkedCall(item, callsAllowed);
      requireValue(!seen.has(call.call_id), "DUPLICATE_CALL"); seen.add(call.call_id);
      calledActions.push(JSON.parse(call.arguments).action); output.push(call);
    } else if (item.type === "message") {
      requireValue(item.role === "assistant" && Array.isArray(item.content) && item.content.length <= 32, "MESSAGE_INVALID");
      const content = item.content.map(rawPart => {
        const part = object(rawPart);
        requireValue(part.type === "output_text" && typeof part.text === "string", "MESSAGE_CONTENT_DENIED");
        return {type: "output_text", text: part.text, annotations: []};
      });
      output.push({type: "message", id: identifier(item.id), role: "assistant", status: "completed", content});
    } else {
      // Reasoning items are not replayed as executable protocol. Their provider
      // session compatibility is deliberately unproven for this opt-in profile.
      requireValue(item.type === "reasoning", "OUTPUT_TYPE_DENIED");
    }
  }
  requireValue(calledActions.length <= 1 && output.length > 0, "OUTPUT_BUDGET");
  const usage = final.usage === undefined ? undefined : object(final.usage);
  if (usage) for (const key of ["input_tokens", "output_tokens", "total_tokens"]) {
    requireValue(Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0, "USAGE_INVALID");
  }
  const response = {id: responseId, object: "response", status: "completed", model, output,
    ...(usage ? {usage: {input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, total_tokens: usage.total_tokens}} : {})};
  const emitted: RecordValue[] = [{type: "response.created", response: {...response, status: "in_progress", output: []}}];
  for (const [output_index, item] of output.entries()) {
    emitted.push({type: "response.output_item.added", response_id: responseId, output_index, item: {...item, status: "in_progress"}});
    if (item.type === "message") for (const [content_index, part] of (item.content as Array<{text: string}>).entries()) {
      emitted.push({type: "response.output_text.delta", response_id: responseId, item_id: item.id, output_index, content_index, delta: part.text});
    }
    emitted.push({type: "response.output_item.done", response_id: responseId, output_index, item});
  }
  emitted.push({type: "response.completed", response});
  return {bytes: Buffer.from(emitted.map((event, sequence_number) => `data: ${JSON.stringify({...event, sequence_number})}\n\n`).join("")), calledActions, callIds: [...seen]};
}

async function boundedBody(source: AsyncIterable<Uint8Array>, max: number, signal: AbortSignal) {
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of source) {
    signal.throwIfAborted(); size += chunk.byteLength; requireValue(size <= max, "BODY_TOO_LARGE"); chunks.push(chunk);
  }
  signal.throwIfAborted(); return Buffer.concat(chunks);
}

export interface ToolGateOptions {
  runId: string; agentId: string; model: string; upstreamBaseUrl: string; apiKey: string;
  signal?: AbortSignal; timeoutMs?: number;
}

export async function startResponsesToolGate(options: ToolGateOptions) {
  identifier(options.runId); identifier(options.agentId);
  const upstream = new URL(options.upstreamBaseUrl.replace(/\/+$/, "") + "/responses");
  requireValue(!upstream.username && !upstream.password && !upstream.search && !upstream.hash &&
    (upstream.protocol === "https:" || (upstream.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(upstream.hostname))), "UPSTREAM_URL_DENIED");
  const token = randomBytes(32).toString("hex"), route = "/" + randomBytes(24).toString("hex") + "/v1";
  const audit: Array<RecordValue> = [], sockets = new Set<Socket>(), controllers = new Set<AbortController>();
  const pending = new Set<Promise<void>>();
  const issuedCallIds = new Set<string>();
  let busy = false, poisoned = false, closed = false, requests = 0, calls = 0, patches = 0;
  const server = createServer(async (request: IncomingMessage, response) => {
    let settled!: () => void;
    const task = new Promise<void>(resolve => { settled = resolve; }); pending.add(task);
    const controller = new AbortController(); controllers.add(controller);
    const abortRead = () => { if (!request.complete) request.destroy(); };
    controller.signal.addEventListener("abort", abortRead, {once: true});
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000); timer.unref();
    const abort = () => controller.abort(); request.once("aborted", abort);
    const disconnect = () => { if (!response.writableEnded) controller.abort(); }; response.once("close", disconnect);
    let admitted = false;
    try {
      requireValue(!closed && !poisoned && !busy && requests < 8, "GATE_CLOSED_BUSY_OR_EXHAUSTED");
      requireValue(request.method === "POST" && request.url === route + "/responses" &&
        request.headers.authorization === "Bearer " + token && !request.headers.origin, "REQUEST_AUTH_DENIED");
      busy = true; admitted = true; requests++;
      const body = JSON.parse((await boundedBody(request, requestLimit, controller.signal)).toString("utf8"));
      const selected = gateCatalog(body, options.model);
      const upstreamResponse = await fetch(upstream, {method: "POST", redirect: "error", signal: controller.signal,
        headers: {"content-type": "application/json", authorization: "Bearer " + options.apiKey}, body: JSON.stringify(selected.body)});
      requireValue(upstreamResponse.ok && upstreamResponse.headers.get("content-type")?.startsWith("text/event-stream") && upstreamResponse.body, "UPSTREAM_RESPONSE_INVALID");
      const raw = await boundedBody(upstreamResponse.body, responseLimit, controller.signal);
      const result = validateResponseStream(raw, selected.callsAllowed, options.model);
      requireValue(result.callIds.every(id => !issuedCallIds.has(id)), "REPLAYED_CALL_ID");
      const newPatches = result.calledActions.filter(action => action.startsWith("apply-")).length;
      requireValue(calls + result.calledActions.length <= policy.maxCalls && patches + newPatches <= 1, "RUN_CALL_BUDGET");
      calls += result.calledActions.length; patches += newPatches;
      for (const id of result.callIds) issuedCallIds.add(id);
      controller.signal.throwIfAborted();
      audit.push({sequence: requests, verdict: "allowed", removedDeclarations: selected.removed,
        requestBytes: Buffer.byteLength(JSON.stringify(selected.body)), responseBytes: raw.length, calls: result.calledActions.length});
      response.writeHead(200, {"content-type": "text/event-stream", "cache-control": "no-store"}); response.end(result.bytes);
    } catch (error) {
      if (admitted) { poisoned = true; audit.push({sequence: requests, verdict: "denied", reason: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "GATE_VALIDATION_FAILED"}); }
      if (!response.destroyed) { response.writeHead(403, {"content-type": "application/json"}); response.end(JSON.stringify({error: {message: "Run tool policy denied this response", type: "tool_policy_denied"}})); }
    } finally {
      controller.abort(); clearTimeout(timer); controllers.delete(controller); request.off("aborted", abort); response.off("close", disconnect);
      if (admitted) busy = false;
      pending.delete(task); settled();
    }
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.requestTimeout = 20_000; server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); requireValue(address && typeof address === "object", "LISTEN_FAILED");
  const close = async () => {
    closed = true; for (const controller of controllers) controller.abort(); for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.all([...pending]);
    options.signal?.removeEventListener("abort", onAbort);
  };
  const onAbort = () => { void close(); };
  options.signal?.addEventListener("abort", onAbort, {once: true});
  if (options.signal?.aborted) await close();
  return {baseUrl: `http://127.0.0.1:${address.port}${route}`, apiKey: token, close,
    receipt: () => ({version: 1, runId: options.runId, agentId: options.agentId, policy: policy.name, policySha256,
      requests, calls, patches, poisoned, closed, audit: structuredClone(audit),
      boundary: "Buffered Responses protocol gate; not OS egress isolation, MCP server authentication or model-quality proof"})};
}
