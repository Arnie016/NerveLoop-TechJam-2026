import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import type {
  Agent,
  AgentRun,
  GlobalSyntheticBudgetInfo,
  Message,
  SystemInfo,
  WorkspaceLifecycleReconciliationItem,
  WorkspaceLifecycleReconciliationReport,
  WorkspaceResourceInfo,
} from "./types";
import { createCapacityMonitor, type CapacityState } from "./capacity-monitor";
import { JudgeEvidencePanel } from "./JudgeEvidencePanel";
import { DecodeBridgeEvidencePanel } from "./DecodeBridgeEvidencePanel";
import { RunCapacityIndicator } from "./RunCapacity";
import { EffectFirewallStory } from "./EffectFirewallStory";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const fixturePrompts = [
  "Run the Effect Firewall delete-asset fixture.",
  "Run the retained workspace-change fixture.",
  "Run the protected-path denial fixture.",
  "Run the recovery-failure fixture (locks this Agent).",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

const pendingWorkspaceActionKey = "launchpad.pending-workspace-operator-action.v1";

interface PendingWorkspaceAction {
  version: 1;
  actionId: string;
  action: "retry" | "cancel";
  intentId: string;
  agentId: string;
  intentSha256: string;
  ledgerSha256: string;
  evidenceSha256: string;
}

function storePendingWorkspaceAction(action: PendingWorkspaceAction): void {
  try { window.sessionStorage.setItem(pendingWorkspaceActionKey, JSON.stringify(action)); } catch { /* memory-only */ }
}

function loadPendingWorkspaceAction(): PendingWorkspaceAction | null {
  try {
    const raw = window.sessionStorage.getItem(pendingWorkspaceActionKey);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingWorkspaceAction>;
    if (value.version !== 1 || (value.action !== "retry" && value.action !== "cancel") ||
        typeof value.actionId !== "string" || typeof value.intentId !== "string" ||
        typeof value.agentId !== "string" || typeof value.intentSha256 !== "string" ||
        typeof value.ledgerSha256 !== "string" || typeof value.evidenceSha256 !== "string") return null;
    return value as PendingWorkspaceAction;
  } catch { return null; }
}

function clearPendingWorkspaceAction(actionId: string): void {
  try {
    const pending = loadPendingWorkspaceAction();
    if (pending?.actionId === actionId) window.sessionStorage.removeItem(pendingWorkspaceActionKey);
  } catch { /* memory-only */ }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

function syntheticAmount(value: string): string {
  try {
    return BigInt(value).toLocaleString() + " µu";
  } catch {
    return "Unavailable";
  }
}

function expiry(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" : new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium", timeStyle: "short",
  }).format(date);
}

function SyntheticBudgetPanel({budget}: {budget: GlobalSyntheticBudgetInfo | undefined}) {
  if (!budget || !budget.configured) {
    return (
      <section className="budget-panel budget-unconfigured" aria-label="Global synthetic budget">
        <div className="budget-heading">
          <div><span className="eyebrow">Global synthetic budget</span><strong>Unconfigured</strong></div>
          <span className="budget-state">Admission layer off</span>
        </div>
        <div className="budget-empty-metrics" aria-label="Unavailable budget metrics">
          <span>Limit · not set</span><span>Retained minimum · not set</span>
          <span>Active reserved · not set</span><span>Available · not set</span>
          <span>Overage · not set</span><span>Reconciliation · not set</span><span>Expiry · not set</span>
        </div>
        <small>{budget?.boundary ?? "No deployment-local synthetic routing budget is configured."}</small>
      </section>
    );
  }
  const state = budget.overLimit ? "Overage retained" : budget.expired ? "Expired · no new reservations" : "Configured";
  return (
    <section className={"budget-panel" + (budget.overLimit ? " budget-over" : budget.expired ? " budget-expired" : "")}
      aria-label="Global synthetic budget" aria-live="polite">
      <div className="budget-heading">
        <div><span className="eyebrow">Global synthetic budget</span><strong>{budget.policyId}</strong></div>
        <span className="budget-state">{state}</span>
      </div>
      <dl className="budget-metrics">
        <div><dt>Limit</dt><dd>{syntheticAmount(budget.limitMicrounits)}</dd></div>
        <div><dt>Retained minimum</dt><dd>{syntheticAmount(budget.retainedMinimumMicrounits)}</dd></div>
        <div><dt>Active reserved</dt><dd>{syntheticAmount(budget.activeReservedMicrounits)}</dd></div>
        <div><dt>Available</dt><dd>{syntheticAmount(budget.availableForNewReservationsMicrounits)}</dd></div>
        <div><dt>Overage</dt><dd>{syntheticAmount(budget.overageMicrounits)}</dd></div>
        <div><dt>Reconciliation</dt><dd>{budget.reconciliationEntries.toLocaleString()} Run{budget.reconciliationEntries === 1 ? "" : "s"}</dd></div>
        <div className="budget-expiry"><dt>Expiry</dt><dd>{expiry(budget.expiresAt)}</dd></div>
      </dl>
      <small>{budget.boundary}. Values are retained synthetic estimates, never money, provider quota, billed usage, or quality evidence.</small>
    </section>
  );
}

