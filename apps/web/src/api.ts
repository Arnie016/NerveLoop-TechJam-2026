import type {
  Agent,
  AgentRun,
  DecodeBridgeEvidenceSummary,
  JudgeEvidenceSummary,
  Message,
  SystemInfo,
  WorkspaceLifecycleOperatorResult,
  WorkspaceLifecycleReconciliationItem,
  WorkspaceLifecycleReconciliationReport,
} from "./types";
import type { RunCapacity } from "./capacity-monitor";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  judgeEvidence: (signal?: AbortSignal) =>
    request<JudgeEvidenceSummary>("/api/judge-evidence", { signal, cache: "no-store" }),
  decodeBridgeEvidence: (signal?: AbortSignal) =>
    request<DecodeBridgeEvidenceSummary>("/api/decodebridge-evidence", {
      signal,
      cache: "no-store",
    }),
  capacity: (signal: AbortSignal) => request<RunCapacity>("/api/capacity", { signal, cache: "no-store" }),
  workspaceReconciliation: () =>
    request<WorkspaceLifecycleReconciliationReport>("/api/workspace-reconciliation", {cache: "no-store"}),
  workspaceReconciliationAction: (actionId: string) =>
    request<WorkspaceLifecycleOperatorResult>(
      "/api/workspace-reconciliation/actions/" + encodeURIComponent(actionId), {cache: "no-store"}),
  resumeWorkspaceLifecycleAction: (pending: {
    actionId: string;
    action: "retry" | "cancel";
    intentId: string;
    agentId: string;
    intentSha256: string;
    ledgerSha256: string;
    evidenceSha256: string;
  }) => request<WorkspaceLifecycleOperatorResult>(
    "/api/workspace-reconciliation/" + encodeURIComponent(pending.intentId) + "/" + pending.action,
    {
      method: "POST",
      body: JSON.stringify({
        actionId: pending.actionId,
        agentId: pending.agentId,
        intentSha256: pending.intentSha256,
        ledgerSha256: pending.ledgerSha256,
        evidenceSha256: pending.evidenceSha256,
      }),
    },
  ),
  retryWorkspaceLifecycle: (
    report: WorkspaceLifecycleReconciliationReport,
    intent: WorkspaceLifecycleReconciliationItem,
    actionId: string,
  ) => request<WorkspaceLifecycleOperatorResult>(
    "/api/workspace-reconciliation/" + intent.intentId + "/retry",
    {
      method: "POST",
      body: JSON.stringify({
        actionId,
        agentId: intent.agentId,
        intentSha256: intent.intentSha256,
        ledgerSha256: report.ledgerSha256,
        evidenceSha256: intent.evidenceSha256,
      }),
    },
  ),
  cancelWorkspaceLifecycle: (
    report: WorkspaceLifecycleReconciliationReport,
    intent: WorkspaceLifecycleReconciliationItem,
    actionId: string,
  ) => request<WorkspaceLifecycleOperatorResult>(
    "/api/workspace-reconciliation/" + intent.intentId + "/cancel",
    {
      method: "POST",
      body: JSON.stringify({
        actionId,
        agentId: intent.agentId,
        intentSha256: intent.intentSha256,
        ledgerSha256: report.ledgerSha256,
        evidenceSha256: intent.evidenceSha256,
      }),
    },
  ),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
};
