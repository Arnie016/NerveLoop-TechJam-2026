import type { Agent, AgentRun } from "./types";

const EFFECT_FIXTURE_PROMPT = "Run the Effect Firewall delete-asset fixture.";

interface EffectFirewallStoryProps {
  agent: Agent;
  activeRun: AgentRun | null;
  runs: AgentRun[];
  demoRunner: boolean;
  interactionDisabled: boolean;
  onStageIncident: () => void;
}

function runTime(run: AgentRun | null): number {
  if (!run) return Number.NEGATIVE_INFINITY;
  const value = new Date(run.createdAt).getTime();
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function newestRun(runs: AgentRun[], predicate: (run: AgentRun) => boolean): AgentRun | null {
  return runs.reduce<AgentRun | null>((latest, run) => {
    if (!predicate(run)) return latest;
    return !latest || runTime(run) > runTime(latest) ? run : latest;
  }, null);
}

function readable(value: string): string {
  return value.replaceAll("_", " ");
}

export function EffectFirewallStory({
  agent,
  activeRun,
  runs,
  demoRunner,
  interactionDisabled,
  onStageIncident,
}: EffectFirewallStoryProps) {
  const effectRun = activeRun?.guard?.effectDecision
    ? activeRun
    : newestRun(runs, run => Boolean(run.guard?.effectDecision));
  const effectDecision = effectRun?.guard?.effectDecision;
  const isRunning = Boolean(activeRun && ["queued", "running"].includes(activeRun.status));
  const intercepted = effectDecision?.verdict === "denied";
  const decisionTime = runTime(effectRun);
  const laterSafeRun = effectRun
    ? newestRun(runs, run =>
      runTime(run) > decisionTime &&
      run.status === "completed" &&
      run.guard?.verdict === "retained")
    : null;
  const laterSafeSinkReceipt = laterSafeRun?.effectSinkReceipt;
  const exactSinkCommitted = laterSafeSinkReceipt?.state === "committed";
  const exactSinkLabel = exactSinkCommitted
    ? `${laterSafeSinkReceipt.relativePath} committed`
    : laterSafeSinkReceipt
      ? `Closed ${readable(laterSafeSinkReceipt.state)}`
      : laterSafeRun
        ? "No sink commit receipt"
        : "Awaiting later-safe receipt";
  const rollbackRun = newestRun(runs, run =>
    run.guard?.verdict === "denied" && run.guard.recovery === "rolled_back");
  const agentReady = agent.status === "ready" && !agent.recoveryHold;

  const state = isRunning ? "running" : intercepted ? "intercepted" : agent.recoveryHold ? "held" : "ready";
  const stateLabel = isRunning
    ? "Proposal moving through policy"
    : intercepted
      ? "Intercepted before dispatch"
      : agent.recoveryHold
        ? "Workspace held for review"
        : "Ready to stage the incident";
  const action = effectDecision?.action ?? "delete_mock_asset";
  const targetClass = effectDecision?.targetClass ?? "protected";
  const receiptLabel = effectRun
    ? `Run ${effectRun.id.slice(0, 8)} · ${new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(effectRun.createdAt))}`
    : "No Effect Firewall receipt yet";

  return (
    <section className={`effect-story effect-story-${state}`} aria-labelledby="effect-story-title">
      <header className="effect-story-masthead">
        <div className="effect-story-track">
          <span className="effect-story-sigil" aria-hidden="true"><i /><i /><i /></span>
          <span>TikTok TechJam · Track #1</span>
          <b>Effect Firewall</b>
        </div>
        <div className="effect-story-state" role="status" aria-live="polite">
          <i aria-hidden="true" />
          <span>{stateLabel}</span>
        </div>
      </header>

      <div className="effect-story-body">
        <div className="effect-story-copy">
          <p className="effect-story-overline">A nervous system for autonomous engineers</p>
          <h1 id="effect-story-title">
            <span>The agent can propose.</span>
            <em>Only the host can authorize this effect.</em>
          </h1>
          <p className="effect-story-deck">
            For the declared cooperative write, a typed host-owned gate stands between
            model intent and the sink. Protected effects lose authority before a worker can begin.
          </p>
          <div className="effect-story-actions">
            <button type="button" onClick={onStageIncident} disabled={interactionDisabled}>
              <span aria-hidden="true">⌁</span>
              Stage protected-effect incident
            </button>
            <a href="#run-console">Open live Run console <span aria-hidden="true">↓</span></a>
          </div>
          <small className="effect-story-action-note">
            This loads the fixed local fixture into the composer. Sending it remains an explicit action.
          </small>
        </div>

        <div className="effect-story-stage" aria-label={`Typed ${readable(action)} proposal targeting a ${targetClass} resource`}>
          <div className="effect-stage-caption">
            <span>{effectDecision ? "Observed decision" : "Incident anatomy"}</span>
            <code>{action} → {targetClass}</code>
          </div>

          <div className="effect-neural-field" aria-hidden="true">
            <svg viewBox="0 0 760 280" role="presentation">
              <path className="effect-axon effect-axon-left" d="M72 139 C148 139 179 91 256 119 C303 136 329 139 364 139" />
              <path className="effect-axon effect-axon-right" d="M397 139 C447 139 473 97 543 113 C591 124 617 139 692 139" />
              <path className="effect-axon-pulse" d="M72 139 C148 139 179 91 256 119 C303 136 329 139 364 139" />
              <circle className="effect-node effect-node-agent" cx="72" cy="139" r="19" />
              <circle className="effect-node effect-node-worker" cx="692" cy="139" r="19" />
              <circle className="effect-node-ring" cx="381" cy="139" r="52" />
              <circle className="effect-node-ring effect-node-ring-inner" cx="381" cy="139" r="34" />
              <path className="effect-gate-mark" d="M367 116 L395 162 M395 116 L367 162" />
            </svg>
            <div className="effect-stage-label effect-stage-agent">
              <span>Agent intent</span>
              <strong>Proposes</strong>
            </div>
            <div className="effect-stage-label effect-stage-gate">
              <span>Trusted boundary</span>
              <strong>{intercepted ? "Authority refused" : isRunning ? "Evaluating" : "Policy owns dispatch"}</strong>
            </div>
            <div className="effect-stage-label effect-stage-worker">
              <span>Worker</span>
              <strong>{effectDecision?.workerSpawned === false ? "Never started" : "No claim yet"}</strong>
            </div>
          </div>

          <blockquote className="effect-story-command">
            <span>Typed effect proposal</span>
            <code>{`{ action: "${action}", targetClass: "${targetClass}" }`}</code>
          </blockquote>
        </div>
      </div>

      <div className="effect-proof" aria-label="Effect Firewall proof summary">
        <div className="effect-proof-intro">
          <span>{effectDecision ? "Receipt observed" : "Proof waits for a Run"}</span>
          <strong>{receiptLabel}</strong>
        </div>
        <dl>
          <div className={effectDecision?.workerSpawned === false ? "is-proved" : "is-open"}>
            <dt>Dispatch</dt>
            <dd>{effectDecision?.workerSpawned === false ? "Worker never started" : "Awaiting receipt"}</dd>
          </div>
          <div className={effectDecision?.protectedBaselineVerifiedUnchanged ? "is-proved" : "is-open"}>
            <dt>Protected state</dt>
            <dd>{effectDecision?.protectedBaselineVerifiedUnchanged ? "Verified unchanged" : "Awaiting receipt"}</dd>
          </div>
          <div className={laterSafeRun ? "is-proved" : agentReady ? "is-ready" : "is-open"}>
            <dt>Same Agent</dt>
            <dd>{laterSafeRun ? "Later safe Run retained" : agentReady ? "Ready, not yet rerun" : "Not ready"}</dd>
          </div>
          <div className={exactSinkCommitted ? "is-proved" : laterSafeRun ? "is-open" : agentReady ? "is-ready" : "is-open"}>
            <dt>Exact sink</dt>
            <dd>{exactSinkLabel}</dd>
          </div>
        </dl>
      </div>

      <div className="effect-second-line">
        <span className="effect-second-line-mark" aria-hidden="true">Ⅱ</span>
        <div>
          <span>Second line · RunGuard</span>
          <strong>{rollbackRun ? "Checkpoint rollback observed in a separate Run" : "Checkpoint verification stands behind permitted workers"}</strong>
        </div>
        <p>
          If an allowed worker crosses scope, RunGuard retains, restores, or holds the workspace before another Run.
          {rollbackRun ? ` Observed receipt ${rollbackRun.id.slice(0, 8)}.` : " No rollback receipt is claimed here yet."}
        </p>
      </div>

      <details className="effect-story-receipt">
        <summary>Read exact proof boundary</summary>
        <p>
          {demoRunner
            ? "Fixed local no-model fixture. This proves typed pre-dispatch denial and one exact cooperative demo-result.md sink commit on the shown later-safe Run. It does not prove ambient filesystem authority was removed, OS confinement, a hardened production sandbox, TikTok access, production performance, or model quality."
            : "This local runtime receipt proves only the fields shown above. A process-local cooperative sink receipt is not ambient-filesystem removal or OS confinement, and it does not prove TikTok access, production performance, or general model quality."}
        </p>
        {effectDecision ? (
          <code>
            policy={effectDecision.policy} · verdict={effectDecision.verdict} · reason={effectDecision.reason} · workerSpawned={String(effectDecision.workerSpawned)}
          </code>
        ) : (
          <code>Run “{EFFECT_FIXTURE_PROMPT}” to produce a local receipt.</code>
        )}
      </details>
    </section>
  );
}
