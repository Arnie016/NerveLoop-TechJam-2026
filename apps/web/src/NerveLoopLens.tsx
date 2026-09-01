import {useState} from "react";
import type {CSSProperties, KeyboardEvent} from "react";
import type {DecodeBridgeEvidenceSummary} from "./types";
import "./NerveLoopLens.css";

type LensPhase = "healthy" | "fault" | "reconcile";
type LensNode = DecodeBridgeEvidenceSummary["causalReflex"]["nodes"][number];

interface NerveLoopLensProps {
  data: DecodeBridgeEvidenceSummary;
  refreshing: boolean;
  onRebind: () => void;
}

const phases: Array<{id: LensPhase; number: string; label: string}> = [
  {id: "healthy", number: "1", label: "Healthy"},
  {id: "fault", number: "2", label: "Inject +1 PTS tick"},
  {id: "reconcile", number: "3", label: "Reconcile"},
];

const nodeLayout: Record<LensNode["id"], {x: string; y: string; z: string; replayOrder: number}> = {
  "input-identity": {x: "9%", y: "52%", z: "-34px", replayOrder: 0},
  "hardware-decode": {x: "27%", y: "52%", z: "-24px", replayOrder: 0},
  "presentation-timeline": {x: "47%", y: "25%", z: "0px", replayOrder: 1},
  "metal-feature-parity": {x: "47%", y: "76%", z: "-24px", replayOrder: 0},
  "temporal-selector": {x: "68%", y: "52%", z: "10px", replayOrder: 2},
  "retention-authority": {x: "89%", y: "52%", z: "36px", replayOrder: 3},
};

const phaseCopy: Record<LensPhase, {
  step: string;
  title: string;
  description: string;
  decision: string;
  mediaLabel: string;
  duration: string;
  frames: string;
}> = {
  healthy: {
    step: "Verified baseline",
    title: "All declared evidence agrees.",
    description: "The route can be evaluated only after all six proof nodes establish their declared dependencies.",
    decision: "BASELINE ROOT VERIFIED",
    mediaLabel: "Accepted reference window",
    duration: "2.0 s",
    frames: "60 frames",
  },
  fault: {
    step: "+1 presentation-timestamp tick",
    title: "Retain authority closes before stale output escapes.",
    description: "Timeline, selector, and retain evidence lose authority. Input, decode, and parity proof remain reusable.",
    decision: "RETAIN CLOSED",
    mediaLabel: "Wrong six-second cut denied",
    duration: "6.0 s",
    frames: "180 frames",
  },
  reconcile: {
    step: "Selective replay",
    title: "Three nodes replay. Three stay live.",
    description: "The affected proof closure is rebuilt in order, then a distinct recovered root is independently verified.",
    decision: "RECOVERY VERIFIED",
    mediaLabel: "Recovered candidate retained",
    duration: "2.0 s",
    frames: "60 frames",
  },
};

function nodeState(node: LensNode, phase: LensPhase): "verified" | "reused" | "revoked" | "replayed" {
  if (phase === "healthy") return "verified";
  if (phase === "fault") return node.faultState === "REVOKED" ? "revoked" : "reused";
  return node.recoveryState === "REPLAYED" ? "replayed" : "reused";
}

function nodeStateLabel(state: ReturnType<typeof nodeState>): string {
  if (state === "revoked") return "authority revoked";
  if (state === "replayed") return "proof replayed";
  if (state === "reused") return "proof reused";
  return "verified";
}

function nodeStyle(node: LensNode): CSSProperties {
  const layout = nodeLayout[node.id];
  return {
    "--lens-x": layout.x,
    "--lens-y": layout.y,
    "--lens-z": layout.z,
    "--lens-replay-order": layout.replayOrder,
  } as CSSProperties;
}

