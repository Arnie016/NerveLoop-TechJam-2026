import {createHash} from "node:crypto";
import {
  executeCausalReplay,
  type CausalReplayExecution,
  type ReplayGraphNode,
  type ReplayVerifierContext,
} from "./causal-replay.js";

export type CausalProofNodeId =
  | "input-identity"
  | "hardware-decode"
  | "presentation-timeline"
  | "metal-feature-parity"
  | "temporal-selector"
  | "retention-authority";

export type CausalProofFaultState = "REUSED" | "REVOKED";
export type CausalProofRecoveryState = "REUSED" | "REPLAYED";

export interface CausalProofNode {
  id: CausalProofNodeId;
  label: string;
  owner: string;
  dependsOn: CausalProofNodeId[];
  evidenceSha256: string;
  faultState: CausalProofFaultState;
  recoveryState: CausalProofRecoveryState;
  selectiveVerifierInvocationCount?: 0 | 1;
  fullReplayVerifierInvocationCount?: 1;
}

export interface DecodeBridgeCounterfactualFaultEvaluation {
  kind: "TOPOLOGY_COUNTERFACTUAL";
  faultNode: CausalProofNodeId;
  replayedNodes: CausalProofNodeId[];
  reusedNodes: CausalProofNodeId[];
  selectiveVerifierInvocationCount: number;
  fullReplayVerifierInvocationCount: number;
  fullReplayEquivalent: true;
  staleAuthorityCount: 0;
}

export interface DecodeBridgeCausalReflexProjection {
  schemaVersion: 1;
  name: "Causal Proof-Graph Reflex";
  promise: string;
  scenario: {
    fault: "pts-one-tick";
    observedGate: "timeline.reference_exact_match";
    faultNode: "presentation-timeline";
    regressionId: "decodebridge-pts-one-tick-v1";
  };
  nodes: CausalProofNode[];
  decision: {
    verdict: "SELECTIVE_RECOVERY_VERIFIED";
    invalidatedNodeCount: number;
    reusedNodeCount: number;
    replayedNodeCount: number;
    fullReplayNodeCount: number;
    logicalReplayAvoidedPercent: number;
    stalePromotionEscapes: 0;
    revokedCapabilities: ["selector.publish", "route.retain"];
  };
  roots: {
    verified: string;
    faulted: string;
    recovered: string;
  };
  execution?: {
    engine: "IN_PROCESS_DETERMINISTIC_NODE_VERIFIERS";
    selectiveVerifierInvocations: CausalProofNodeId[];
    reusedWithoutInvocation: CausalProofNodeId[];
    fullReplayVerifierInvocations: CausalProofNodeId[];
    selectiveInvocationCount: number;
    fullReplayInvocationCount: number;
    recoveredEvidenceRootSha256: string;
    fullReplayEvidenceRootSha256: string;
    fullReplayEquivalent: true;
    staleAuthorityCount: 0;
  };
  counterfactualFaultMatrix?: DecodeBridgeCounterfactualFaultEvaluation[];
  faultEvidenceSha256: string;
  recoveryEvidenceSha256: string;
  proofBoundary: string;
}

interface CausalReflexInputs {
  inputSha256: string;
  executableSha256: string;
  aggregateSha256: string;
  timelineSha256: string;
  featureContract: string;
  selectorPolicy: string;
  selectedFrames: number;
  tokenReductionPercent: number;
  governedEvidenceRootSha256: string;
  faultEvidenceSha256: string;
  recoveryEvidenceSha256: string;
  runtimeFaults: Array<{fault: string; observedGate: string; verdict: string}>;
  regressionIds: string[];
}

interface GraphNodeDefinition {
  id: CausalProofNodeId;
  label: string;
  owner: string;
  dependsOn: CausalProofNodeId[];
  evidenceSha256: string;
  replay: ReplayGraphNode<CausalProofNodeId>;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireSha(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`CAUSAL_REFLEX_INVALID_${label}`);
  return value;
}

function stateRoot(
  nodes: CausalProofNode[],
  state: "verified" | "faulted" | "recovered",
): string {
  const rows = [...nodes].sort((left, right) => left.id < right.id ? -1 : 1).map((node) => ({
    id: node.id,
    evidenceSha256: node.evidenceSha256,
    state: state === "verified" ? "VERIFIED" : state === "faulted" ? node.faultState : node.recoveryState,
  }));
  return digest(JSON.stringify({state, rows}));
}

