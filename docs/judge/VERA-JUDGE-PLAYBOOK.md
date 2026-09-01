# NerveLoop judge playbook

Date: 1 September 2026 (SGT)

Status: local candidate and judge-story contract. It does not prove continuous
human playback review, a public YouTube upload, a Devpost submission, judge
acceptance, TikTok access, or provider/model behavior.

## Official track

**Track #1: Agent Launchpad: Design and Build Lightweight Agent Middleware**

“The Kill Switch” is the demonstration scenario, not the official track name.

## The three-second idea

> **Remove the unsafe effect, not the useful agent.**

The opening must make one control transition legible without explanation:

```text
same Agent -> typed delete_mock_asset / protected proposal
           -> host-owned Effect Firewall
           -> DENIED BEFORE DISPATCH
           -> workerSpawned:false · baseline unchanged · recovery:not_needed
```

Do not open on a dashboard, test count, DecodeBridge, rollback, or generic “AI
safety.” Start with the human dilemma: this Agent has useful context, but one
unsafe proposal should not force us to trust it or erase the entire session.
The product is lightweight middleware at the seam between model intent and
worker authority.

## Current local candidate

Use `docs/demo/nerveloop-effect-firewall-candidate.mp4` only when
`node scripts/verify-judge-story-contract.mjs` reports
`candidateMediaReady: true`.

Its sidecar binds the exact MP4, fresh decoded frame samples, media metadata,
the render script, the declared source set, demonstrated claims, and the unchanged
stable fallback. The expected local media facts are:

- SHA-256 `1884b05ad3e8350c8e4b0aa8322d1b47388f1ff9392f7be985cc73467b8df36e`;
- 139.875 seconds, below the 180-second limit;
- 1920×1080 H.264 `yuv420p` video at 24 fps and 48 kHz stereo AAC audio;
- 12 scenes, seven decoded sample-frame hashes, and ten source bindings that
  include Effect Capability, Effect Sink, AgentService, FixtureRunner and the
  exact parsed bitmap-font header directly;
- procedural pixel plates with zero imported screenshots/images and no
  operating-system font resolution; and
- text-led presentation with a deterministic sound bed and **no voice or narration**.

The glyph table is the vendored `font8x8_basic.h` from
`dhepper/font8x8`, pinned to commit
`8e279d2d864e79128e96188a6b9526cfa3fbfef9` with header SHA-256
`49d8df366296b203ca3211bc0672cf2a762135bf12710735b6292756b19dffd5`.
Upstream declares it Public Domain. We bind that declaration and the bytes; we
do not claim an independent legal adjudication.

Those facts are necessary, not sufficient. If any bound source changes, the
candidate is stale until its sidecar is regenerated and all decoded samples
verify again.

## Candidate story arc

### 0:00–0:20 — Normal Run, then protected intent

Establish that one Agent is alive and has retained normal work. Then show the
same Agent proposing the typed effect:

```text
action: delete_mock_asset
targetClass: protected
policy: effect-firewall-v1
```

Say: “The prompt is not the security boundary. Host code evaluates a typed
operation and target before a worker receives authority.”

### 0:20–0:56 — Pre-dispatch denial and proof

Freeze on the denial path and read only the decisive receipt fields:

- `workerSpawned: false` and worker dispatch delta `0`;
- `changedFiles: []`;
- before-manifest digest equals after-manifest digest;
- `recovery: not_needed`.

Say: “This is prevention, not cleanup. The baseline is unchanged because the
worker never received dispatch authority.”

### 0:56–1:06 — Same-Agent safe continuation

Show the later safe fixture retained on the same Agent. Say: “The effect was
denied; the Agent was not discarded. Safe work continues, and its exact
cooperative write commits through a one-use sink child.”

Do not infer or animate this state. It is valid only while the bound functional
receipt still proves the same-Agent sequence.

### 1:06–1:19 — RunGuard rollback backstop

Show the separate post-dispatch fault. It deliberately uses a raw ambient
`.env` write instead of redeeming the cooperative sink child. The child closes
unredeemed; RunGuard detects the protected drift, withholds output, and restores
the bounded checkpoint.

Say: “Effect Firewall prevents typed known-bad effects before dispatch. The
exact safe write commits through a one-use sink. If admitted code bypasses that
cooperative seam, RunGuard is the independent rollback backstop.”

Never describe rollback as proof that every transient write was prevented.

### 1:19–1:46 — Architecture and six-round KPI

```text
proposal -> typed policy -> deny with zero dispatch
                         -> allow -> one-use parent
                                  -> admitted worker + opaque child
                                  -> exact sink commit -> RunGuard
                                                       -> retain / restore / hold
```

The source-bound benchmark ran six rotated rounds under three conditions:

| Metric | Reset-all baseline | Effect Firewall | RunGuard rollback |
|---|---:|---:|---:|
| Threat detected | 0% | 100% | 100% |
| Threat worker dispatch | 100% | 0% | 100% |
| Logical recovery targets, p50 | 32 | 0 | 1 |
| Stale escapes | 0 | 0 | 0 |
| Later safe Run retained | 0% | 100% | 100% |