function byteAmount(value: string): string {
  try {
    const bytes = BigInt(value);
    if (bytes < 1024n) return bytes.toLocaleString() + " B";
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let scaled = Number(bytes);
    let unit = "B";
    for (const candidate of units) {
      scaled /= 1024;
      unit = candidate;
      if (scaled < 1024) break;
    }
    return scaled.toLocaleString(undefined, {maximumFractionDigits: 1}) + " " + unit;
  } catch {
    return "Unavailable";
  }
}

function WorkspaceResourcePanel({resources}: {resources: WorkspaceResourceInfo | undefined}) {
  if (!resources || !resources.configured) {
    return (
      <section className="budget-panel budget-unconfigured" aria-label="Workspace lifecycle capacity">
        <div className="budget-heading">
          <div><span className="eyebrow">Workspace lifecycle capacity</span><strong>Unconfigured</strong></div>
          <span className="budget-state">Logical-byte admission off</span>
        </div>
        <small>{resources?.boundary ?? "No workspace lifecycle admission policy is configured."}</small>
      </section>
    );
  }
  const over = BigInt(resources.overageBytes) > 0n;
  const state = resources.reconciliationRequired ? "Fail closed · reconciliation" : over ? "Overage retained" : "Configured";
  return (
    <section className={"budget-panel" + (over || resources.reconciliationRequired ? " budget-over" : "")}
      aria-label="Workspace lifecycle capacity" aria-live="polite">
      <div className="budget-heading">
        <div><span className="eyebrow">Workspace lifecycle capacity</span><strong>{resources.policyId}</strong></div>
        <span className="budget-state">{state}</span>
      </div>
      <dl className="budget-metrics">
        <div><dt>Retained limit</dt><dd>{byteAmount(resources.maxRetainedBytes)}</dd></div>
        <div><dt>Retained now</dt><dd>{byteAmount(resources.retainedBytes)}</dd></div>
        <div><dt>Run reservations</dt><dd>{byteAmount(resources.reservedGrowthBytes)}</dd></div>
        <div><dt>Lifecycle staging</dt><dd>{byteAmount(resources.lifecycleReservedBytes)}</dd></div>
        <div><dt>Available</dt><dd>{byteAmount(resources.availableForNewReservationsBytes)}</dd></div>
        <div><dt>Overage</dt><dd>{byteAmount(resources.overageBytes)}</dd></div>
        <div><dt>Per-Run ceiling</dt><dd>{byteAmount(resources.maxGrowthPerRunBytes)}</dd></div>
        <div><dt>Inventories</dt><dd>{resources.activeInventories} active · {resources.archivedInventories} archived · {resources.quarantineInventories} quarantine</dd></div>
        <div><dt>Uncertain Runs</dt><dd>{resources.reconciliationReservations}</dd></div>
        <div><dt>Lifecycle intents</dt><dd>{resources.preparedLifecycleIntents} prepared · {resources.reconciliationLifecycleIntents} reconcile</dd></div>
      </dl>
      <small>{resources.boundary}. Incomplete scans expose zero new headroom.</small>
    </section>
  );
}

function shortDigest(value: string | null): string {
  return value ? value.slice(0, 12) : "none";
}

function runGuardEventLabel(kind: string): string {
  if (kind === "grant_issued") return "RunGuard scope initialized";
  if (kind === "grant_denied") return "RunGuard scope denied";
  return kind.replaceAll("_", " ");
}

function runGuardEventDetail(kind: string, detail: string): string {
  if (kind === "grant_issued") {
    return "Workspace-only RunGuard scope prepared. This event did not issue an Effect Capability.";
  }
  return detail;
}

