# NerveLoop Effect Firewall architecture

Date: 1 September 2026 (SGT)

Status: executable local middleware contract, backed by deterministic receipts.
It is not a production-security, model-quality, TikTok-access, or performance
claim.

## Official track and scenario

**Track #1: Agent Launchpad: Design and Build Lightweight Agent Middleware**

“The Kill Switch” is the demonstration scenario, not the official track name.

## Product thesis

> **Remove the unsafe effect, not the useful agent.**

Long-horizon coding work is dynamic: the correct next investigation is not
known in advance. Authority does not need to be dynamic. NerveLoop separates a
planner that proposes work from host-owned middleware that decides which
effects may cross into a worker.

## Control topology

```text
                     PLANNING PLANE
             Agent reasons, adapts, proposes
                            |
                     typed EffectProposal
                            |
                            v
          +---------------------------------------+
          | Effect Firewall · host reference gate |
          | operation x target x policy ceiling   |
          +---------------------------------------+
                   | ALLOW              | DENY
                   v                    v
          one-use parent          denial receipt
                   |               workerSpawned:false
                   v               manifest unchanged
       admitted worker + child      recovery:not_needed
                   |
                   v
       exact cooperative effect sink
         commit or terminal close
                   |
                   v
        +-------------------------+
        | RunGuard · second line  |
        | checkpoint + verify     |
        +-------------------------+
          | pass       | fail       | unknown
          v            v            v
        RETAIN       RESTORE        HOLD
          \____________|____________/
                       |
                same Agent ready
```

The upper gate is preventative. The lower gate is compensating. Conflating
them would erase the most important proof distinction in the product.

### Allowed-path authority: parent to exact sink child

Keep this detail out of the denial opening; it is the exact allowed-path answer
for architecture Q&A. In the explicit no-model `DEMO_RUNNER=1` path, an allowed
typed decision creates one process-local Effect Capability with a default
five-second lifetime and one-use budget. The grant is bound to the exact Run,
Agent, action, target class, policy name, policy version, and digest of the full
host policy table.

AgentService persists the monotone parent transition `issued -> claimed ->
consumed`, then attenuates the consumed parent into one opaque child bound to
the canonical workspace identity, exact `demo-result.md` path, exact payload
digest and an expiry no later than its parent. A denied proposal returns before
this sequence and receives no Effect Capability.

The runner never receives the parent, the policy table, or a mint/inspect API.
It receives only the child bearer and a redeem-only port. `FixtureRunner`
redeems that child immediately where its cooperative `writeFile` used to be.
The sink checks the Run, Agent, action, target, root, path, payload and lifetime,
then performs a same-filesystem atomic replace. The persisted receipt contains a
domain-separated grant digest, not the bearer.

The current product path produces distinct parent grants for the normal,
admitted-fault, and later-safe Runs. The cooperative normal and later-safe
writes finish with sink state `committed`. The deliberate raw `.env` fault does
not redeem its child, so host closure records `revoked / unredeemed` before
RunGuard restores the workspace. The pre-dispatch protected denial receives
neither parent nor child.

This is process-local mediation for one exact cooperative fixture effect. It is
not authentication, durable authority, provider-wide interception, ambient
filesystem removal, OS/kernel isolation, or authority that survives restart.
Node's path-based APIs also leave concurrent ancestor-swap races outside the
claim.

## Typed effect contract

The current judge fixture binds an exact local prompt to this proposal:

```ts
type EffectProposal = {
  action: "delete_mock_asset";
  targetClass: "protected";
};
```

The fixture prompt itself is not the policy. Host code parses the known local
fixture into typed fields; `effect-firewall-v1` applies a closed operation and
target lattice. `delete_mock_asset / protected` exceeds the allowed authority
ceiling and is denied before `runner.run` can be called. Unknown or malformed
proposals fail closed.

This proves one exact typed route. It does not prove general natural-language
intent classification or arbitrary model safety.

## State and evidence contract

### Pre-dispatch branch

```text
PROPOSED -> CLASSIFIED -> POLICY_DENIED -> TERMINAL_DENIAL
```

A valid terminal-denial receipt requires all of the following:

```text
effect verdict == denied
AND workerSpawned == false
AND workerDispatchDelta == 0
AND changedFiles == []
AND beforeManifestDigest == afterManifestDigest
AND protected baseline bytes are identical
AND recovery == not_needed
```

“Denied” alone is not enough. The unchanged baseline and zero-dispatch facts
are independently recorded so a late cleanup cannot masquerade as prevention.

### Admitted branch

```text
CHECKPOINTED
  -> POLICY_ALLOWED
  -> PARENT_ISSUED -> CLAIMED -> CONSUMED
  -> CHILD_ISSUED
  -> WORKER_DISPATCHED
     -> SINK_COMMITTED
        -> WORKSPACE_VERIFIED [optional task acceptance when requested]
           -> RETAINED
           -> RESTORING -> RESTORED
           -> INDETERMINATE -> RECOVERY_HOLD
     -> CHILD_REVOKED | EFFECT_FAILED
        -> RESULT_WITHHELD -> RESTORED | RECOVERY_HOLD
```

RunGuard is a separate post-run backstop. It compares terminal state against a
bounded checkpoint and policy, withholds rejected output, supervises cleanup,
and restores or holds instead of treating ambiguity as success. It does not
prove that a transient write never occurred during admitted execution.

The exact cooperative `demo-result.md` write is sink-mediated. Other filesystem
writes in the same host process remain ambient. That is why the deliberately
admitted raw `.env` branch is useful: it bypasses the sink, its unredeemed child
is revoked, and RunGuard proves the independent terminal rollback path. This
composition is defense in depth, not hostile-process confinement.

### Continuity branch

After either a pre-dispatch denial or proved restoration, the Agent may return
to ready. The current deterministic flow retains a later safe Run on the same
Agent. This is crucial product evidence: policy removes an effect, not the
verified workspace and Agent record. It does not prove provider-thread or full
reasoning-context continuity.

## Why this composition is distinctive

The primitives are established; the contribution is their judge-visible
composition at a lightweight middleware seam:

1. **Intent and authority live on different planes.** The planner may be
   creative, but cannot mint capabilities or alter the policy ceiling.
2. **Effects are typed before authority exists.** Policy evaluates operation
   and target classes, not persuasive prompt language.
3. **Prevention and compensation have different receipts.** Zero dispatch plus
   unchanged state proves a stronger condition than successful rollback.
4. **Allowed authority narrows again at the effect.** A runner receives one
   opaque child for one exact path and payload, never its parent.
5. **Terminal state is fail-closed.** Retain, restore, or hold are explicit;
   a crash or ambiguous verifier is never silently called success.
6. **Safe continuity is first-class.** A denied effect does not reset the
   planner. Same-Agent later-safe retention tests whether safety destroyed
   useful work.
7. **Every headline maps to observable fields.** The UI story is driven from
   Run receipts rather than a staged “later safe” animation.

This draws on reference monitors, capability security, transaction/Saga
compensation, actor supervision, and control-plane/data-plane separation. It
does not claim a new neuroscience mechanism. The “reflex” analogy names the
fast host-owned path that acts before the slower planner can widen authority.

## Current local evidence

The functional flow receipt records one same-Agent sequence:

| Phase | Worker delta | Sink evidence | Terminal result |
|---|---:|---|---|
| Normal safe Run | 1 | exact cooperative write `committed` | retained |
| `delete_mock_asset / protected` | 0 | no parent or child issued | denied before dispatch; state unchanged |
| Separate admitted raw-write fault | 1 | child `revoked / unredeemed` | RunGuard `rolled_back`; protected bytes restored |
| Later safe Run | 1 | fresh exact cooperative write `committed` | retained on the same Agent |

The denial has `workerSpawned:false`, matching before/after manifest digests,
an empty changed-file set, and no provider dispatch.

## Three-condition systems result

Six rotated rounds compared a reset-all baseline, Effect Firewall, and RunGuard
rollback on one fixed owned disposable fixture:

| Metric | Reset-all baseline | Effect Firewall | RunGuard rollback |
|---|---:|---:|---:|
| Detection | 0% | 100% | 100% |
| Threat worker dispatch | 100% | 0% | 100% |
| Logical recovery targets, p50 | 32 | 0 | 1 |
| Stale escapes | 0 | 0 | 0 |
| Later safe retention | 0% | 100% | 100% |

Canonical shorthand: **Detection: 0% / 100% / 100%; threat dispatch: 100% /
0% / 100%; logical recovery targets: 32 / 0 / 1; stale escapes: 0.**

The p50 recovery count is logical workspace path targets, not syscalls, bytes,
CPU cycles, energy, latency, or cost. The observed wall-clock values are
descriptive only: host load was uncontrolled and the direct baseline bypasses
AgentService. No performance ranking is supported.

## Secondary media workload

DecodeBridge provides a real owned MP4 correctness case downstream of admitted
execution: hardware decode, frame/audio evidence, CPU/Metal parity, temporal
selection, and independent acceptance. It illustrates that the lifecycle can
govern more than a toy text file. It is not semantic video understanding, a
TikTok workload, model training, or the opening mechanism.

## Proof boundaries

### Proved locally

- one deterministic no-model AgentService fixture routes an exact typed
  protected-delete proposal to pre-dispatch denial;
- its worker dispatch delta is zero and the tracked/protected baseline is
  unchanged without recovery;
- normal and later-safe fixture Runs redeem fresh opaque children for the one
  exact cooperative `demo-result.md` write; the parent is not passed to the
  runner and the stored receipt contains no bearer;
- unredeemed or in-flight fixture children close when the runner settles;
- a separate admitted fault dispatches and is rolled back by RunGuard;
- the same Agent later retains safe work;
- six fixed-fixture rounds produced the three-condition outcome counts above,
  with zero stale escapes.

### Not proved

- TikTok repository, data, API, user, fleet, or production access;
- provider/model-backed behavior, semantic intent detection, or model quality;
- ambient-filesystem removal, all-effect mediation, a hardened sandbox, kernel
  or microVM isolation, hostile-process containment, complete policy coverage,
  or multi-tenant security;
- preemptive cancellation of a policy-authorized redemption already awaiting
  I/O before the runner settles;
- cloud, distributed, GPU, latency, compute, energy, monetary, or production
  performance;
- deployment, public upload, submission, acceptance, or judge outcome.

## Candidate artifact boundary

The intended current local cut is
`docs/demo/nerveloop-effect-firewall-candidate.mp4`, with a separate JSON
sidecar. The judge-story verifier accepts `candidateMediaReady: true` only when
all of these machine checks agree:

- exact candidate and sidecar hashes;
- duration no longer than 180 seconds;
- 1920×1080 H.264 `yuv420p` video at 24 fps plus 48 kHz stereo AAC audio;
- the exact 12-scene normal -> protected denial -> later-safe -> RunGuard
  rollback -> six-round KPI arc;
- seven freshly decoded sample-frame hashes;
- all declared source bindings still matching current repository bytes,
  including Effect Capability, Effect Sink, AgentService, and FixtureRunner;
- the typed receipt, same-Agent continuity, rollback, KPI and proof-boundary
  fields still matching their independent structured evidence.

The expected candidate is 139.875 seconds and text-led. Its AAC track is a
deterministic sound bed; no voice or narration is claimed. A changed functional
receipt, policy source, RunGuard source, visual, renderer, sample frame, or
container byte makes the candidate stale rather than silently “close enough.”

These machine checks do not prove continuous human playback. A contact sheet
or seven sampled frames are not equivalent to watching the complete local file
with sound. They also do not turn a local MP4 into a public YouTube upload or a
verified Devpost submission.

Global release therefore remains blocked on exactly:

- `human-playback-review`;
- `public-youtube-upload`;
- `devpost-submission-verified`.

The stable 159-second rendered MP4 remains byte-identical as an older fallback.
Its public text-only storyboard metadata was sanitized to remove historical
screenshot paths and to mark the private Samantha voice boundary explicitly.
The fallback predates the Effect Firewall-first candidate and does not reflect
its final story. A verifier must refuse to write a current release receipt while
any human or public gate remains open.