Read the result as **Detection: 0% / 100% / 100%; threat dispatch: 100% / 0%
/ 100%; logical recovery targets: 32 / 0 / 1; stale escapes: 0.**

These are path-target and outcome counts for one fixed local fixture. Local
latencies are uncontrolled and the reset-all baseline bypasses AgentService.
Do not turn them into a production speed, compute, energy, GPU, cost, or fleet
claim.

### 1:46–2:20 — Adversarial evidence, boundary, close

The finite policy harness checks all 20 lattice cells, 130 comparable
monotonicity relations, 30 malformed or extra-field proposals, and 20
deterministic mutants. This tests one implementation contract, not arbitrary
model intent or production security.

The deeper sink harness adds 32,767/32,767 rejected envelope mutations, 63/63
rejected request-context mutations, one successful writer among 64 concurrent
redemptions, and an independent 120-trace / 426-operation lifecycle oracle.
Present these as adversarial depth for one process-local sink, not as proof of a
general sandbox.

Close with:

> “This is a deterministic, no-model local AgentService fixture. It proves a
> middleware transition, not a hardened sandbox or TikTok production result.
> We remove the unsafe effect, not the useful agent.”

## What to open for questions

### Why is this middleware rather than a better prompt?

Prompts influence intent. The Effect Firewall controls authority in host code.
A malformed proposal fails closed, and a protected destructive proposal receives
no worker dispatch. The proposer cannot rewrite the operation class, target
class, policy ceiling, or receipt.

### Why keep RunGuard after adding pre-dispatch policy?

An allowlist cannot enumerate every bug, compromised tool, race, or incorrect
result. The pre-dispatch gate handles typed known effects cheaply. RunGuard
checkpoints admitted work and independently decides whether its terminal state
may be retained. Prevention and compensation are distinct proof states.

### What crosses the allowed path?

Only in the explicit no-model `DEMO_RUNNER=1` fixture path, an allowed typed
decision gets a process-local parent Effect Capability with a default
five-second lifetime and one-use budget. It binds the exact Run, Agent, action,
target, policy name, policy version, and full-policy digest. AgentService
persists `issued -> claimed -> consumed`, then attenuates the parent into one
opaque child for the exact canonical workspace, `demo-result.md` path, payload
digest and expiry. The protected denial receives no grant.

The runner gets only the child bearer and redeem-only port; it never gets the
parent or a mint/inspect API. The normal and later-safe cooperative writes
commit through the sink. In the deliberate raw-write fault, the child closes
`revoked / unredeemed` before RunGuard restores the workspace. Persisted sink
evidence contains a digest, not the bearer.

This is process-local mediation for one exact cooperative fixture write. It is
not authentication, durable authority, provider-wide interception, ambient
filesystem removal, all-effect mediation, OS/kernel isolation, or a grant that
survives restart.

### Does the Agent still do anything autonomous?

Yes. It can inspect evidence, choose a hypothesis, request a tool, and adapt its
next step. NerveLoop constrains the irreversible boundary, not the reasoning
loop. The later safe Run on the same Agent is the visible continuity proof.

### Is this a production security boundary?

No. The proof is user-space, workspace-scoped middleware using owned disposable
fixtures. The host process still has ambient filesystem APIs. It is not kernel
isolation, a microVM, multi-tenant identity, adversarial model evaluation, or
hostile-process containment.

### Where does DecodeBridge fit?

DecodeBridge is Q&A evidence only. It is a secondary owned MP4 correctness
workload showing how admitted engineering work can be checked against decoded
frame and audio evidence. It is not semantic vision, TikTok data, or part of
the candidate’s central incident arc.

## Playback and public-release gates

The candidate’s machine checks do not replace watching the full 139.875-second
file continuously with sound. A contact sheet or sampled-frame inspection is
not continuous human playback and cannot clear `human-playback-review`.

The local MP4 is not a public YouTube video and is not evidence of Devpost
submission. The judge-story verifier must keep global `releaseReady` false and
must refuse to write a current release receipt while any of these gates remain:

- `human-playback-review`;
- `public-youtube-upload`;
- `devpost-submission-verified`.

The stable 159-second `docs/demo/nerveloop-submission-draft.mp4` remains
byte-identical as an older fallback. It does not reflect the final Effect
Firewall-first narrative and must never be relabelled as the current candidate.

## Never claim

- TikTok repository, dataset, API, user, or production access;
- provider/model-backed safety or model quality from the deterministic fixture;
- ambient-filesystem removal, all-effect mediation, a hardened sandbox,
  hostile-process containment, or complete policy coverage;
- latency, compute, energy, GPU, cost, or production performance improvement;
- voice, narration, continuous human playback, public upload, Devpost
  submission, acceptance, judging, or deployment from local machine checks.