function buildGraphDefinitions(inputs: CausalReflexInputs): GraphNodeDefinition[] {
  const evidence: Record<CausalProofNodeId, string> = {
    "input-identity": inputs.inputSha256,
    "hardware-decode": digest(
      `hardware.actual_use|${inputs.executableSha256}|${inputs.aggregateSha256}`,
    ),
    "presentation-timeline": inputs.timelineSha256,
    "metal-feature-parity": digest(
      `feature.parity|${inputs.featureContract}|${inputs.aggregateSha256}`,
    ),
    "temporal-selector": digest(
      `selection.cpu_metal_identity|${inputs.selectorPolicy}|${inputs.selectedFrames}|${inputs.tokenReductionPercent}`,
    ),
    "retention-authority": inputs.governedEvidenceRootSha256,
  };
  const define = (
    id: CausalProofNodeId,
    label: string,
    owner: string,
    dependsOn: CausalProofNodeId[],
  ): GraphNodeDefinition => {
    const verify = (context: ReplayVerifierContext<CausalProofNodeId>) => {
      for (const dependency of dependsOn) {
        if (context.dependencyEvidence.get(dependency) !== evidence[dependency]) {
          throw new Error(`CAUSAL_REFLEX_STALE_DEPENDENCY:${id}:${dependency}`);
        }
      }
      return {
        evidenceSha256: evidence[id],
        authorityState: id === "retention-authority" ? "CURRENT" as const : "NOT_AUTHORITY" as const,
      };
    };
    return {
      id,
      label,
      owner,
      dependsOn,
      evidenceSha256: evidence[id],
      replay: {
        id,
        dependsOn,
        baselineEvidenceSha256: evidence[id],
        baselineAuthorityState: id === "retention-authority" ? "CURRENT" : "NOT_AUTHORITY",
        verify,
      },
    };
  };
  return [
    define("input-identity", "Owned MP4 identity", "Input sentinel", []),
    define("hardware-decode", "Hardware decode", "Decode specialist", ["input-identity"]),
    define("presentation-timeline", "Presentation timeline", "Timeline specialist", ["hardware-decode"]),
    define("metal-feature-parity", "CPU / Metal parity", "Metal specialist", ["hardware-decode"]),
    define("temporal-selector", "Temporal selection", "Selector specialist", [
      "presentation-timeline",
      "metal-feature-parity",
    ]),
    define("retention-authority", "Retain authority", "VERA reconciler", ["temporal-selector"]),
  ];
}

function matrixEntry(
  execution: CausalReplayExecution<CausalProofNodeId>,
): DecodeBridgeCounterfactualFaultEvaluation {
  return {
    kind: "TOPOLOGY_COUNTERFACTUAL",
    faultNode: execution.faultNode,
    replayedNodes: execution.nodes.filter((node) => node.disposition === "REPLAYED")
      .map((node) => node.id),
    reusedNodes: execution.nodes.filter((node) => node.disposition === "REUSED")
      .map((node) => node.id),
    selectiveVerifierInvocationCount: execution.selectiveInvocationCount,
    fullReplayVerifierInvocationCount: execution.fullReplayInvocationCount,
    fullReplayEquivalent: execution.fullReplayEquivalent,
    staleAuthorityCount: execution.staleAuthorityCount,
  };
}

