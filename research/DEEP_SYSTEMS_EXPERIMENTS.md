# Deep systems experiments for Track 1

Captured 1 September 2026 for **TikTok TechJam 2026 Track #1: Agent
Launchpad: Design and Build Lightweight Agent Middleware**.

This is a deadline-aware research and experiment brief. It is not a claim that
the cited systems were reproduced, that a model or TikTok production system was
used, or that every experiment below has run. Source inspection and proposed
work are labeled separately. Current pass counts belong in generated verifier
receipts, not in this research note.

## The decision in one paragraph

Do not turn NerveLoop into another agent dashboard or another prompt filter.
Its strongest systems idea is a **causal capability transaction**: an agent may
propose an effect, but a host-owned monotone policy decides whether any worker
may start; an allowed effect receives narrowly bound, one-use authority; and a
post-run transaction guard publishes output only after the resulting state is
verified. A denial must prove `workerSpawned == false` and unchanged state. A
late violation must prove rollback to the baseline or put the Agent on a
persistent hold. The final-stretch implementation now connects those three
steps for the explicit deterministic demo path: allowed effects receive a
process-local one-use parent before `runner.run`, then an opaque child bound to
the exact `demo-result.md` path and payload. The cooperative fixture redeems
that child at the sink. Raw ambient writes remain possible and are deliberately
exercised as RunGuard's second-line case. The remaining work is to make that
narrow proof legible and releaseable, not add more agents or a larger model.

This composition is the differentiator. None of its primitives is presented as
new research. The hackathon contribution is making the invisible authority
transition visible, executable, measurable and understandable in one Agent Run.

## Contract anchor and selection method

