import type { TaskAcceptance } from "./types.js";

export function taskAcceptance(
  verifierId: string | null,
  status: TaskAcceptance["status"] = verifierId ? "pending" : "not_requested",
  reason: TaskAcceptance["reason"] = verifierId ? "awaiting_verification" : "verifier_not_configured",
): TaskAcceptance {
  return { version: 1, verifierId, status, reason,
    checkedAt: status === "pending" || status === "not_requested" ? null : new Date().toISOString() };
}

export class TaskAcceptanceError extends Error {
  constructor(readonly rejected = false) {
    super(rejected ? "Trusted task verifier rejected this Run" : "Trusted task verifier could not verify this Run");
  }
}