export function buildDecodeBridgeCausalReflex(
  inputs: CausalReflexInputs,
): DecodeBridgeCausalReflexProjection {
  const runtimeFault = inputs.runtimeFaults.find((entry) => entry.fault === "pts-one-tick");
  if (!runtimeFault || runtimeFault.observedGate !== "timeline.reference_exact_match" ||
      runtimeFault.verdict !== "PASS") {
    throw new Error("CAUSAL_REFLEX_FAULT_NOT_EVIDENCED");
  }
  if (!inputs.regressionIds.includes("decodebridge-pts-one-tick-v1")) {
    throw new Error("CAUSAL_REFLEX_REGRESSION_NOT_REPLAYED");
  }
  for (const [label, value] of Object.entries({
    input: inputs.inputSha256,
    executable: inputs.executableSha256,
    aggregate: inputs.aggregateSha256,
    timeline: inputs.timelineSha256,
    governed: inputs.governedEvidenceRootSha256,
    fault: inputs.faultEvidenceSha256,
    recovery: inputs.recoveryEvidenceSha256,
  })) requireSha(value, label.toUpperCase());

  const definitions = buildGraphDefinitions(inputs);
  const replayGraph = definitions.map((definition) => definition.replay);
  const recovery = executeCausalReplay(replayGraph, "presentation-timeline");
  const executionById = new Map(recovery.nodes.map((node) => [node.id, node]));
  const nodes: CausalProofNode[] = definitions.map((definition) => {
    const execution = executionById.get(definition.id)!;
    return {
      id: definition.id,
      label: definition.label,
      owner: definition.owner,
      dependsOn: definition.dependsOn,
      evidenceSha256: execution.evidenceSha256,
      faultState: execution.disposition === "REPLAYED" ? "REVOKED" : "REUSED",
      recoveryState: execution.disposition,
      selectiveVerifierInvocationCount: execution.selectiveVerifierInvocationCount,
      fullReplayVerifierInvocationCount: execution.fullReplayVerifierInvocationCount,
    };
  });
  const invalidatedNodeCount = recovery.replayedNodeCount;
  const reusedNodeCount = recovery.reusedNodeCount;
  if (!recovery.selectiveVerifierInvocations.includes("retention-authority") ||
      recovery.staleAuthorityCount !== 0) {
    throw new Error("CAUSAL_REFLEX_STALE_PROMOTION");
  }
  const counterfactualFaultMatrix = ([
    "input-identity",
    "presentation-timeline",
    "metal-feature-parity",
    "retention-authority",
  ] as const).map((faultNode) => matrixEntry(executeCausalReplay(replayGraph, faultNode)));

  return {
    schemaVersion: 1,
    name: "Causal Proof-Graph Reflex",
    promise: "Know which guarantees a change will invalidate, revoke only their descendants, and replay only the affected proof subgraph.",
    scenario: {
      fault: "pts-one-tick",
      observedGate: "timeline.reference_exact_match",
      faultNode: "presentation-timeline",
      regressionId: "decodebridge-pts-one-tick-v1",
    },
    nodes,
    decision: {
      verdict: "SELECTIVE_RECOVERY_VERIFIED",
      invalidatedNodeCount,
      reusedNodeCount,
      replayedNodeCount: recovery.replayedNodeCount,
      fullReplayNodeCount: nodes.length,
      logicalReplayAvoidedPercent: reusedNodeCount / nodes.length * 100,
      stalePromotionEscapes: recovery.staleAuthorityCount,
      revokedCapabilities: ["selector.publish", "route.retain"],
    },
    roots: {
      verified: stateRoot(nodes, "verified"),
      faulted: stateRoot(nodes, "faulted"),
      recovered: stateRoot(nodes, "recovered"),
    },
    execution: {
      engine: "IN_PROCESS_DETERMINISTIC_NODE_VERIFIERS",
      selectiveVerifierInvocations: recovery.selectiveVerifierInvocations,
      reusedWithoutInvocation: recovery.reusedWithoutInvocation,
      fullReplayVerifierInvocations: recovery.fullReplayVerifierInvocations,
      selectiveInvocationCount: recovery.selectiveInvocationCount,
      fullReplayInvocationCount: recovery.fullReplayInvocationCount,
      recoveredEvidenceRootSha256: recovery.recoveredEvidenceRootSha256,
      fullReplayEvidenceRootSha256: recovery.fullReplayEvidenceRootSha256,
      fullReplayEquivalent: recovery.fullReplayEquivalent,
      staleAuthorityCount: recovery.staleAuthorityCount,
    },
    counterfactualFaultMatrix,
    faultEvidenceSha256: inputs.faultEvidenceSha256,
    recoveryEvidenceSha256: inputs.recoveryEvidenceSha256,
    proofBoundary: "The +1 PTS path invokes three in-process deterministic node verifiers and converges with a separately executed six-verifier full replay; the four-row fault matrix is a topology counterfactual. Reuse is invocation-count proof, not measured latency, cost, energy, hardware rerun, distributed revocation, or production-scale recovery.",
  };
}
