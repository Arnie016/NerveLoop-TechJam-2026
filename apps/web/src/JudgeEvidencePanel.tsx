import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { JudgeEvidenceLane, JudgeEvidenceSummary } from "./types";

type EvidenceState =
  | { kind: "loading"; data: null; manual: boolean }
  | { kind: "refreshing"; data: JudgeEvidenceSummary }
  | { kind: "ready"; data: JudgeEvidenceSummary }
  | { kind: "unavailable"; data: null; message: string };

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function count(value: unknown): string {
  const numeric = finiteNumber(value);
  return numeric === null ? "Unavailable" : numeric.toLocaleString();
}

function ratio(numerator: unknown, denominator: unknown): string {
  const left = finiteNumber(numerator);
  const right = finiteNumber(denominator);
  return left === null || right === null
    ? "Unavailable"
    : `${left.toLocaleString()}/${right.toLocaleString()}`;
}

function campaignShape(campaigns: unknown, casesPerCampaign: unknown): string {
  const campaignCount = finiteNumber(campaigns);
  const caseCount = finiteNumber(casesPerCampaign);
  return campaignCount === null || caseCount === null
    ? "Unavailable"
    : `${campaignCount.toLocaleString()} × ${caseCount.toLocaleString()}`;
}

function generatedTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Timestamp unavailable"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function laneName(value: string): string {
  return value
    .split("-")
    .map((part) => part ? part[0]!.toUpperCase() + part.slice(1) : part)
    .join(" ");
}

function unavailableMessage(reason: unknown): string {
  if (reason instanceof ApiError && reason.status === 401) {
    return "The authenticated evidence request was not accepted. No verdict is displayed.";
  }
  return "The server could not return a currently verified summary. No pass is inferred from stale or partial evidence.";
}

function laneKpi(lane: JudgeEvidenceLane | undefined, key: string): number | null {
  return finiteNumber(lane?.kpis[key]);
}

function duration(value: number): string {
  return value < 1_000 ? `${Math.round(value).toLocaleString()} ms` : `${(value / 1_000).toFixed(2)} s`;
}