function WorkspaceReconciliationPanel({
  report,
  actingIntentId,
  onRefresh,
  onRetry,
  onCancel,
  notice,
}: {
  report: WorkspaceLifecycleReconciliationReport | null;
  actingIntentId: string | null;
  onRefresh: () => void;
  onRetry: (intent: WorkspaceLifecycleReconciliationItem) => void;
  onCancel: (intent: WorkspaceLifecycleReconciliationItem) => void;
  notice: string | null;
}) {
  if (!report?.reconciliationRequired && !report?.intents.length && !report?.recentActions.length) return null;
  return (
    <section className="budget-panel reconciliation-panel budget-over"
      aria-label="Workspace lifecycle reconciliation" aria-live="polite">
      <div className="budget-heading">
        <div>
          <span className="eyebrow">Operator reconciliation</span>
          <strong>{report?.intents.length ?? 0} sealed lifecycle intent{report?.intents.length === 1 ? "" : "s"}</strong>
        </div>
        <button className="capacity-refresh" onClick={onRefresh} disabled={actingIntentId !== null}>
          Re-inspect
        </button>
      </div>
      {report?.recentActions.length ? (
        <div className="reconciliation-receipts" aria-label="Recent durable operator receipts">
          {report.recentActions.slice(-3).reverse().map(action => (
            <small key={action.actionId}>
              {action.action} · {action.outcome ?? "accepted"} · action {shortDigest(action.actionId)} · receipt {shortDigest(action.receiptSha256)}
            </small>
          ))}
        </div>
      ) : null}
      <div className="reconciliation-list">
        {report?.intents.map(intent => {
          const acting = actingIntentId === intent.intentId;
          return (
            <article className="reconciliation-item" key={intent.intentId}>
              <div className="reconciliation-copy">
                <strong>{intent.kind.replace("instruction_update", "instruction update")}</strong>
                <span>{intent.probeState.replaceAll("_", " ")} · Agent {intent.agentId.slice(0, 8)}</span>
                <small>
                  Intent {shortDigest(intent.intentSha256)} · evidence {shortDigest(intent.evidenceSha256)}
                  {intent.observedBytes ? " · observed " + byteAmount(intent.observedBytes) : ""}
                </small>
              </div>
              <div className="reconciliation-actions">
                {intent.retryAvailable ? (
                  <button className="button button-primary" disabled={acting || !report.mutationsEnabled}
                    onClick={() => onRetry(intent)}>{acting ? <Spinner /> : "Retry exact recovery"}</button>
                ) : null}
                {intent.cancelAvailable ? (
                  <button className="button button-ghost" disabled={acting || !report.mutationsEnabled}
                    onClick={() => onCancel(intent)}>Cancel untouched intent</button>
                ) : null}
                {!intent.retryAvailable && !intent.cancelAvailable ? (
                  <span className="manual-review">Manual host review · no automated mutation</span>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
      {!report?.mutationsEnabled ? (
        <small>Inspection is read-only. Configure APP_AUTH_TOKEN before operator mutations are enabled.</small>
      ) : null}
      {notice ? <small className="reconciliation-notice">{notice}</small> : null}
      <small>{report?.boundary}. Ledger {shortDigest(report?.ledgerSha256 ?? null)}.</small>
    </section>
  );
}

function VideoIncidentRoom() {
  const asset = (name: string) => `/demo/video-incident/${name}`;
  return (
    <section className="video-incident" aria-labelledby="video-incident-title">
      <header className="video-incident-heading">
        <div>
          <span className="incident-kicker"><span /> Real-media evidence replay</span>
          <h2 id="video-incident-title">The cut looked valid. It was wrong.</h2>
          <p>
            A boundary bug returned the entire six-second MP4 instead of the requested
            green, 880 Hz interval. The repaired candidate is retained only after decoded
            video and audio agree with an independent reference.
          </p>
        </div>
        <div className="incident-verdict" aria-label="Repair verdict">
          <span>Verifier verdict</span>
          <strong>Repair accepted</strong>
          <small>6 of 6 checks</small>
        </div>
      </header>

      <div className="incident-media-grid">
        <figure className="incident-media incident-media-broken">
          <figcaption>
            <span>Baseline output</span>
            <strong>Rejected · 0–6.0 s</strong>
          </figcaption>
          <video controls muted playsInline preload="metadata" poster={asset("broken-poster.jpg")}
            aria-label="Rejected six-second baseline video">
            <source src={asset("broken.mp4")} type="video/mp4" />
          </video>
          <div className="media-timeline" aria-label="Rejected output includes red, green, and blue intervals">
            <span className="media-red">0–2</span><span className="media-green">2–4</span><span className="media-blue">4–6</span>
          </div>
          <p>Inclusive overlap accidentally admitted both boundary-touching segments.</p>
        </figure>

        <figure className="incident-media incident-media-fixed">
          <figcaption>
            <span>Repaired output</span>
            <strong>Accepted · 2.0–4.0 s</strong>
          </figcaption>
          <video controls muted playsInline preload="metadata" poster={asset("repaired-poster.jpg")}
            aria-label="Accepted two-second repaired video">
            <source src={asset("repaired.mp4")} type="video/mp4" />
          </video>
          <div className="media-timeline media-timeline-fixed" aria-label="Accepted output contains only the green interval">
            <span className="media-green">60 decoded frames</span>
          </div>
          <p>Strict half-open overlap retains only the requested green/880 Hz interval.</p>
        </figure>
      </div>

      <div className="incident-proof">
        <ol className="incident-loop" aria-label="Verified engineering loop">
          <li><span>01</span><div><strong>Inspect</strong><small>MP4 streams, duration, frames and PCM audio</small></div></li>
          <li><span>02</span><div><strong>Reproduce</strong><small>Boundary request expands from 2 s to 6 s</small></div></li>
          <li><span>03</span><div><strong>Contain</strong><small>One reviewed source file, digest-bound repair</small></div></li>
          <li><span>04</span><div><strong>Verify</strong><small>Frame hashes and 96,256 audio sample frames</small></div></li>
          <li><span>05</span><div><strong>Retain</strong><small>Accepted candidate; wrong-scene control denied</small></div></li>
        </ol>
        <aside className="incident-boundary">
          <span>What this proves</span>
          <strong>Real decoded-media correctness</strong>
          <p>Deterministic local MP4 fixture. No semantic vision, compression claim, model-discovered repair, TikTok data, or production-scale result.</p>
          <a href={asset("receipt.json")} target="_blank" rel="noreferrer">Open signed evidence receipt ↗</a>
        </aside>
      </div>
    </section>
  );
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [reconciliation, setReconciliation] =
    useState<WorkspaceLifecycleReconciliationReport | null>(null);
  const [reconciliationBusy, setReconciliationBusy] = useState<string | null>(null);
  const [reconciliationNotice, setReconciliationNotice] = useState<string | null>(null);
  const [capacity, setCapacity] = useState<CapacityState>({ kind: "checking" });
  const [submitting, setSubmitting] = useState(false);
  const sendPending = useRef(false);
  const capacityMonitor = useRef<ReturnType<typeof createCapacityMonitor> | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [evidenceVaultOpen, setEvidenceVaultOpen] = useState(false);
  const [runtimeEvidenceOpen, setRuntimeEvidenceOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [agentRuns, setAgentRuns] = useState<AgentRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;
  const capacityFull = capacity.kind === "ready" && capacity.capacity.available === 0;
  const refreshCapacity = useCallback(() => { void capacityMonitor.current?.refresh(); }, []);

  useEffect(() => {
    if (authRequired !== false) return;
    const monitor = createCapacityMonitor(api.capacity, setCapacity);
    capacityMonitor.current = monitor;
    void monitor.refresh();
    const visible = () => { if (document.visibilityState === "visible") void monitor.refresh(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", refreshCapacity);
    return () => {
      monitor.stop();
      capacityMonitor.current = null;
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", refreshCapacity);
    };
  }, [authRequired, refreshCapacity]);

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshReconciliation = useCallback(async () => {
    const next = await api.workspaceReconciliation();
    if (mountedRef.current) setReconciliation(next);
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem), refreshReconciliation()]);
    const pending = loadPendingWorkspaceAction();
    if (!pending) return;
    try {
      const result = await api.workspaceReconciliationAction(pending.actionId);
      setReconciliation(result.reconciliation);
      setReconciliationNotice(`${result.action.action} ${result.outcome} · durable action ${shortDigest(result.action.actionId)}`);
      if (result.action.status === "terminal") clearPendingWorkspaceAction(pending.actionId);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 404) {
        try {
          const resumed = await api.resumeWorkspaceLifecycleAction(pending);
          setReconciliation(resumed.reconciliation);
          setReconciliationNotice(`${resumed.action.action} ${resumed.outcome} · recovered action ${shortDigest(resumed.action.actionId)}`);
          if (resumed.action.status === "terminal") clearPendingWorkspaceAction(pending.actionId);
        } catch {
          setReconciliationNotice(`Action ${shortDigest(pending.actionId)} has no confirmed terminal receipt; the same action binding is retained for recovery.`);
        }
      }
    }
  }, [refreshAgents, refreshReconciliation]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setAgentRuns([]);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        setAgentRuns(result.runs);
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    const messagePane = messageEnd.current?.parentElement;
    messagePane?.scrollTo({ top: messagePane.scrollHeight, behavior: "smooth" });
  }, [messages, activeRun]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      refreshCapacity();
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const reconcileLifecycle = async (
    intent: WorkspaceLifecycleReconciliationItem,
    action: "retry" | "cancel",
  ) => {
    if (!reconciliation?.ledgerSha256 || reconciliationBusy) return;
    const confirmed = window.confirm(action === "retry"
      ? "Retry this exact sealed lifecycle operation? The server will re-probe its evidence before acting."
      : "Cancel this untouched intent? No filesystem path will be deleted.");
    if (!confirmed) return;
    const actionId = crypto.randomUUID();
    const pending: PendingWorkspaceAction = {
      version: 1,
      actionId,
      action,
      intentId: intent.intentId,
      agentId: intent.agentId,
      intentSha256: intent.intentSha256,
      ledgerSha256: reconciliation.ledgerSha256,
      evidenceSha256: intent.evidenceSha256,
    };
    storePendingWorkspaceAction(pending);
    setReconciliationBusy(intent.intentId);
    setReconciliationNotice(`Submitting durable ${action} action ${shortDigest(actionId)}…`);
    setError(null);
    try {
      const result = action === "retry"
        ? await api.retryWorkspaceLifecycle(reconciliation, intent, actionId)
        : await api.cancelWorkspaceLifecycle(reconciliation, intent, actionId);
      setReconciliation(result.reconciliation);
      setReconciliationNotice(`${result.action.action} ${result.outcome} · durable action ${shortDigest(result.action.actionId)}`);
      if (result.action.status === "terminal") clearPendingWorkspaceAction(actionId);
      await Promise.all([refreshAgents(), api.system().then(setSystem)]);
    } catch (reason) {
      try {
        const recovered = await api.workspaceReconciliationAction(actionId);
        setReconciliation(recovered.reconciliation);
        setReconciliationNotice(`${recovered.action.action} ${recovered.outcome} · recovered action ${shortDigest(actionId)}`);
        if (recovered.action.status === "terminal") clearPendingWorkspaceAction(actionId);
        await Promise.all([refreshAgents(), api.system().then(setSystem)]);
      } catch (lookupReason) {
        if (lookupReason instanceof ApiError && lookupReason.status === 404) {
          try {
            const resumed = await api.resumeWorkspaceLifecycleAction(pending);
            setReconciliation(resumed.reconciliation);
            setReconciliationNotice(`${resumed.action.action} ${resumed.outcome} · replayed action ${shortDigest(actionId)}`);
            if (resumed.action.status === "terminal") clearPendingWorkspaceAction(actionId);
          } catch (resumeReason) {
            setError(resumeReason instanceof Error ? resumeReason.message : String(resumeReason));
            setReconciliationNotice(`Action ${shortDigest(actionId)} remains unconfirmed; its exact binding is retained in this browser session.`);
          }
        } else {
          setError(reason instanceof Error ? reason.message : String(reason));
          setReconciliationNotice(`Action ${shortDigest(actionId)} remains unconfirmed; its exact binding is retained in this browser session.`);
        }
        await refreshReconciliation().catch(() => undefined);
      }
    } finally {
      setReconciliationBusy(null);
      refreshCapacity();
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    let observedRouteStatus: AgentRun["route"] extends {status: infer Status} ? Status | null : string | null = null;
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        const routeStatus = result.run.route?.status ?? null;
        if (routeStatus !== observedRouteStatus) {
          observedRouteStatus = routeStatus;
          const nextSystem = await api.system();
          if (mountedRef.current) setSystem(nextSystem);
        }
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          const [, , runList] = await Promise.all([
            refreshMessages(agentId),
            refreshAgents(),
            api.runs(agentId),
          ]);
          if (mountedRef.current && selectedIdRef.current === agentId) setAgentRuns(runList.runs);
          refreshCapacity();
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim() || sendPending.current || capacityFull || selected.recoveryHold ||
        selected.status === "stopped" || selected.status === "busy" ||
        activeRun && ["queued", "running"].includes(activeRun.status)) return;
    const draft = prompt;
    const content = prompt.trim();
    sendPending.current = true;
    setSubmitting(true);
    setError(null);
    let acceptedRunId: string | null = null;
    try {
      const result = await api.sendMessage(selected.id, content);
      acceptedRunId = result.run.id;
      if (selectedIdRef.current === selected.id) {
        setPrompt(current => current === draft ? "" : current);
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
        setAgentRuns(current => [result.run, ...current.filter(run => run.id !== result.run.id)]);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      void api.system().then(next => { if (mountedRef.current) setSystem(next); }).catch(() => undefined);
    } catch (reason) {
      // Rejected admission must not erase the draft or the previous Run receipt.
      // A transport failure is different: the server may have accepted the Run.
      setError(reason instanceof ApiError
        ? reason.message
        : "Send result is unconfirmed. Your draft is kept; check this Agent's Runs before retrying.");
      await refreshAgents().catch(() => undefined);
    } finally {
      sendPending.current = false;
      setSubmitting(false);
      refreshCapacity();
    }
    if (acceptedRunId) {
      await pollRun(acceptedRunId, selected.id).catch(() => {
        setError("Could not refresh the accepted Run. It may still be active; do not resubmit automatically.");
      });
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">N</div>
          <span className="eyebrow">NerveLoop</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">N</div>
          <span className="eyebrow">NerveLoop</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">N</div>
          <div>
            <strong>NerveLoop</strong>
            <span>
              {system?.demoRunner
                ? "RunGuard · no-model fixture"
                : system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          aria-label="Create Agent"
          title="Create Agent"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span aria-hidden="true">＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
              aria-label={`${agent.id === selectedId ? "Selected" : "Open"} Agent: ${agent.name}`}
              aria-current={agent.id === selectedId ? "page" : undefined}
              title={`${agent.id === selectedId ? "Selected" : "Open"}: ${agent.name}`}
            >
              <div className="agent-avatar" aria-hidden="true">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.demoRunner ? "No model or credentials used" : (system?.arkModel ?? "Ark model not configured")}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        <div className="ops-rail">
          <RunCapacityIndicator state={capacity} refresh={refreshCapacity} />
        </div>
        {system && !system.demoRunner && (!system.arkConfigured || !system.codexAvailable) ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss error">×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h2>{selected.name}</h2>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || (system?.demoRunner
                  ? "Controlled local fixture in a disposable workspace."
                  : "A Codex coding Agent in an isolated workspace.")}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy" || !!selected.recoveryHold}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy || (selected.status === "stopped" && !!selected.recoveryHold)}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {selected.recoveryHold && (
              <article className="run-error" role="alert">
                <strong>Workspace recovery required</strong>
                <span>
                  {selected.recoveryHold.reason === "interrupted_run"
                    ? "The server restarted during a Run and its checkpoint is unavailable. "
                    : "RunGuard could not restore this workspace after a denied Run. "}
                  Start, Send, and Settings are blocked. Review the workspace manually;
                  use Delete to archive this Agent, then create a fresh Agent to continue.
                </span>
              </article>
            )}

            <EffectFirewallStory
              agent={selected}
              activeRun={activeRun}
              runs={agentRuns}
              demoRunner={Boolean(system?.demoRunner)}
              interactionDisabled={
                Boolean(selected.recoveryHold) ||
                selected.status === "stopped" ||
                selected.status === "busy" ||
                Boolean(activeRun && ["queued", "running"].includes(activeRun.status))
              }
              onStageIncident={() => {
                setPrompt(fixturePrompts[0]);
                window.requestAnimationFrame(() => {
                  document.getElementById("run-console")?.scrollIntoView({ behavior: "smooth", block: "start" });
                });
              }}
            />

            {showSettings && !selected.recoveryHold && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)} aria-label="Close Agent settings">×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section id="run-console" className={"playground" + (selected.recoveryHold ? " playground-held" : "")}>
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Live Run console</span>
                  <h2>{system?.demoRunner ? "Send one incident through the boundary" : "Build something with your Agent"}</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {system?.demoRunner ? "No model session" : selected.codexThreadId ? "Session connected" : "New session"}
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>{system?.demoRunner ? "Which outcome should we verify?" : `What should ${selected.name} build?`}</h3>
                    <p>
                      {system?.demoRunner
                        ? "A typed Effect Firewall can stop a protected action before its worker starts. RunGuard then verifies or restores workspace state before the next Run."
                        : "The Agent can inspect files, write code, run commands, and continue the same Codex session across messages."}
                    </p>
                    <div className="prompt-grid">
                      {(system?.demoRunner ? fixturePrompts : starterPrompts).map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      {activeRun.acceptance?.status === "pending"
                        ? "Execution and trusted task verification are still pending…"
                        : system?.demoRunner ? "Running a fixed local filesystem fixture…" : "Codex is reading, editing, or running commands…"}
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className={activeRun.guard?.effectDecision ? "run-error run-contained" : "run-error"}>
                    <strong>{activeRun.guard?.effectDecision ? "Protected effect prevented" : "Run failed"}</strong>
                    <span>{activeRun.guard?.effectDecision
                      ? "Host policy refused execution authority. The worker never started and the Agent remains available."
                      : activeRun.error}</span>
                  </article>
                )}
                {activeRun?.route && (
                  <article className={"run-guard " +
                    (activeRun.route.status === "settled" ? "run-guard-retained"
                      : activeRun.route.status === "reserved" || activeRun.route.status === "dispatched"
                        ? "run-guard-pending" : "run-guard-denied")} aria-label="Model route receipt">
                    <div className="message-meta">
                      <strong>Model route · {activeRun.route.status.replaceAll("_", " ")}</strong>
                      <span>{activeRun.route.selection?.model ?? activeRun.route.errorCode ?? "host policy"}</span>
                    </div>
                    <div className="message-body">
                      {activeRun.route.status === "denied"
                        ? `No model was dispatched (${activeRun.route.reason?.replaceAll("_", " ")}).`
                        : activeRun.route.status === "reserved"
                          ? `${activeRun.route.selection?.routeId} met host score ${activeRun.route.selection?.qualityScore}; ` +
                            `${activeRun.route.reservation?.reservedCostMicrounits} synthetic microunits is only a ceiling. No runner dispatch occurred.`
                          : activeRun.route.status === "dispatched"
                            ? `${activeRun.route.selection?.routeId} was handed to the runner; settlement is unresolved and ` +
                              `${activeRun.route.reservation?.reservedCostMicrounits} synthetic microunits remains reserved.`
                            : activeRun.route.status === "reconciliation_required"
                              ? `${activeRun.route.selection?.routeId} requires accounting reconciliation; ` +
                                `${activeRun.route.settlement?.retainedMinimumCostMicrounits} synthetic microunits is the retained minimum.`
                              : `${activeRun.route.selection?.routeId} met host score ${activeRun.route.selection?.qualityScore}; ` +
                                `${activeRun.route.settlement?.retainedMinimumCostMicrounits} synthetic microunits is the settled estimate.`}
                    </div>
                    <small>
                      {activeRun.route.attemptsUsed}/{activeRun.route.maxAttempts} attempt used · synthetic estimate, not provider billing or quality proof
                    </small>
                  </article>
                )}
                {activeRun && !["queued", "running"].includes(activeRun.status) && (
                  <article className="run-guard" aria-label="Task acceptance">
                    <div className="message-meta">
                      <strong>Task acceptance · {(activeRun.acceptance?.status ?? "not_requested").replaceAll("_", " ")}</strong>
                      <span>{activeRun.acceptance?.verifierId ?? "No trusted task verifier configured"}</span>
                    </div>
                    <div className="message-body">
                      {activeRun.acceptance?.status === "passed"
                        ? "The configured task check passed. This is not a claim of general correctness or production performance."
                        : !activeRun.acceptance || activeRun.acceptance.status === "not_requested"
                          ? "Task correctness was not independently verified. A completed Run and a retained workspace are not proof of task success."
                          : `Task success was not established (${activeRun.acceptance.reason.replaceAll("_", " ")}). See recovery evidence below.`}
                    </div>
                  </article>
                )}
                {activeRun?.guard && activeRun.guard.verdict !== "pending" && (
                  <article className={"run-guard run-guard-" + activeRun.guard.verdict}>
                    <div className="message-meta">
                      <strong>
                        {activeRun.guard.effectDecision
                          ? "Effect Firewall · denied before dispatch"
                          : `RunGuard · ${activeRun.guard.verdict}`}
                      </strong>
                      <span>
                        {activeRun.guard.effectDecision?.policy ?? activeRun.guard.grantedScope}
                      </span>
                    </div>
                    <div className="message-body">
                      {activeRun.guard.effectDecision
                        ? `The Agent proposed ${activeRun.guard.effectDecision.action.replaceAll("_", " ")} on a ${activeRun.guard.effectDecision.targetClass} target. Host policy refused authority before execution.`
                        : activeRun.guard.denialReason ?? "Workspace manifest checks passed; task acceptance is reported separately."}
                    </div>
                    <small>
                      {activeRun.guard.changedFiles.length} tracked workspace change
                      {activeRun.guard.changedFiles.length === 1 ? "" : "s"}
                      {` · recovery:${activeRun.guard.recovery}`}
                      {activeRun.guard.recovery === "rolled_back" && " · checkpoint restored"}
                      {activeRun.guard.recovery === "failed" && " · checkpoint recovery failed"}
                    </small>
                    {activeRun.effectCapability && (
                      <section className="effect-capability-receipt"
                        aria-label="Consumed process-local Effect Capability receipt">
                        <div className="effect-capability-heading">
                          <strong>Effect Capability receipt · {activeRun.effectCapability.state}</strong>
                          <span>{activeRun.effectCapability.registry} · one use</span>
                        </div>
                        <dl>
                          <div>
                            <dt>Bound Run</dt>
                            <dd>{activeRun.effectCapability.runId.slice(0, 8)}</dd>
                          </div>
                          <div>
                            <dt>Allowed effect</dt>
                            <dd>{activeRun.effectCapability.action.replaceAll("_", " ")} → {activeRun.effectCapability.targetClass}</dd>
                          </div>
                          <div>
                            <dt>Use</dt>
                            <dd>{activeRun.effectCapability.usesClaimed}/{activeRun.effectCapability.useBudget} claimed</dd>
                          </div>
                        </dl>
                        <p>
                          The host consumed this parent before runner dispatch and never passed it to the runner.
                          {activeRun.effectSinkReceipt
                            ? ` Its opaque child ended ${activeRun.effectSinkReceipt.state.replaceAll("_", " ")} for ${activeRun.effectSinkReceipt.relativePath}; the sanitized receipt stores only a digest, never the bearer.`
                            : " No sink receipt is present on this Run, so sink commit is not claimed."}
                          {` ${activeRun.effectCapability.boundary}. One exact cooperative sink does not remove ambient filesystem access or create OS confinement.`}
                        </p>
                      </section>
                    )}
                    {activeRun.guard.effectDecision && !activeRun.effectCapability && (
                      <p className="effect-capability-none">
                        No Effect Capability was issued for this denied proposal.
                      </p>
                    )}
                    {activeRun.guard.verdict === "denied" && (
                      <dl className="run-guard-proof-grid" aria-label="Effect Firewall terminal proof">
                        <div>
                          <dt>Enforcement</dt>
                          <dd className="proof-pass">
                            {activeRun.guard.effectDecision ? "Before dispatch" : "Denied"}
                          </dd>
                        </div>
                        <div>
                          <dt>Workspace state</dt>
                          <dd className={
                            activeRun.guard.effectDecision?.protectedBaselineVerifiedUnchanged || activeRun.guard.recovery === "rolled_back"
                              ? "proof-pass"
                              : "proof-open"
                          }>
                            {activeRun.guard.effectDecision?.protectedBaselineVerifiedUnchanged
                              ? "Verified unchanged"
                              : activeRun.guard.recovery === "rolled_back"
                                ? "Verified restore"
                                : "Not proved"}
                          </dd>
                        </div>
                        <div>
                          <dt>{activeRun.guard.effectDecision ? "Worker" : "Run output"}</dt>
                          <dd className={
                            activeRun.guard.effectDecision?.workerSpawned === false || activeRun.output === null
                              ? "proof-pass"
                              : "proof-open"
                          }>
                            {activeRun.guard.effectDecision
                              ? activeRun.guard.effectDecision.workerSpawned ? "Unexpected" : "Never started"
                              : activeRun.output === null ? "Withheld" : "Unexpected"}
                          </dd>
                        </div>
                        <div>
                          <dt>Safe continuation</dt>
                          <dd className={!selected.recoveryHold && selected.status === "ready" ? "proof-pass" : "proof-open"}>
                            {selected.recoveryHold ? "Held" : selected.status === "ready" ? "Ready" : selected.status}
                          </dd>
                        </div>
                      </dl>
                    )}
                    <ol className="run-guard-timeline" aria-label="RunGuard receipt timeline">
                      {(activeRun.guard.events ?? []).map((event, index) => (
                        <li key={event.kind + event.detail + index}>
                          <strong>{runGuardEventLabel(event.kind)}</strong>
                          <span>{runGuardEventDetail(event.kind, event.detail)}</span>
                        </li>
                      ))}
                    </ol>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  aria-describedby="composer-status"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.recoveryHold
                      ? "Workspace recovery required…"
                      : selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : system?.demoRunner ? "Choose a fixture or describe the demo case…" : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    !!selected.recoveryHold ||
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null && ["queued", "running"].includes(activeRun.status)
                  }
                  rows={selected.recoveryHold ? 1 : 3}
                />
                <div className="composer-footer">
                  <span id="composer-status">
                    {selected.recoveryHold
                      ? "Workspace on recovery hold. Create a fresh Agent to continue."
                      : selected.status === "stopped"
                        ? "Start this Agent before sending."
                        : capacityFull
                          ? "Capacity is full. Your draft is kept; Stop remains available."
                          : "Enter to send · Shift + Enter for newline · " + (system?.codexSandboxMode ?? "checking sandbox")}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !!selected.recoveryHold ||
                      submitting || capacityFull ||
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>

            <details className="evidence-vault"
              open={evidenceVaultOpen}
              onToggle={event => setEvidenceVaultOpen(event.currentTarget.open)}>
              <summary>
                <div>
                  <span>Evidence vault</span>
                  <strong>Benchmarks, decoded media and runtime receipts</strong>
                </div>
                <span>Open technical proof <b aria-hidden="true">＋</b></span>
              </summary>
              {evidenceVaultOpen ? (
                <div className="evidence-vault-body">
                  <JudgeEvidencePanel />
                  <DecodeBridgeEvidencePanel />
                  <VideoIncidentRoom />
                  <details className="infrastructure-drawer"
                    open={runtimeEvidenceOpen || Boolean(reconciliation?.reconciliationRequired)}
                    onToggle={event => setRuntimeEvidenceOpen(event.currentTarget.open)}>
                    <summary>
                      <span><strong>Runtime evidence</strong> · budgets, workspace capacity and recovery</span>
                      <small>{reconciliation?.reconciliationRequired ? "Operator action required" : "Available on demand"}</small>
                    </summary>
                    <div className="infrastructure-drawer-body">
                      <SyntheticBudgetPanel budget={system?.modelRouting?.globalBudget} />
                      <WorkspaceResourcePanel resources={system?.workspaceResources} />
                      <WorkspaceReconciliationPanel
                        report={reconciliation}
                        actingIntentId={reconciliationBusy}
                        notice={reconciliationNotice}
                        onRefresh={() => { void refreshReconciliation().catch(reason =>
                          setError(reason instanceof Error ? reason.message : String(reason))); }}
                        onRetry={intent => { void reconcileLifecycle(intent, "retry"); }}
                        onCancel={intent => { void reconcileLifecycle(intent, "cancel"); }}
                      />
                    </div>
                  </details>
                </div>
              ) : null}
            </details>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">N</div>
            <span className="eyebrow">NerveLoop</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>{system?.demoRunner
              ? "Create a disposable workspace to exercise the middleware with fixed local actions."
              : "Create a workspace, give Codex a job, and continue the conversation here."}</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") setShowCreate(false);
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-agent-title"
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2 id="create-agent-title">Create an Agent</h2>
                <p>{system?.demoRunner
                  ? "Use a disposable workspace for this fixture. No model session starts."
                  : "Each Agent gets a persistent folder and a resumable Codex session."}</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)} aria-label="Close Create Agent dialog">×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
