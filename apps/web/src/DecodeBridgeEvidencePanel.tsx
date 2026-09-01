import {useCallback, useEffect, useRef, useState} from "react";
import type {CSSProperties} from "react";
import {api, ApiError} from "./api";
import type {DecodeBridgeEvidenceSummary} from "./types";
import {NerveLoopLens} from "./NerveLoopLens";

type DecodeBridgeState =
  | {kind: "loading"; data: null; manual: boolean}
  | {kind: "refreshing"; data: DecodeBridgeEvidenceSummary}
  | {kind: "ready"; data: DecodeBridgeEvidenceSummary}
  | {kind: "unavailable"; data: null; message: string};

function shortSha(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function capturedTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "capture time unavailable"
    : new Intl.DateTimeFormat(undefined, {dateStyle: "medium", timeStyle: "short"}).format(parsed);
}

function speedup(value: number): string {
  return `${value.toFixed(value >= 10 ? 2 : 3)}×`;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof ApiError && reason.status === 401) {
    return "The authenticated evidence request was denied. No accelerator verdict is displayed.";
  }
  return "A local artifact, digest binding, or semantic gate could not be validated. The governed action fails closed.";
}

function displayAsset(value: string): string {
  return value
    .replace("owned-h264-bframes-", "")
    .replace(".mp4", "")
    .replace("-stride", " stride");
}