function shortSha(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export function JudgeEvidencePanel() {
  const [state, setState] = useState<EvidenceState>({ kind: "loading", data: null, manual: false });
  const activeRequest = useRef<AbortController | null>(null);

  const fetchEvidence = useCallback((manual: boolean) => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setState((current) => manual && (current.kind === "ready" || current.kind === "refreshing")
      ? { kind: "refreshing", data: current.data }
      : { kind: "loading", data: null, manual });

    void api.judgeEvidence(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ kind: "ready", data });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setState({ kind: "unavailable", data: null, message: unavailableMessage(reason) });
        }
      })
      .finally(() => {
        if (activeRequest.current === controller) activeRequest.current = null;
      });
  }, []);

  useEffect(() => {
    fetchEvidence(false);
    return () => activeRequest.current?.abort();
  }, [fetchEvidence]);

  if (state.kind === "loading") {
    return (
      <section className="judge-evidence judge-evidence-loading" aria-labelledby="judge-evidence-title" aria-live="polite" aria-busy="true">
        <div className="judge-evidence-heading">
          <div>
            <span className="eyebrow">Local judge evidence</span>
            <strong id="judge-evidence-title">
              {state.manual ? "Refreshing judge evidence…" : "Verifying retained receipts…"}
            </strong>
          </div>
          <span className="judge-evidence-spinner" aria-hidden="true" />
        </div>
        <p>A pass appears only after the server validates a live scorecard or its sealed build snapshot.</p>
      </section>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <section className="judge-evidence judge-evidence-unavailable" aria-labelledby="judge-evidence-title" aria-live="polite">
        <div className="judge-evidence-heading">
          <div>
            <span className="eyebrow">Local judge evidence</span>
            <strong id="judge-evidence-title">Evidence unavailable · fail closed</strong>
          </div>
          <button className="judge-evidence-refresh" type="button" onClick={() => fetchEvidence(true)}>
            Retry evidence
          </button>
        </div>
        <p>{state.message}</p>
      </section>
    );
  }

  const data = state.data;
  const repair = data.repairEpisode;
  const heldoutLane = data.lanes.find((lane) => lane.id === "post-commit-heldout-calibration");
  const refreshing = state.kind === "refreshing";
  const familyCount = laneKpi(heldoutLane, "negativeBehaviorFamilyCount");
  const replayCount = laneKpi(heldoutLane, "permutationReplayCount");
  const metrics = [
    {
      label: "Evidence lanes",
      value: ratio(data.decisionKpis.evidenceLanesPassed, data.decisionKpis.evidenceLaneCount),
      note: "hard-gated",
    },
    {
      label: "Fresh campaigns",
      value: campaignShape(data.decisionKpis.heldoutCampaignCount, data.decisionKpis.heldoutCasesPerCampaign),
      note: "cases each",
    },
    {
      label: "Unsafe promotions",
      value: ratio(data.decisionKpis.heldoutUnsafePromotionEvents, data.decisionKpis.heldoutUnsafeCandidateCampaigns),
      note: "negative runs",
    },
    {
      label: "Families rejected",
      value: ratio(data.decisionKpis.heldoutNegativeBehaviorFamiliesRejected, familyCount),
      note: "semantic families",
    },
    {
      label: "Replay invariance",
      value: ratio(data.decisionKpis.heldoutPermutationInvariantReplays, replayCount),
      note: "fresh workers",
    },
    {
      label: "Indeterminate",
      value: count(data.decisionKpis.heldoutIndeterminateOutcomes),
      note: "failures are not wins",
    },
    {
      label: "Case executions",
      value: count(data.decisionKpis.heldoutTotalCandidateCaseExecutions),
      note: "held-out total",
    },
  ];
  const passed = data.verdict === "EVIDENCE_GATE_PASS";
  const evidenceMode = data.evidenceMode === "live-scorecard"
    ? "Live source verification"
    : "Sealed build snapshot";

  return (
    <section className={`judge-evidence ${passed ? "judge-evidence-pass" : "judge-evidence-fail"}`}
      aria-labelledby="judge-evidence-title" aria-live="polite" aria-busy={refreshing}>
      <div className="judge-evidence-heading">
        <div>
          <span className="eyebrow">Local judge evidence</span>
          <strong id="judge-evidence-title">Proof-carrying performance engineer</strong>
          <small>{evidenceMode} · generated {generatedTime(data.generatedAt)}</small>
        </div>
        <div className="judge-evidence-controls">
          <span className="judge-evidence-verdict">
            {refreshing ? "Refreshing retained summary…" : passed ? "Evidence gate pass" : "Evidence gate fail"}
          </span>
          <button className="judge-evidence-refresh" type="button" disabled={refreshing}
            onClick={() => fetchEvidence(true)}>
            {refreshing ? "Refreshing…" : "Refresh evidence"}
          </button>
        </div>
      </div>

      <dl className="judge-evidence-metrics">
        {metrics.map((metric) => (
          <div key={metric.label}>
            <dt>{metric.label}</dt>
            <dd>{metric.value}</dd>
            <small>{metric.note}</small>
          </div>
        ))}
      </dl>

      <section className="repair-episode" aria-labelledby="repair-episode-title">
        <div className="repair-episode-heading">
          <div>
            <span className="eyebrow">Verified repair trace v1</span>
            <strong id="repair-episode-title">A rejected patch becomes the next regression</strong>
            <small>Bounded compiler synthesis · no model · no candidate catalogue</small>
          </div>
          <div className="repair-episode-seal">
            <span>{repair.spans.length} causal spans</span>
            <code title={repair.traceSha256}>{shortSha(repair.traceSha256)}</code>
          </div>
        </div>

        <div className="repair-episode-story">
          <div className="repair-attempts" aria-label="Synthesized repair attempts">
            {repair.attempts.map((attempt) => {
              const accepted = attempt.verdict === "OUTPUTS_MATCH_ORACLE";
              return (
                <article key={attempt.index} className={accepted ? "repair-attempt-accepted" : "repair-attempt-rejected"}>
                  <span>Attempt {attempt.index}</span>
                  <strong>{laneName(attempt.variant)} synthesis</strong>
                  <p>{attempt.transforms.map((transform) => transform.replaceAll("-", " ")).join(" + ")}</p>
                  <small>{accepted ? "4,628/4,628 hidden cases" : `${attempt.failedCases.toLocaleString()} hidden failures · rejected`}</small>
                </article>
              );
            })}
          </div>
          <article className="repair-regression">
            <span>Trace → regression</span>
            <strong>{repair.regression.caseId} · [{repair.regression.startMs}, {repair.regression.endMs})</strong>
            <p>Expected {repair.regression.expectedCount}; candidate returned {repair.regression.actualCount ?? "invalid"}.</p>
            <small>Promoted once, then replayed inside a distinct {repair.regressionReplay.fullOracleCases.toLocaleString()}-case job.</small>
          </article>
        </div>

        <ol className="repair-trace" aria-label="Digest-bound repair episode timeline">
          {repair.spans.map((span) => (
            <li key={span.spanId} className={span.status === "rejected" ? "repair-span-rejected" : ""}>
              <span>{span.sequence.toString().padStart(2, "0")}</span>
              <div>
                <strong>{span.phase}</strong>
                <small>{span.action.replaceAll("-", " ")}</small>
              </div>
              <em>{span.status} · {duration(span.durationMs)}</em>
            </li>
          ))}
        </ol>

        <div className="repair-episode-footer">
          <span>One target · one write · network denied · publication denied</span>
          <small>Episode {duration(repair.durationMs)} · trace and regression tampering block the evidence lane.</small>
        </div>
      </section>

      <div className="judge-evidence-lanes" aria-label="Evidence lane decisions">
        {data.lanes.map((lane) => (
          <article key={lane.id} className={lane.decision === "BLOCK" ? "judge-lane-blocked" : ""}>
            <div>
              <strong>{laneName(lane.id)}</strong>
              <small>{lane.passedGateCount.toLocaleString()}/{lane.gateCount.toLocaleString()} gates</small>
            </div>
            <span>{lane.decision.replaceAll("_", " ")}</span>
          </article>
        ))}
      </div>

      <p className="judge-evidence-rule">{data.evaluationRule}</p>
      <aside className="judge-evidence-boundary">
        <span>Proof boundary</span>
        <p>{data.proofBoundary}</p>
      </aside>
    </section>
  );
}
