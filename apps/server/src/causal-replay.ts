import {createHash} from "node:crypto";

export type ReplayAuthorityState = "CURRENT" | "NOT_AUTHORITY";

export interface ReplayVerifierContext<NodeId extends string> {
  id: NodeId;
  mode: "SELECTIVE" | "FULL";
  dependencyEvidence: ReadonlyMap<NodeId, string>;
}

export interface ReplayVerifierResult {
  evidenceSha256: string;
  authorityState: ReplayAuthorityState;
}

export interface ReplayGraphNode<NodeId extends string> {
  id: NodeId;
  dependsOn: NodeId[];
  baselineEvidenceSha256: string;
  baselineAuthorityState: ReplayAuthorityState;
  verify: (context: ReplayVerifierContext<NodeId>) => ReplayVerifierResult;
}

export interface ReplayNodeExecution<NodeId extends string> {
  id: NodeId;
  disposition: "REPLAYED" | "REUSED";
  selectiveVerifierInvocationCount: 0 | 1;
  fullReplayVerifierInvocationCount: 1;
  evidenceSha256: string;
  authorityState: ReplayAuthorityState;
}

export interface CausalReplayExecution<NodeId extends string> {
  faultNode: NodeId;
  nodes: ReplayNodeExecution<NodeId>[];
  selectiveVerifierInvocations: NodeId[];
  reusedWithoutInvocation: NodeId[];
  fullReplayVerifierInvocations: NodeId[];
  selectiveInvocationCount: number;
  fullReplayInvocationCount: number;
  replayedNodeCount: number;
  reusedNodeCount: number;
  recoveredEvidenceRootSha256: string;
  fullReplayEvidenceRootSha256: string;
  fullReplayEquivalent: true;
  staleAuthorityCount: 0;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireSha(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("CAUSAL_REPLAY_INVALID_EVIDENCE_SHA");
  return value;
}

function validatedTopologicalOrder<NodeId extends string>(
  graph: ReplayGraphNode<NodeId>[],
): ReplayGraphNode<NodeId>[] {
  if (graph.length === 0) throw new Error("CAUSAL_REPLAY_EMPTY_GRAPH");
  const byId = new Map<NodeId, ReplayGraphNode<NodeId>>();
  for (const node of graph) {
    if (byId.has(node.id)) throw new Error("CAUSAL_REPLAY_DUPLICATE_NODE");
    requireSha(node.baselineEvidenceSha256);
    byId.set(node.id, node);
  }
  for (const node of graph) {
    const seenDependencies = new Set<NodeId>();
    for (const dependency of node.dependsOn) {
      if (!byId.has(dependency)) throw new Error("CAUSAL_REPLAY_MISSING_DEPENDENCY");
      if (dependency === node.id) throw new Error("CAUSAL_REPLAY_SELF_DEPENDENCY");
      if (seenDependencies.has(dependency)) throw new Error("CAUSAL_REPLAY_DUPLICATE_DEPENDENCY");
      seenDependencies.add(dependency);
    }
  }

  const visiting = new Set<NodeId>();
  const visited = new Set<NodeId>();
  const ordered: ReplayGraphNode<NodeId>[] = [];
  const visit = (id: NodeId): void => {
    if (visiting.has(id)) throw new Error("CAUSAL_REPLAY_CYCLE");
    if (visited.has(id)) return;
    visiting.add(id);
    const node = byId.get(id)!;
    for (const dependency of node.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(node);
  };
  for (const node of graph) visit(node.id);
  return ordered;
}

function affectedClosure<NodeId extends string>(
  graph: ReplayGraphNode<NodeId>[],
  faultNode: NodeId,
): Set<NodeId> {
  if (!graph.some((node) => node.id === faultNode)) throw new Error("CAUSAL_REPLAY_UNKNOWN_FAULT_NODE");
  const affected = new Set<NodeId>([faultNode]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph) {
      if (!affected.has(node.id) && node.dependsOn.some((id) => affected.has(id))) {
        affected.add(node.id);
        changed = true;
      }
    }
  }
  return affected;
}

function evidenceRoot<NodeId extends string>(
  evidence: ReadonlyMap<NodeId, string>,
): string {
  return digest(JSON.stringify([...evidence.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([id, evidenceSha256]) => ({id, evidenceSha256}))));
}

function invokeVerifier<NodeId extends string>(
  node: ReplayGraphNode<NodeId>,
  mode: "SELECTIVE" | "FULL",
  evidence: ReadonlyMap<NodeId, string>,
): ReplayVerifierResult {
  const dependencyEvidence = new Map<NodeId, string>();
  for (const dependency of node.dependsOn) {
    const dependencySha256 = evidence.get(dependency);
    if (!dependencySha256) throw new Error(`CAUSAL_REPLAY_DEPENDENCY_UNAVAILABLE:${node.id}`);
    dependencyEvidence.set(dependency, dependencySha256);
  }
  let result: ReplayVerifierResult;
  try {
    result = node.verify({id: node.id, mode, dependencyEvidence});
  } catch {
    throw new Error(`CAUSAL_REPLAY_VERIFIER_CRASH:${node.id}`);
  }
  requireSha(result.evidenceSha256);
  if (result.authorityState !== "CURRENT" && result.authorityState !== "NOT_AUTHORITY") {
    throw new Error(`CAUSAL_REPLAY_INVALID_AUTHORITY_STATE:${node.id}`);
  }
  return result;
}

/**
 * Executes a dependency-directed recovery and a separate full replay. Unaffected
 * nodes are deliberately loaded from the baseline without calling their verifier.
 * A result is returned only when both executions converge on identical evidence
 * and every authority node is current; all inconsistencies fail closed.
 */
export function executeCausalReplay<NodeId extends string>(
  graph: ReplayGraphNode<NodeId>[],
  faultNode: NodeId,
): CausalReplayExecution<NodeId> {
  const ordered = validatedTopologicalOrder(graph);
  const affected = affectedClosure(ordered, faultNode);
  const selectiveEvidence = new Map<NodeId, string>();
  const selectiveAuthority = new Map<NodeId, ReplayAuthorityState>();
  const selectiveVerifierInvocations: NodeId[] = [];
  const reusedWithoutInvocation: NodeId[] = [];

  for (const node of ordered) {
    if (affected.has(node.id)) {
      const result = invokeVerifier(node, "SELECTIVE", selectiveEvidence);
      selectiveVerifierInvocations.push(node.id);
      selectiveEvidence.set(node.id, result.evidenceSha256);
      selectiveAuthority.set(node.id, result.authorityState);
    } else {
      reusedWithoutInvocation.push(node.id);
      selectiveEvidence.set(node.id, node.baselineEvidenceSha256);
      selectiveAuthority.set(node.id, node.baselineAuthorityState);
    }
  }

  const fullEvidence = new Map<NodeId, string>();
  const fullAuthority = new Map<NodeId, ReplayAuthorityState>();
  const fullReplayVerifierInvocations: NodeId[] = [];
  for (const node of ordered) {
    const result = invokeVerifier(node, "FULL", fullEvidence);
    fullReplayVerifierInvocations.push(node.id);
    fullEvidence.set(node.id, result.evidenceSha256);
    fullAuthority.set(node.id, result.authorityState);
  }

  for (const node of ordered) {
    if (selectiveEvidence.get(node.id) !== fullEvidence.get(node.id) ||
        selectiveAuthority.get(node.id) !== fullAuthority.get(node.id)) {
      throw new Error(`CAUSAL_REPLAY_FULL_REPLAY_DIVERGENCE:${node.id}`);
    }
    if (node.baselineAuthorityState === "CURRENT" &&
        selectiveAuthority.get(node.id) !== "CURRENT") {
      throw new Error(`CAUSAL_REPLAY_STALE_AUTHORITY:${node.id}`);
    }
  }

  const recoveredEvidenceRootSha256 = evidenceRoot(selectiveEvidence);
  const fullReplayEvidenceRootSha256 = evidenceRoot(fullEvidence);
  if (recoveredEvidenceRootSha256 !== fullReplayEvidenceRootSha256) {
    throw new Error("CAUSAL_REPLAY_ROOT_DIVERGENCE");
  }

  return {
    faultNode,
    nodes: ordered.map((node) => ({
      id: node.id,
      disposition: affected.has(node.id) ? "REPLAYED" : "REUSED",
      selectiveVerifierInvocationCount: affected.has(node.id) ? 1 : 0,
      fullReplayVerifierInvocationCount: 1,
      evidenceSha256: selectiveEvidence.get(node.id)!,
      authorityState: selectiveAuthority.get(node.id)!,
    })),
    selectiveVerifierInvocations,
    reusedWithoutInvocation,
    fullReplayVerifierInvocations,
    selectiveInvocationCount: selectiveVerifierInvocations.length,
    fullReplayInvocationCount: fullReplayVerifierInvocations.length,
    replayedNodeCount: selectiveVerifierInvocations.length,
    reusedNodeCount: reusedWithoutInvocation.length,
    recoveredEvidenceRootSha256,
    fullReplayEvidenceRootSha256,
    fullReplayEquivalent: true,
    staleAuthorityCount: 0,
  };
}