export function NerveLoopLens({data, refreshing, onRebind}: NerveLoopLensProps) {
  const [phase, setPhase] = useState<LensPhase>("fault");
  const copy = phaseCopy[phase];
  const decision = data.causalReflex.decision;
  const replayExecution = data.causalReflex.execution;
  const counterfactualFaultCount = data.causalReflex.counterfactualFaultMatrix?.length ?? 0;
  const liveEvidenceSource = data.evidenceSource.mode === "LIVE_SIBLING_M5_ARTIFACTS";

  const handleShortcut = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target instanceof HTMLButtonElement) return;
    const next = phases.find((item) => item.number === event.key);
    if (next) {
      event.preventDefault();
      setPhase(next.id);
    }
  };

  return (
    <section
      className={`nerveloop-lens nerveloop-lens-${phase}`}
      aria-labelledby="nerveloop-lens-title"
      aria-describedby="nerveloop-lens-summary"
      aria-busy={refreshing}
      tabIndex={0}
      onKeyDown={handleShortcut}
      data-evidence-surface="decodebridge-causal-reflex"
      data-lens-phase={phase}
      data-verdict={decision.verdict}
      data-invalidated-node-count={decision.invalidatedNodeCount}
      data-replayed-node-count={decision.replayedNodeCount}
      data-reused-node-count={decision.reusedNodeCount}
      data-stale-promotion-escapes={decision.stalePromotionEscapes}
      data-logical-replay-avoided-percent={decision.logicalReplayAvoidedPercent}
      data-selective-verifier-invocation-count={replayExecution?.selectiveInvocationCount ?? 0}
      data-full-replay-verifier-invocation-count={replayExecution?.fullReplayInvocationCount ?? 0}
      data-full-replay-equivalent={replayExecution?.fullReplayEquivalent ?? false}
      data-counterfactual-fault-count={counterfactualFaultCount}
      data-governed-parity-mismatch-count={data.governedRun.featureParityMismatchCount}
      data-governed-compared-value-count={data.governedRun.comparedValueCount}
      data-evidence-source-mode={data.evidenceSource.mode}
      data-current-hardware-run={data.evidenceSource.currentHardwareRun}
    >
      <div className="lens-grid" aria-hidden="true" />
      <header className="lens-heading">
        <div className="lens-heading-copy">
          <span className="lens-kicker"><i /> NerveLoop Lens · receipt-bound scenario</span>
          <h2 id="nerveloop-lens-title">One bad video timestamp. Half the proof graph survives.</h2>
          <p id="nerveloop-lens-summary">
            This is the safety and recovery layer around a real local media-compute path. NerveLoop
            blocks stale output, revokes only dependent proof, and replays only what broke.
          </p>
        </div>
        <div className="lens-route-seal">
          <span>Evidence source · no current hardware run</span>
          <strong className="lens-source-mode">
            {refreshing ? "REBINDING_EVIDENCE_SOURCE" : data.evidenceSource.mode}
          </strong>
          <small>
            {liveEvidenceSource
              ? "Sibling M5 artifact bindings revalidated; this request did not rerun the hardware workload."
              : "Sealed delivery snapshot from historical receipts; no live source-tree validation or current hardware run."}
          </small>
          <small className="lens-source-receipt">
            Saved receipt · {data.governedRun.featureParityMismatchCount} mismatches · {data.governedRun.decodedFrameCount} frames
          </small>
          <button type="button" onClick={onRebind} disabled={refreshing}>
            {refreshing ? "Binding…" : "Rebind evidence"}
          </button>
        </div>
      </header>

      <ol className="lens-readout" aria-label="NerveLoop scenario in four steps">
        <li>
          <span>1 · Real pipeline</span>
          <strong>Decode {data.governedRun.decodedFrameCount.toLocaleString()} H.264 frames</strong>
          <small>hardware decode + Metal feature path</small>
        </li>
        <li>
          <span>2 · Injected fault</span>
          <strong>Shift one PTS tick</strong>
          <small>presentation identity no longer matches</small>
        </li>
        <li>
          <span>3 · Selective reflex</span>
          <strong>Call {replayExecution?.selectiveInvocationCount ?? decision.replayedNodeCount} vs {replayExecution?.fullReplayInvocationCount ?? decision.fullReplayNodeCount} verifiers</strong>
          <small>reuse {decision.reusedNodeCount} digest-valid results</small>
        </li>
        <li>
          <span>4 · Verified result</span>
          <strong>{decision.stalePromotionEscapes} stale escapes · {decision.logicalReplayAvoidedPercent.toFixed(0)}% avoided</strong>
          <small>logical proof work, not latency or cost</small>
        </li>
      </ol>

      <div className="lens-workspace">
        <aside className="lens-incident" aria-labelledby="lens-incident-title">
          <div className="lens-section-label">
            <span>Media incident</span>
            <small>separate repair fixture</small>
          </div>
          <h3 id="lens-incident-title">Requested window: 2.0–4.0 s</h3>
          <figure className="lens-media-frame">
            <img
              src={phase === "fault"
                ? "/demo/video-incident/broken-poster.jpg"
                : "/demo/video-incident/repaired-poster.jpg"}
              alt={phase === "fault"
                ? "Rejected six-second candidate containing red, green, and blue scenes"
                : "Accepted two-second green reference scene"}
            />
            <figcaption><span>{copy.mediaLabel}</span><strong>{copy.duration}</strong></figcaption>
          </figure>
          <div className="lens-window-track" aria-label="Requested two-second interval within a six-second source">
            <span>0 s</span><i /><b /><i /><span>6 s</span>
          </div>
          <dl className="lens-incident-facts">
            <div><dt>Candidate</dt><dd>{copy.frames}</dd></div>
            <div><dt>Check</dt><dd>decoded frame + PCM equality</dd></div>
          </dl>
          <p>Deterministic MPEG-4 + AAC fixture. It demonstrates media repair, not semantic vision or the H.264 canary benchmark.</p>
        </aside>

        <section className="lens-proof-stage" aria-labelledby="lens-proof-stage-title">
          <header>
            <div>
              <span>{copy.step}</span>
              <h3 id="lens-proof-stage-title">{copy.title}</h3>
            </div>
            <em>{phase === "fault" ? "fault held" : phase === "reconcile" ? "distinct root" : "all dependencies valid"}</em>
          </header>
          <p className="lens-phase-description" aria-live="polite">{copy.description}</p>

          <div className="lens-graph" role="img" aria-label={`Six-node causal proof graph in ${phase} state`}>
            <svg className="lens-edges" viewBox="0 0 1000 460" preserveAspectRatio="none" aria-hidden="true">
              <path className="lens-edge lens-edge-reused" d="M120 239 L255 239" />
              <path className="lens-edge lens-edge-affected" d="M310 222 C365 205 390 155 445 124" />
              <path className="lens-edge lens-edge-reused" d="M310 256 C365 274 390 318 445 349" />
              <path className="lens-edge lens-edge-affected" d="M505 132 C570 151 590 205 650 231" />
              <path className="lens-edge lens-edge-reused" d="M505 346 C570 329 590 273 650 247" />
              <path className="lens-edge lens-edge-affected" d="M712 239 L855 239" />
            </svg>
            <ol>
              {data.causalReflex.nodes.map((node, index) => {
                const visualState = nodeState(node, phase);
                return (
                  <li
                    key={node.id}
                    className={`lens-node lens-node-${visualState}`}
                    style={nodeStyle(node)}
                    data-node-id={node.id}
                    data-proof-state={visualState}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <small>{node.owner}</small>
                    <strong>{node.label}</strong>
                    <em>{nodeStateLabel(visualState)}</em>
                  </li>
                );
              })}
            </ol>
            <div className="lens-depth-labels" aria-hidden="true">
              <span>reusable evidence</span><span>fault boundary</span><span>retain authority</span>
            </div>
          </div>
        </section>

        <aside className="lens-decision" aria-labelledby="lens-decision-title">
          <div className="lens-section-label"><span>Decision</span><small>fixed verified scenario</small></div>
          <div className="lens-decision-state">
            <i aria-hidden="true" />
            <span>Current visualization</span>
            <strong id="lens-decision-title">{copy.decision}</strong>
          </div>
          <dl className="lens-kpis" aria-label="Verified selective recovery KPIs">
            <div>
              <dt>Stale escapes</dt>
              <dd>{decision.stalePromotionEscapes}</dd>
              <small>retain gate held</small>
            </div>
            <div>
              <dt>Verifier calls</dt>
              <dd>{replayExecution?.selectiveInvocationCount ?? decision.replayedNodeCount}/{replayExecution?.fullReplayInvocationCount ?? decision.fullReplayNodeCount}</dd>
              <small>{replayExecution?.fullReplayEquivalent ? "full-replay root matched" : "logical projection"}</small>
            </div>
            <div>
              <dt>Logical work avoided</dt>
              <dd>{decision.logicalReplayAvoidedPercent.toFixed(0)}%</dd>
              <small>{decision.reusedNodeCount}/{decision.fullReplayNodeCount} proofs reused</small>
            </div>
            <div>
              <dt>Compute mismatch</dt>
              <dd>{data.governedRun.featureParityMismatchCount}</dd>
              <small>{data.governedRun.comparedValueCount.toLocaleString()} values</small>
            </div>
          </dl>
          <p>{counterfactualFaultCount} fault locations checked. Invocation-count proof—not measured latency, cost, energy, model quality, or production-scale recovery.</p>
        </aside>
      </div>

      <footer className="lens-controls">
        <div role="group" aria-label="Causal proof graph scenario">
          {phases.map((item) => (
            <button
              key={item.id}
              type="button"
              className={phase === item.id ? "is-active" : ""}
              aria-pressed={phase === item.id}
              aria-keyshortcuts={item.number}
              onClick={() => setPhase(item.id)}
            >
              <span>{item.number}</span>{item.label}
            </button>
          ))}
        </div>
        <p><strong>Replay, don’t rerun:</strong> the receipt binds {replayExecution?.selectiveInvocationCount ?? decision.replayedNodeCount} executed verifier calls, {decision.reusedNodeCount} sealed reuses and a matching full replay.</p>
      </footer>
    </section>
  );
}