export function DecodeBridgeEvidencePanel() {
  const [state, setState] = useState<DecodeBridgeState>({kind: "loading", data: null, manual: false});
  const activeRequest = useRef<AbortController | null>(null);

  const loadEvidence = useCallback((manual: boolean) => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setState((current) => manual && (current.kind === "ready" || current.kind === "refreshing")
      ? {kind: "refreshing", data: current.data}
      : {kind: "loading", data: null, manual});
    void api.decodeBridgeEvidence(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({kind: "ready", data});
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setState({kind: "unavailable", data: null, message: errorMessage(reason)});
        }
      })
      .finally(() => {
        if (activeRequest.current === controller) activeRequest.current = null;
      });
  }, []);

  useEffect(() => {
    loadEvidence(false);
    return () => activeRequest.current?.abort();
  }, [loadEvidence]);

  if (state.kind === "loading") {
    return (
      <section className="decodebridge decodebridge-pending" aria-labelledby="decodebridge-title"
        aria-live="polite" aria-busy="true">
        <div>
          <span className="decodebridge-kicker">Governed video action · local evidence</span>
          <h2 id="decodebridge-title">
            {state.manual ? "Rebinding evidence source…" : "Binding campaign receipts…"}
          </h2>
          <p>Promotion stays hidden until artifact hashes and runtime semantics agree.</p>
        </div>
        <span className="decodebridge-spinner" aria-hidden="true" />
      </section>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <section className="decodebridge decodebridge-unavailable" aria-labelledby="decodebridge-title"
        aria-live="polite">
        <div>
          <span className="decodebridge-kicker">Governed video action · denied</span>
          <h2 id="decodebridge-title">Evidence chain unavailable</h2>
          <p>{state.message}</p>
        </div>
        <button type="button" onClick={() => loadEvidence(true)}>Retry binding</button>
      </section>
    );
  }

  const data = state.data;
  const refreshing = state.kind === "refreshing";

  return (
    <>
      <NerveLoopLens data={data} refreshing={refreshing} onRebind={() => loadEvidence(true)} />
      <details className="decodebridge-evidence-details">
        <summary>
          <span><strong>Evidence details</strong> · engineering console and proof boundaries</span>
          <small>Historical campaign, attestation, negative controls, hashes</small>
        </summary>
        <section className="decodebridge" aria-labelledby="decodebridge-title" aria-live="polite"
          aria-busy={refreshing}>
      <header className="decodebridge-heading">
        <div>
          <span className="decodebridge-kicker"><i aria-hidden="true" /> {data.methodology.name} · DecodeBridge work cell</span>
          <h2 id="decodebridge-title">The GPU route has to prove where every frame went.</h2>
          <p>
            Hardware-attested H.264 ingest, direct Metal patch features, exact timeline reconstruction,
            and a downstream selector that must agree with the CPU reference before NerveLoop keeps the route.
            {" "}<strong>{data.methodology.tagline}.</strong>
          </p>
        </div>
        <div className="decodebridge-decision">
          <span>{data.evidenceSource.mode}</span>
          <strong>{refreshing ? "Revalidating…" : "Promotion candidate"}</strong>
          <small>
            {data.evidenceSource.mode === "LIVE_SIBLING_M5_ARTIFACTS"
              ? "Source bindings revalidated; no current hardware run."
              : "Sealed delivery snapshot and historical receipts; no current hardware run."}
            {" "}{data.execution.receiptCount}/{data.execution.receiptCount} campaign receipts · {capturedTime(data.capturedAt)}
          </small>
          <button type="button" disabled={refreshing} onClick={() => loadEvidence(true)}>
            {refreshing ? "Binding…" : "Rebind artifacts"}
          </button>
        </div>
      </header>

      <ol className="decodebridge-stages" aria-label="Governed action lifecycle">
        {data.actionStages.map((stage, index) => (
          <li key={stage.id} className={`decodebridge-stage-${stage.id}`}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div>
              <small>{stage.label}</small>
              <strong>{stage.status.replaceAll("_", " ")}</strong>
              <p>{stage.evidence}</p>
            </div>
          </li>
        ))}
      </ol>

      <section className="decodebridge-governed-run" aria-labelledby="decodebridge-governed-title">
        <div>
          <span>Governed execution receipt · separate from the KPI campaign</span>
          <strong id="decodebridge-governed-title">One-use AgentService run recorded, verified, and closed</strong>
          <p>{data.governedRun.boundary}</p>
        </div>
        <dl>
          <div><dt>Backend path</dt><dd>{data.governedRun.actualBackendPath ? "AgentService" : "Not evidenced"}</dd></div>
          <div><dt>Lease</dt><dd>{data.governedRun.leaseState} · reuse denied</dd></div>
          <div><dt>Canary</dt><dd>{data.governedRun.decodedFrameCount} frames · {data.governedRun.featureParityMismatchCount} mismatches</dd></div>
          <div><dt>Memory</dt><dd>{data.governedRun.regressionIds.length} regression replayed</dd></div>
        </dl>
        <code title={data.governedRun.evidenceRootSha256}>evidence {shortSha(data.governedRun.evidenceRootSha256)}</code>
      </section>

      <section
        className="causal-reflex"
        aria-labelledby="causal-reflex-title"
        data-evidence-surface="decodebridge-causal-reflex-details"
        data-verdict={data.causalReflex.decision.verdict}
        data-invalidated-node-count={data.causalReflex.decision.invalidatedNodeCount}
        data-replayed-node-count={data.causalReflex.decision.replayedNodeCount}
        data-reused-node-count={data.causalReflex.decision.reusedNodeCount}
        data-stale-promotion-escapes={data.causalReflex.decision.stalePromotionEscapes}
        data-logical-replay-avoided-percent={data.causalReflex.decision.logicalReplayAvoidedPercent}
      >
        <header className="causal-reflex-heading">
          <div>
            <span>New middleware primitive · causal blast-radius preview</span>
            <strong id="causal-reflex-title">One timestamp tick breaks three guarantees—not the whole pipeline.</strong>
            <p>{data.causalReflex.promise}</p>
          </div>
          <em>{data.causalReflex.decision.verdict.replaceAll("_", " ")}</em>
        </header>

        <div className="causal-reflex-metrics" aria-label="Selective recovery metrics">
          <div>
            <span>Replay</span>
            <strong>{data.causalReflex.decision.replayedNodeCount}/{data.causalReflex.decision.fullReplayNodeCount}</strong>
            <small>invalidated proof nodes</small>
          </div>
          <div>
            <span>Reuse</span>
            <strong>{data.causalReflex.decision.reusedNodeCount}/{data.causalReflex.decision.fullReplayNodeCount}</strong>
            <small>unchanged proof stays live</small>
          </div>
          <div>
            <span>Stale escapes</span>
            <strong>{data.causalReflex.decision.stalePromotionEscapes}</strong>
            <small>retain authority closed</small>
          </div>
          <div>
            <span>Logical work avoided</span>
            <strong>{data.causalReflex.decision.logicalReplayAvoidedPercent.toFixed(0)}%</strong>
            <small>not a latency claim</small>
          </div>
        </div>

        <ol className="causal-reflex-graph" aria-label="Causal proof dependency graph after one PTS tick fault">
          {data.causalReflex.nodes.map((node, index) => (
            <li key={node.id} className={`causal-node causal-node-${node.faultState.toLowerCase()}`}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <small>{node.owner}</small>
                <strong>{node.label}</strong>
                <code title={node.evidenceSha256}>{shortSha(node.evidenceSha256)}</code>
              </div>
              <em>{node.faultState === "REVOKED" ? "revoked → replayed" : "proof reused"}</em>
            </li>
          ))}
        </ol>

        <div className="causal-reflex-story">
          <article>
            <span>Fault</span>
            <strong>+1 PTS tick</strong>
            <small>Denied at <code>{data.causalReflex.scenario.observedGate}</code></small>
          </article>
          <b aria-hidden="true">→</b>
          <article>
            <span>Reflex</span>
            <strong>Revoke descendants</strong>
            <small>{data.causalReflex.decision.revokedCapabilities.join(" · ")}</small>
          </article>
          <b aria-hidden="true">→</b>
          <article>
            <span>Recovery</span>
            <strong>Replay {data.causalReflex.decision.replayedNodeCount} nodes</strong>
            <small>Regression {data.causalReflex.scenario.regressionId}</small>
          </article>
        </div>

        <footer>
          <span>Verified → faulted → recovered roots are distinct</span>
          <code title={data.causalReflex.roots.recovered}>recovered {shortSha(data.causalReflex.roots.recovered)}</code>
          <small>{data.causalReflex.proofBoundary}</small>
        </footer>
      </section>

      <div className="decodebridge-core">
        <section className="decodebridge-kpi" aria-labelledby="decodebridge-kpi-title">
          <div className="decodebridge-section-heading">
            <div>
              <span>Measured KPI · narrow by design</span>
              <strong id="decodebridge-kpi-title">Direct Metal vs scalar Double CPU reference</strong>
            </div>
            <code title={data.artifacts.aggregateFileSha256}>{shortSha(data.artifacts.aggregateFileSha256)}</code>
          </div>
          <div className="decodebridge-kpi-hero">
            <div>
              <span>Paired geomean</span>
              <strong>{speedup(data.kpi.geometricMeanSpeedup)}</strong>
              <small>feature stage only</small>
            </div>
            <div>
              <span>Weakest asset</span>
              <strong>{speedup(data.kpi.weakestAssetMedianSpeedup)}</strong>
              <small>precommitted floor 0.95×</small>
            </div>
            <div>
              <span>Token proxy</span>
              <strong>{data.parity.tokenReductionPercent.toFixed(1)}%</strong>
              <small>{data.parity.selectedFrames} selected frames</small>
            </div>
          </div>
          <div className="decodebridge-assets" aria-label="Median speedup by owned fixture">
            {data.kpi.assetMedianSpeedups.map((asset) => (
              <div key={asset.asset}>
                <span>{displayAsset(asset.asset)}</span>
                <strong>{speedup(asset.speedup)}</strong>
                <i style={{"--decodebridge-bar": `${Math.min(100, asset.speedup / 60 * 100)}%`} as CSSProperties} />
              </div>
            ))}
          </div>
          <ul className="decodebridge-exclusions">
            {data.kpi.exclusions.map((exclusion) => <li key={exclusion}>{exclusion}</li>)}
          </ul>
        </section>

        <section className="decodebridge-attestation" aria-labelledby="decodebridge-attestation-title">
          <div className="decodebridge-section-heading">
            <div>
              <span>Execution attestation</span>
              <strong id="decodebridge-attestation-title">{data.execution.device}</strong>
            </div>
            <em>Receipt records hardware observed</em>
          </div>
          <div className="decodebridge-pipeline" aria-label="Verified DecodeBridge pipeline">
            <span>H.264<br /><small>compressed</small></span>
            <b>→</b>
            <span>VideoToolbox<br /><small>hardware</small></span>
            <b>→</b>
            <span>420v NV12<br /><small>IOSurface</small></span>
            <b>→</b>
            <span>Metal<br /><small>no app staging</small></span>
            <b>→</b>
            <span>Selector<br /><small>exact match</small></span>
          </div>
          <dl className="decodebridge-attestation-grid">
            <div><dt>Decoded frames</dt><dd>{data.execution.decodedFrameCount.toLocaleString()}</dd></div>
            <div><dt>Timeline exact</dt><dd>{data.timeline.exactReceiptCount}/{data.execution.receiptCount}</dd></div>
            <div><dt>Parity mismatch</dt><dd>{data.parity.mismatchCount}</dd></div>
            <div><dt>Max abs error</dt><dd>{data.parity.maximumAbsoluteError.toExponential(2)}</dd></div>
            <div><dt>Drops / interrupts</dt><dd>{data.timeline.droppedFrames} / {data.timeline.interruptedFrames}</dd></div>
            <div><dt>Compared values</dt><dd>{data.parity.comparedValueCount.toLocaleString()}</dd></div>
          </dl>
          <div className="decodebridge-timeline-seal">
            <span>Presentation timeline</span>
            <code title={data.timeline.presentationTimelineSha256}>{shortSha(data.timeline.presentationTimelineSha256)}</code>
            <small>B-frame PTS inversion + callback reorder observed; presentation order reconstructed exactly.</small>
          </div>
        </section>
      </div>

      <section className="decodebridge-redteam" aria-labelledby="decodebridge-redteam-title">
        <div className="decodebridge-redteam-heading">
          <div>
            <span>Failure → denial → recovery</span>
            <strong id="decodebridge-redteam-title">A fast path loses if its receipt lies.</strong>
          </div>
          <em>
            {data.redTeam.runtime.executedControlCount}/{data.redTeam.runtime.executedControlCount} runtime faults · {data.redTeam.rejectedControlCount}/{data.redTeam.rejectedControlCount} receipt attacks
          </em>
        </div>
        <div className="decodebridge-failure-story">
          {data.redTeam.runtime.controls.map((control) => (
            <article key={control.fault}>
              <span>Executed fault</span>
              <strong>{control.fault.replaceAll("-", " ")}</strong>
              <p>Exit {control.exitCode} · denied by <code>{control.observedGate}</code></p>
            </article>
          ))}
          <article className="decodebridge-recovery">
            <span>Recovery</span>
            <strong>Prior digest-valid evidence unchanged</strong>
            <p>{data.redTeam.recovery.evidence}</p>
          </article>
        </div>
        <small><strong>Runtime controls.</strong> {data.redTeam.runtime.limitation}</small>
        <small><strong>Receipt controls.</strong> {data.redTeam.limitation}</small>
      </section>

      <footer className="decodebridge-boundary">
        <div>
          <span>Proof Envelope v1 · {data.proofEnvelope.decision.proofState.toLowerCase()}</span>
          <code title={data.proofEnvelope.task.contractSha256}>contract {shortSha(data.proofEnvelope.task.contractSha256)}</code>
          <code title={data.proofEnvelope.authority.policySha256}>policy {shortSha(data.proofEnvelope.authority.policySha256)}</code>
          <code title={data.artifacts.aggregatePayloadSha256}>payload {shortSha(data.artifacts.aggregatePayloadSha256)}</code>
          <code>{data.artifacts.inputSha256.length} inputs · {data.artifacts.receiptSha256.length} receipts</code>
        </div>
        <div className="decodebridge-boundary-copy">
          <p><strong>Proof boundary.</strong> {data.proofBoundary}</p>
          <small><strong>Not yet envelope-bound:</strong> {data.proofEnvelopeMissingBindings.join(" · ")}.</small>
        </div>
      </footer>
        </section>
      </details>
    </>
  );
}