The public [TikTok TechJam 2026 Devpost
page](https://tiktoktechjam2026.devpost.com/) supplies the public submission and
judging context. The dated organizer statement used during track selection is
kept in the entrant's private research archive, outside this deliberate public
source closure. We used a conservative implementation contract: Track 1 needs a
functional middleware path through the supplied Agent platform, a real Run and
action, and visible failure, denial, recovery, degradation or abuse evidence. A
static UI does not qualify.

The scan was deliberately broad, but the retained set is small enough to make a
decision. Twenty-nine primary papers, project documents and official technical
sources were selected from agent security, capability systems, authorization,
information-flow control, filesystem transactions, sandboxing, durable
workflows, formal policy work and adversarial evaluation. A source survived the
cut only if it changed an algorithm, an experiment, or a proof boundary in this
repository. Model-only alignment work, generic orchestration surveys and systems
that require a new cloud deployment were not promoted into tonight's build.

## Threat model

### Trusted for the prototype

- The Fastify/`AgentService` host process, its static policy configuration and
  the independent verifier implementation.
- Canonical serialization and SHA-256 as integrity measurements. A digest alone
  is not an unforgeable capability; authority also needs a host-owned registry
  or keyed authenticator.
- The baseline captured by RunGuard before dispatch, if the bounded scan
  succeeds.
- The test harness and deterministic fixture inputs.

### Treated as untrusted

- User prompts, retrieved text, tool output, model output and plugin-supplied
  arguments.
- The worker process and any code it produces or invokes.
- A delegated Agent that may hold less authority than its parent.
- Workspace paths and contents after execution begins, including links,
  replacement inodes, oversized trees and permission changes.
- A receipt supplied by the worker. Only the host may author a policy verdict or
  terminal receipt.

### Attacks in scope

1. Direct and indirect prompt injection that asks for an out-of-policy effect.
2. Malformed or over-broad tool arguments, unknown actions and schema smuggling.
3. Confused-deputy escalation across Agents or tools.
4. Lease replay, double spend, expiry, cross-Run substitution and concurrent
   claim races.
5. Target substitution after authorization, including path, inode, symlink and
   hard-link changes.
6. Partial execution, cancellation, worker crash, verifier rejection and failed
   recovery.
7. Receipt omission, reordering, duplication and tampering.
8. Persistent state poisoning that makes a later safe Run unsafe or unusable.

### Not proved here

- Containment of hostile native code, a compromised host process, root, kernel,
  hypervisor or container daemon.
- General network non-exfiltration, kernel-enforced filesystem isolation, a
  microVM security boundary or arbitrary process-tree containment.
- Semantic correctness of an LLM's plan, production performance, TikTok access
  or behavior on TikTok data.
- Crash consistency under host power loss, filesystem-wide ACID semantics, or
  noninterference for arbitrary programs.

## Security and liveness invariants

The algorithms and experiments below target eight explicit invariants.

| ID | Invariant | Observable test |
|---|---|---|
| `I1` | Every declared cooperative fixture effect crosses a host-owned enforcement point. | The exact allowed write commits through the sink; the deliberate ambient bypass is detected and restored by RunGuard. |
| `I2` | Delegation only attenuates authority. | `childAuthority <= parentAuthority`; no added action, target, lifetime or use. |
| `I3` | A pre-dispatch denial has zero worker side effects. | Worker call count is zero and before/after manifest digests are equal. |
| `I4` | An effect capability is consumed at most once. | Concurrent and replayed claims produce exactly one admitted execution. |
| `I5` | Output is not committed before independent acceptance. | A verifier rejection leaves output null and source state unpromoted. |
| `I6` | Every Run reaches a safe, explicit terminal state. | Commit, exact recovery, or persistent hold; never ambiguous “success.” |
| `I7` | Receipts are complete enough to detect illegal transitions. | Missing, reordered or duplicated events fail verification. |
| `I8` | Safety does not destroy useful continuation. | A safe later Run on the same Agent still succeeds after a denial/recovery. |

## What the repository actually contains

“Source-inspected” means the code and named tests exist in the current checkout.
It does not claim that this research lane reran them.

| Mechanism | Current repository state | Proof boundary |
|---|---|---|
| Typed Effect Firewall | **Implemented, source-inspected.** [`effect-policy.ts`](../apps/server/src/effect-policy.ts) defines five ordered actions, four ordered target classes and an authority ceiling. Every deterministic demo Run declares an effect; the protected-delete route is denied before dispatch, while an admitted fixture fault deliberately exceeds its declared workspace effect for RunGuard to catch. [`effect-policy.test.ts`](../apps/server/src/effect-policy.test.ts) specifies the full 20-cell cross-product, monotonicity and exact-shape rejection. | The pre-dispatch hook is exercised by the deterministic demo runner, not arbitrary provider-generated tool calls or a general intent classifier. |
| Zero-dispatch denial | **Implemented, source-inspected.** `AgentService` asks the runner for a typed demo proposal, evaluates it in host code, then calls RunGuard's pre-dispatch denial path before `runner.run`. | Exact local fixture; no claim that free-form intent is securely parsed for every model/tool. |
| Same-Agent continuation | **Implemented, source-inspected.** The Effect Firewall integration test specifies denied protected action followed by a safe successful Run on the same Agent. | Deterministic no-model fixture. |
| RunGuard transaction backstop | **Implemented, source-inspected.** [`run-guard.ts`](../apps/server/src/run-guard.ts) captures a bounded checkpoint, verifies the post-Run manifest, restores or quarantines unsafe state and exposes a recovery hold. | User-space, bounded workspace recovery. It is not an OS sandbox or filesystem-wide transaction. |
| Path-race defenses | **Implemented, source-inspected.** Tests cover no-follow reads, symlink/root-link cases, hard links, special entries, permission-only changes, traversal limits and recovery failures. | Parent-directory races, outside aliases, ACLs, xattrs and hostile kernel behavior remain outside scope. |
| One-use Run-bound authority and exact sink | **Integrated for the explicit `DEMO_RUNNER=1` write path.** [`effect-capability.ts`](../apps/server/src/effect-capability.ts) issues a five-second host-owned parent bound to Run, Agent, action, target, policy version and full policy-table digest. [`effect-sink.ts`](../apps/server/src/effect-sink.ts) attenuates it into one opaque child bound to the exact path, payload, root identity and expiry. `AgentService` persists parent and sanitized child transitions; `FixtureRunner` receives only the child and redeem-only port. | Cooperative mediation covers one exact fixture write. Ambient filesystem APIs remain available; RunGuard handles the deliberate bypass. Both process-local registries cap at 1,024 entries without terminal-entry reclamation, so exhaustion fails closed but limits availability. This is not authentication, cross-restart durability, general provider/tool interception or kernel authority. |
| Independent candidate acceptance | **Implemented in a separate path.** Candidate promotion tests bind a Run/Agent, exact source hashes, execution evidence and a single durable claim before promotion. | Specialized synthetic video-repair path; no general semantic verifier. |
| Provenance/taint across Agents | **Proposed.** No label propagation or delegation graph was found in the inspected Effect Firewall path. | Must not be implied by ordinary receipts. |
| Formal temporal receipt monitor | **Implemented after this scan as a standalone verifier, not wired into `AgentService`.** [`effect-receipt-automaton.ts`](../apps/server/src/effect-receipt-automaton.ts) validates legal terminal families, event order, cross-object recovery holds and a canonical trusted-head chain. | It proves only histories explicitly supplied to the verifier. Current functional summary JSON omits raw events, so its projection test is terminal-shape compatibility, not retroactive event capture or runtime enforcement. |
| Kernel sandbox or microVM | **Deferred.** | No Linux Landlock/Sandlock/Firecracker execution on this Apple host. |

## Research synthesis: what changes the build

### 1. Agent middleware and adversarial evaluation

| Primary source | Decision-relevant result | Consequence for NerveLoop |
|---|---|---|
| [Out-of-Band Policy Enforcement (OBPE, 2026)](https://arxiv.org/abs/2608.27646) | Authorize typed operations/resources outside agent reasoning; agent policy may narrow but cannot widen the owner's ceiling. | Keep the decisive check in host code and measure security together with safe-useful completion. |
| [AgentFlow (2026)](https://arxiv.org/abs/2608.22868) | Policies over labeled runtime edges, task-scoped capabilities, stateful taint and bounded policy verification. | Add origin/delegation/sink labels rather than growing a flat action list. |
| [SEAgent (2026)](https://arxiv.org/abs/2601.11893) | ABAC plus an information-flow graph addresses privilege escalation and confused deputies in multi-agent systems. | Make authority attenuation and two-Agent escalation explicit red-team cases. |
| [MiniScope (2025)](https://arxiv.org/abs/2512.11147) | Reconstruct tool permission hierarchies and grant the least powerful sufficient permission. | Treat action/target order as a tested lattice, not a collection of special cases. |
| [CaMeL: Defeating Prompt Injections by Design (2025)](https://arxiv.org/abs/2503.18813) | Separate trusted control flow from untrusted data flow and enforce capabilities at tool calls. | Never use keyword detection or the agent's prose as the final authorization decision. |
| [Google's Approach for Secure AI Agents](https://research.google/pubs/an-introduction-to-googles-approach-for-secure-ai-agents/) | Well-defined controllers, limited powers, observable actions and defense in depth. | Present pre-dispatch policy, post-run verification and persistent holds as complementary layers. |
| [Toward Secure LLM Agents: a 247-paper systems survey (2026)](https://arxiv.org/abs/2606.10749) | Agent security sits at the interaction of information flow, delegated authority and persistent state; long-horizon propagation is under-tested. | Test the later safe Run and delegated authority, not only one-shot prompt injection. |
| [AgentDojo (NeurIPS 2024)](https://arxiv.org/abs/2406.13352) | Dynamic tasks distinguish utility from security under indirect injection. | Report both unsafe-effect rate and safe-task completion; a system that denies everything loses. |
| [InjecAgent (2024)](https://arxiv.org/abs/2403.02691) | Indirect instructions arrive through tool-integrated external content. | Carry an untrusted-origin label through retrieved/tool data to the eventual sink. |
| [ToolEmu (ICLR 2024)](https://arxiv.org/abs/2309.15817) | Emulated tools enable broad risk discovery, but emulated failures require real-world validation. | Use synthetic attacks to expand coverage while labeling them as fixtures, not production proof. |
| [tau-bench (ICLR 2025)](https://arxiv.org/abs/2406.12045) | Realistic tool-agent-user evaluation scores task completion under domain policy. | Include long sequences, policy compliance and utility, not isolated function-call accuracy. |

### 2. Authorization, capabilities and formal policy

| Primary source | Decision-relevant result | Consequence for NerveLoop |
|---|---|---|
| [Open Policy Agent deployment model](https://www.openpolicyagent.org/docs/deploy) | Separate the policy decision point from the enforcement point and place enforcement near the protected operation. | Treat `effect-policy.ts` as the PDP and `AgentService -> runner` as the PEP; the model owns neither. |
| [Cedar: expressive, fast, safe and analyzable authorization (2024)](https://arxiv.org/abs/2403.04651) | Typed principal/action/resource/context policies, deny-by-default semantics and analyzable authorization. | Evolve the tuple to `(principal, action, resource, context)` while keeping a small deterministic core. |
| [How We Built Cedar: verification-guided development (2024)](https://arxiv.org/abs/2407.01688) | Executable model + proofs + differential random testing + property-based testing found bugs missed by review. | Pair the policy implementation with an independent tiny oracle and generated cross-product/monotonicity tests. |
| [Macaroons (NDSS 2014)](https://research.google/pubs/macaroons-cookies-with-contextual-caveats-for-decentralized-authorization-in-the-cloud/) | Delegated credentials can add contextual caveats and attenuate authority through chained MACs. | A child Agent receives a caveated subset of its parent's authority; it cannot extend scope or lifetime. |
| [Capsicum (USENIX Security 2010)](https://www.usenix.org/legacy/events/sec10/tech/full_papers/security10_proceedings.pdf) | Unforgeable object capabilities and compartmentalization reduce ambient authority. | Pass explicit authority to a worker instead of letting it inherit the operator's reach. |
| [Zanzibar (USENIX ATC 2019)](https://www.usenix.org/conference/atc19/presentation/pang) | Authorization decisions need causal consistency with permission and object updates. | Bind the target digest/policy version into the capability so stale authorization cannot approve a changed object. |
| [Dogwood runtime verification for agents (AWS, 2026)](https://aws.amazon.com/blogs/opensource/introducing-dogwood-runtime-verification-for-ai-agents/) | Metric temporal logic can express tool history, counts, distinct values and time-bounded rules at runtime. | Enforce sequence rules such as “commit only after verify” and “one publish per Run,” not just point-in-time allow/deny. |

### 3. Information flow and provenance

| Primary source | Decision-relevant result | Consequence for NerveLoop |
|---|---|---|
| [Flume: Information Flow Control for Standard OS Abstractions (SOSP 2007)](https://pdos.csail.mit.edu/papers/flume-sosp07.pdf) | A small reference monitor controls confidentiality/integrity flows while untrusted processes compute. | Keep labels and declassification in trusted middleware; a worker cannot relabel its own data. |
| [TaintDroid (OSDI 2010)](https://www.usenix.org/conference/osdi10/taintdroid-information-flow-tracking-system-realtime-privacy-monitoring) | Dynamic taint propagates source labels and observes sensitive sinks with usable overhead in its target environment. | Propagate origin labels through tool results and summaries, then test sink decisions and label loss. |
| [CamFlow: Practical Whole-System Provenance Capture (SoCC 2017)](https://arxiv.org/abs/1711.05296) | Versioned provenance graphs capture flows among processes, files and sockets at a reference monitor. | Represent each tool/delegation/effect as a versioned edge and preserve the causal path in the receipt. |

### 4. Transactions, recovery and durable workflows

| Primary source | Decision-relevant result | Consequence for NerveLoop |
|---|---|---|
| [MBOX (USENIX ATC 2013)](https://www.usenix.org/conference/atc13/technical-sessions/presentation/kim) | Layer writes away from the host, inspect the diff, then selectively commit. | The ideal worker writes into staged candidate state; verification, not worker completion, promotes it. |
| [TxFS (USENIX ATC 2018)](https://www.usenix.org/system/files/conference/atc18/atc18-hu.pdf) | File-level ACID transactions can build on a journal and expose a small begin/commit API. | Make begin, verify, commit and abort explicit, while clearly denying filesystem-wide ACID claims for RunGuard. |
| [Valor (FAST 2009)](https://www.usenix.org/legacy/event/fast09/tech/full_papers/spillane/spillane_html/) | Kernel logging and locking provide atomicity/isolation and abort a transaction on process failure. | User-space checkpoints cannot claim isolation; measure races and preserve kernel isolation as a future rung. |
| [Beldi (OSDI 2020)](https://www.usenix.org/conference/osdi20/presentation/zhang-haoran) | Logs and transactional protocols make stateful serverless function composition fault tolerant. | Give every external effect an idempotency/claim key and make retries replay a receipt rather than repeat the effect. |
| [Temporal event history and replay](https://docs.temporal.io/) | A durable ordered event history and deterministic replay reconstruct workflow state after failure. | Verify a Run's legal transition history; put non-deterministic effects behind recorded steps. |

### 5. Isolation options and their honest boundary

| Primary source | Decision-relevant result | Consequence for NerveLoop |
|---|---|---|
| [Linux Landlock documentation](https://docs.kernel.org/security/landlock.html) | Unprivileged processes can add inherited restrictions; rules compose by becoming more restrictive. | A Linux production path could compile the capability envelope into kernel file/network rules. It cannot be demonstrated on this macOS host tonight. |
| [Sandlock (2026)](https://arxiv.org/abs/2605.26298) | Split static rules into kernel enforcement and dynamic decisions into a narrow supervisor, including reversible effects. | This closely matches the long-term architecture; cite it as a future hardening route, not current proof. |
| [Firecracker (NSDI 2020)](https://www.usenix.org/conference/nsdi20/presentation/agache) | Purpose-built microVMs target strong isolation with low startup overhead for serverless workloads. | Use only when the deployment environment and benchmark justify it; a diagram or Docker CLI is not microVM evidence. |

## Four algorithmic mechanisms

### Mechanism A — Monotone effect lattice

**State: implemented in the current Effect Firewall.**

The current policy orders actions by risk and targets by sensitivity:

```text
actions = [read_asset_metadata, write_demo_result, transform_media,
           publish_candidate, delete_mock_asset]
risk    = [0, 1, 2, 3, 4]

targets = [scratch, workspace, candidate, protected]
sense   = [0, 1, 2, 3]

ceiling = 2
allow(action, target) iff risk[action] + sense[target] <= ceiling
```

The important property is monotonicity. If `(a, r)` is denied, moving to a
riskier action or more sensitive resource must remain denied. This makes policy
behavior explainable and exhaustively testable across the current 20 cells.

```text
decide(p):
    require exact schema {version, action, targetClass}
    require action in ACTIONS and targetClass in TARGETS
    score = risk[p.action] + sensitivity[p.targetClass]
    return ALLOW if score <= hostCeiling else DENY
```

**Failure cases.** A sum collapses distinct risks into one number, does not
encode subject, object identity, time, provenance or prior actions, and can make
two semantically different pairs equivalent. Keep it for the judge-visible
fixture; evolve it through explicit context/capability checks rather than an
LLM risk score.

**Decisive metrics.** Complete cross-product coverage, monotonicity violations,
malformed-proposal acceptance, decision latency, attack prevention and false
denial on safe proposals.

### Mechanism B — Causal, one-use effect capsule

**State: integrated in the explicit deterministic Effect Firewall allow path;
durable and provider-wide variants remain future work.**

An allow decision should not become ambient permission. It should mint one
effect capsule bound to the exact causal context:

```text
capsuleBody = canonical({
  version, policyDigest,
  agentId, runId, parentCapsuleDigest,
  action, targetClass, targetIdentity, targetDigest,
  inputDigest, verifierDigest,
  issuedAt, expiresAt, nonce, maxUses: 1
})

capsuleId = SHA256(capsuleBody)
```

For a single-process prototype, unforgeability comes from a host-owned registry
and an atomic exclusive claim, not from publishing the digest:

```text
claim(capsule, observedContext):
    require hostRegistry[capsuleId] == ISSUED
    require now < expiresAt
    require every bound field == observedContext
    atomically compareAndSwap(ISSUED, CLAIMED)
    return claimId

finish(claimId, verifierReceipt):
    require claim is CLAIMED and verifierReceipt binds claimId
    atomically set COMMITTED or ABORTED
```

A distributed version can authenticate the capsule with a server key or use a
caveated credential. Merely hashing client-controlled fields would be forgeable
and must not be described as authorization.

**Attenuating delegation.** A child capsule must be a subset of the parent:

```text
child.actions      subsetOf parent.actions
child.targets      subsetOf parent.targets
child.expiresAt    <= parent.expiresAt
child.maxUses      <= parent.remainingUses
child.policyDigest == parent.policyDigest
```

**Failure cases.** The integrated process-local registry now covers same-process
replay, concurrent claim, expiry, tampered receipt, denied issuance, duplicate
ID and Run/Agent/action/target/policy binding drift. Replay after restart,
multi-process races, durable revocation, target-content binding, clock skew,
registry loss and delegation attenuation remain outside this bridge. The
separate durable claim tests are valuable evidence, but are not relabeled as
the general AgentService authority mechanism.

**Decisive metrics.** Replay acceptance rate, cross-Run substitution rate,
authority-amplification rate, exactly-one winner under concurrency, claim
latency and safe completion overhead.

### Mechanism C — Provenance-carrying delegation

**State: proposed; deliberately not claimed by the current receipts.**

Each value or tool result carries confidentiality sources and an integrity
class. Each Agent carries an authority set. Labels join as information is
combined; authority meets as work is delegated:

```text
label(x) = { confidentialitySources: Cx, integrity: Ix }

combine(x1 ... xn):
    C_out = union(C1 ... Cn)
    I_out = minTrust(I1 ... In)

delegate(parent, task):
    authority_child = intersection(authority_parent, authority_task)

allowSink(value, capsule, sink):
    require label(value).confidentialitySources subsetOf sink.clearance
    require label(value).integrity >= sink.minimumIntegrity
    require capsule authorizes exact sink/action/resource
```

Only a host policy can declassify or endorse data, and that decision becomes a
receipt edge. Summarization, reformatting or delegation never silently drops a
label. The causal receipt is a small versioned graph:

```text
prompt -> proposal -> policyDecision -> capsule -> workerClaim
toolResult(untrusted) -> derivedValue -> sinkAttempt
verifier -> commit | restore | hold
```

**Failure cases.** Over-taint can deny useful work; under-taint can leak data;
implicit flows are not captured by simple set propagation; an LLM can infer a
secret without copying an exact value; labels can explode over long histories.
The implementable prototype should use coarse source classes and a hard label
budget, then fail closed when provenance is missing.

**Decisive metrics.** Confused-deputy attack success, label-loss rate, false
denial, provenance graph size, propagation overhead and safe declassification
success.

### Mechanism D — Transactional reflex automaton

**State: RunGuard supplies checkpoint/verify/recover behavior. A strict pure
receipt automaton and canonical trusted-head chain are implemented and tested,
but are not yet wired into the `AgentService` persistence boundary.**

Point decisions are insufficient for long workflows. A host runtime monitor
should accept only these transitions:

```text
CREATED -> SNAPSHOTTED -> POLICY_CHECKED

POLICY_CHECKED -> DENIED_NO_DISPATCH
POLICY_CHECKED -> CAPSULE_ISSUED -> CLAIMED -> DISPATCHED

DISPATCHED -> VERIFIED_SAFE -> COMMITTED
DISPATCHED -> VERIFIED_UNSAFE -> RESTORED
DISPATCHED -> VERIFIED_UNSAFE -> HOLD

terminal = {DENIED_NO_DISPATCH, COMMITTED, RESTORED, HOLD}
```

Terminal assertions are mechanical:

```text
DENIED_NO_DISPATCH:
    workerSpawned == false
    beforeDigest == afterDigest
    changedFiles == []

COMMITTED:
    capsule was claimed exactly once
    verifier accepted exact candidateDigest
    finalDigest == committedDigest

RESTORED:
    output == null
    recoveredDigest == beforeDigest

HOLD:
    output == null
    future dispatch/settings mutations are rejected
```

Each event can extend a host-authored chain:

```text
h[0] = SHA256(runId || policyDigest || beforeDigest)
h[i] = SHA256(h[i-1] || canonical(event[i]))
```

This detects receipt tampering or omission when the verifier knows the trusted
head; it does not make a compromised host trustworthy.

**Failure cases.** Non-deterministic timestamps in replay, event loss, a commit
before durable receipt write, a crash between rename and success record, and
recovery that restores bytes but not metadata. The current candidate promotion
tests already explore several of these windows in a specialized path.

**Decisive metrics.** Illegal transition acceptance, receipt-tamper detection,
ambiguous terminal state rate, recovery convergence, recovery time, commit
latency and later-safe continuity.

## Deep experiment matrix

Status legend:

- **Current:** mechanism and a named test are present in the inspected Agent
  path.
- **Separate:** mechanism exists in another bounded fixture/path and is not yet
  general Effect Firewall proof.
- **Build:** small, directly useful pre-freeze experiment.
- **Narrate:** show the design and limitation; do not destabilize the build.
- **Defer:** needs a different OS, infrastructure or research-length effort.

| ID | Attack or experiment | Ablation / comparator | Required observation | Metric | Status |
|---|---|---|---|---|---|
| P1 | Exact protected-delete proposal | Effect Firewall on vs RunGuard-only | Guarded arm denies before `runner.run`; baseline executes then recovers | worker dispatches, changed bytes, denial latency | **Current** |
| P2 | Safe workspace write | Reset-all vs RunGuard vs two-boundary reflex | Safe output retained and Agent remains ready | safe completion, false denial | **Current** normal path; three-arm harness owned elsewhere |
| P3 | Full 5 x 4 action/target lattice | Table oracle vs implementation | Every cell agrees with independent oracle | disagreements / 20 | **Current** |
| P4 | Dominance property | Remove monotone ceiling; seed permissive cells | No denial becomes allow as risk/sensitivity increases | monotonicity violations | **Current** |
| P5 | Unknown action/target, extra field, wrong version | Permissive parser vs exact schema | Every malformed proposal fails closed | malformed acceptance | **Current** |
| P6 | Near-match malicious prose | Keyword filter vs exact typed route | Prose alone never authors a host policy verdict | false security decisions | **Current** exact-route negative control |
| P7 | Policy-version drift during Run | Bind vs omit `policyDigest` | Stale capsule rejected before effect | stale-policy acceptance | **Build** |
| P8 | Target changes after decision | Bind vs omit target identity/digest | Substituted target rejected at claim/commit | TOCTOU acceptance | **Build** deterministic fixture |
| C1 | Expired capsule | Expiry check on/off | No worker start after expiry | expired-use acceptance | **Separate** lease test |
| C2 | Same-session replay | One-use claim on/off | Second call denied without overwrite | replay acceptance | **Separate** |
| C3 | Replay after MCP restart | In-memory set vs durable claim | Restart cannot renew consumed authority | cross-restart replay acceptance | **Separate** |
| C4 | Two concurrent claimers | Atomic exclusive claim vs check-then-set | Exactly one worker starts | admitted workers / race | **Separate** |
| C5 | Wrong Run or Agent ID | Binding removed one field at a time | Mismatch fails before claim | substitution acceptance | **Separate** |
| C6 | Revocation after initialization | Static startup check vs per-call validation | Revoked capsule denies before worker | post-revocation execution | **Separate** |
| C7 | Revocation after candidate rename | No recovery journal vs prepared recovery | Exact baseline bytes/mode restored; success withheld | convergence, recovery time | **Separate** candidate promotion |
| C8 | Child requests broader action/target | Delegation intersection on/off | Child authority is never broader | amplification rate | **Build** pure property test |
| C9 | Child extends expiry/use count | Caveat check on/off | Lifetime and use budget only shrink | amplification rate | **Build** pure property test |
| F1 | Untrusted tool text asks for publish | Provenance labels on/off | Untrusted label reaches sink and policy denies | attack success, false denial | **Narrate**, then build after freeze |
| F2 | Agent A asks privileged Agent B to act | Parent binding on/off | B cannot exercise authority A lacks | confused-deputy success | **Build** small two-Agent simulator if stable |
| F3 | Three-hop delegation launders origin | Propagation at every edge vs final-edge only | Origin survives A -> B -> C -> sink | label-loss rate | **Narrate** |
| F4 | Summarization of tainted content | Copy labels vs reset labels | Summary retains source class | label-loss rate | **Narrate** |
| F5 | Approved declassification | Host token vs worker assertion | Only exact host rule can release | false allow / false deny | **Narrate** |
| F6 | Label budget exhaustion | Unbounded graph vs capped coarse labels | Overflow fails closed with bounded receipt | memory, denial utility | **Defer** |
| T1 | Protected write after dispatch | Effect Firewall only vs RunGuard backstop | Output withheld and exact checkpoint restored | unsafe final state, recovery time | **Current** |
| T2 | Symlink escape | Follow vs no-follow recovery | Outside sentinel unchanged; link itself denied/removed | outside changes | **Current** |
| T3 | Identical-byte hard-link swap | Content hash only vs inode/link checks | Alias attack detected despite equal bytes | attack detection | **Current** |
| T4 | Permission-only protected change | Content-only vs content+mode manifest | Mutation denied and mode restored | metadata integrity | **Current** |
| T5 | Root-link swap / oversized tree | Best-effort scan vs fail-closed quarantine | No target traversal; uncertain state not released | false retain, raw-path leakage | **Current** |
| T6 | Worker crash/cancellation | Publish-on-return vs verify-after-return | No unchecked output published | unsafe publication | **Current/Separate** depending path |
| T7 | Verifier rejects plausible candidate | Worker self-grade vs independent verifier | Rejected candidate never promoted | verifier bypass rate | **Separate** |
| T8 | Recovery collision | Auto-ready vs persistent hold | Agent blocks Send/Start/Settings after failed convergence | ambiguous release | **Current** |
| T9 | Server crash after dispatch | Volatile checkpoint vs durable staged transaction | Restart does not report success; unresolved Agent held | ambiguous terminal state | **Current** hold; exact recovery **Defer** |
| T10 | Host power loss during commit | User-space checkpoint vs filesystem transaction | Atomic durable commit or recovery | crash consistency | **Defer** |
| R1 | Delete `POLICY_CHECKED` event | Loose event list vs automaton | Receipt rejected | illegal history acceptance | **Build** pure verifier |
| R2 | Duplicate `CLAIMED`/`COMMITTED` event | Loose list vs automaton | Duplicate rejected | duplicate acceptance | **Build** |
| R3 | Reorder verify after commit | Loose list vs automaton | Commit-before-verify rejected | illegal history acceptance | **Build** |
| R4 | Mutate an old receipt event | Plain JSON vs host hash chain | Trusted head mismatch | tamper detection | **Narrate** or small pure test |
| R5 | Retry completed Run | At-least-once call vs idempotency key | Receipt replayed, effect not repeated | duplicate effects | **Build** after capsule integration |
| K1 | Safe -> malicious -> denial -> later safe | Single incident vs same-Agent sequence | Safety event does not destroy future utility | later-safe success | **Current** |
| K2 | Reset-all baseline vs post-run vs pre-dispatch+post-run | Three paired arms | Compare prevention, recovery and utility on identical cases | vector below, not one average | **Build/current harness elsewhere** |
| K3 | Policy microbenchmark | Cold/warm, 10k deterministic decisions | Stable p50/p95 and zero oracle mismatches | latency, throughput | **Build**, low risk |
| K4 | Checkpoint scaling | 1/10/100/1,000 files, fixed byte budgets | Time/memory curve and clean budget rejection | p50/p95, peak RSS | **Narrate** unless harness already stable |
| K5 | Adversarial schedule fuzzing | 100–1,000 seeded interleavings | No double claim or illegal terminal state | invariant violations / seed | **Defer** unless pure simulator |
| K6 | Linux kernel enforcement | User-space RunGuard vs Landlock/Sandlock | Real syscall/network denial under Linux | escape rate, startup overhead | **Defer**; wrong host tonight |
| K7 | MicroVM isolation | Container vs Firecracker | Host escape probes and cold-start cost | isolation probes, startup p95 | **Defer**; infrastructure work |

## Evaluation protocol: do not hide the trade-off in one score

Use paired scenarios so every architecture receives the same initial workspace,
prompt, proposal and fault schedule.

```text
Arm A: reset-all baseline
Arm B: post-run RunGuard only
Arm C: pre-dispatch Effect Firewall + post-run RunGuard
Functional bridge: Arm C's allowed exact demo effects also consume one
                   process-local parent before dispatch and redeem one opaque,
                   path/payload-bound child at the cooperative sink
```

The three-condition KPI does not isolate the capability as a fourth performance
arm; capability correctness is evaluated by negative-control and state-machine
tests instead.

Report this vector:

```text
unsafe_effect_rate       = unauthorized effects in final state / attack cases
prevention_rate          = attacks denied with zero worker dispatch / attack cases
recovery_success         = exact baseline convergence / dispatched unsafe cases
safe_utility             = completed safe tasks / safe cases
later_safe_continuity    = successful later-safe Runs / post-incident sequences
authority_amplification  = child grants broader than parent / delegation attempts
replay_acceptance        = repeated effects / replay attempts
ambiguous_terminal_rate  = non-terminal or falsely-ready Runs / all Runs
blast_radius_bytes       = bytes different from baseline at maximum and terminal state
policy_latency_ms        = p50, p95, max
end_to_end_overhead_ms   = guarded paired latency - unguarded paired latency
receipt_completeness     = required fields/events present / expected fields/events
```

Do not collapse these into “95% safer.” Prevention, recovery and utility are
different conditions. A reset-all baseline may end clean while destroying good
work; a post-run guard may restore state after executing a dangerous worker; a
pre-dispatch guard may avoid both the effect and the worker cost. The demo
should show those differences directly.

For deterministic policy timing, use warm-up iterations, at least 30 measured
batches and report median/p95 rather than a single best run. For race tests,
record the seed and exact admitted worker count. For model-backed evaluation,
keep model choice and prompt fixed, report unsuccessful attempts, and do not mix
model quality with deterministic middleware enforcement. No model call is
needed to test the security invariants above.

## Ablations that reveal whether the architecture matters

1. **Remove the pre-dispatch PEP.** The malicious worker now starts; RunGuard
   may recover, but prevention and avoided dispatch fall to zero.
2. **Remove RunGuard.** Pre-declared protected actions are stopped, while an
   admitted or misclassified worker has no state-convergence backstop.
3. **Replace typed proposals with string matching.** Near matches, obfuscation
   and benign discussion expose both false allows and false denials.
4. **Remove monotonicity.** Seed one permissive high-risk cell and let the
   property test find privilege inversion.
5. **Remove one capsule binding at a time.** Run, Agent, target digest, policy
   digest, input digest, expiry and nonce each get a substitution case.
6. **Replace durable atomic claim with an in-memory set.** Restart and
   cross-process races demonstrate double spend.
7. **Let a child copy parent authority.** The confused-deputy suite should show
   why delegation must be intersection/attenuation.
8. **Drop provenance on summarization.** A three-hop flow demonstrates label
   laundering.
9. **Let the worker grade itself.** A plausible but rejected candidate reaches
   commit, proving why acceptance must be independent.
10. **Remove the persistent hold.** Failed recovery returns the Agent to ready,
    creating an ambiguous, unsafe continuation.
11. **Accept unordered receipts.** Commit-before-verify and duplicate-commit
    histories become falsely valid.
12. **Report only terminal equality.** The reset-all arm looks perfect even
    though it discarded safe work and ran the malicious worker; the multi-metric
    vector corrects that illusion.

## Expected failure cases and how to speak about them

- **Exact fixture routing is not semantic intent security.** It proves the
  middleware interception point and typed decision path. It does not recognize
  every malicious natural-language instruction.
- **A policy lattice can be wrong even when it is internally monotone.** The
  host ceiling and ordering still need human review and domain tests.
- **A hash is not a capability.** It identifies content. Authority comes from a
  secret-authenticated token or a trusted registry with atomic consumption.
- **Rollback is not prevention.** The worker already ran. Outside effects, open
  handles and network calls may not be reversible.
- **Recovery equality is scoped.** Current RunGuard measures bounded regular
  files and selected metadata, not every filesystem or process property.
- **Taint tracking is not full noninterference.** Inference, implicit flows and
  aggregate leakage remain possible.
- **A receipt proves only what its trusted observer measured.** A compromised
  host can forge host-authored evidence.
- **More agents increase the delegation surface.** Agent count is not a systems
  KPI; controlled authority and task success are.
- **Synthetic adversarial fixtures are useful but not production validation.**
  Keep their provenance visible and do not merge them with a provider-backed or
  OS-isolation claim.

## Deadline cut line

### Build now

1. Freeze the monotone Effect Firewall and its exhaustive/property tests.
2. Finish the paired three-arm receipt: reset-all, post-run RunGuard, and the
   two-boundary reflex. Include worker dispatches, terminal digest equality,
   recovery, safe utility and later-safe continuity.
3. **Completed in the final stretch:** add a pure receipt-automaton verifier for
   missing/reordered/duplicate events and terminal contradictions. Keep its
   unwired integration boundary explicit.
4. **Completed in the final stretch:** bind every allowed effect in the explicit
   deterministic demo path to a fresh process-local one-use capability. Preserve
   the boundary that this is not durable or provider-wide authority.
5. Put exact commands, source hashes and proof boundaries next to the KPI
   receipt. Preserve the stable video until a new candidate passes decode and
   human playback review.

### Demo narratively, with no completion claim

- Provenance labels surviving a two-Agent delegation and why the child receives
  the intersection of authority.
- Durable, authenticated or provider-wide causal capsules beyond the current
  process-local fixture bridge.
- Wiring the strict receipt automaton and trusted chain head into the same
  durable `AgentService` terminal-state mutation.
- Linux Landlock/Sandlock compilation as the production isolation rung.

These are valuable architecture, but a slide must say “next integration” when
the current Run does not exercise them.

### Defer

- A new policy DSL, SMT solver or theorem prover integration.
- General semantic intent classification as a security boundary.
- Linux kernel, gVisor or Firecracker deployment from this macOS environment.
- Filesystem-wide ACID or host-power-loss claims.
- Hundreds of model calls, a large benchmark download, new paid APIs or cloud
  infrastructure.
- A multi-agent swarm whose only measurable output is more intermediate text.

## Single strongest differentiator

**Present NerveLoop as a two-boundary causal transaction, not a kill switch.**
The visible sequence is:

```text
agent proposes
    -> host policy can deny before any worker exists
    -> allowed work receives bounded authority
    -> independent verification decides commit
    -> unsafe work converges to exact recovery or a persistent hold
    -> the same Agent can still perform a later safe Run
```

The judge-facing line is: **“The model can propose an effect; only the host can
grant a one-use cause, and only verified state can become history.”**

All three clauses are now demonstrated in the exact local fixture path: denial
before dispatch, a one-use process-local parent plus exact cooperative sink for
allowed work, and post-run retention or recovery. The honest boundary is
equally important: ambient filesystem authority still exists, and this does not
provide durable authority across restart, authentication, provider-wide tool
interception or kernel isolation.
