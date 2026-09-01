# NerveLoop: The Effect Firewall for AI Agents

## One-line Summary

Remove the unsafe effect, not the useful agent.

## Paste-Ready Human Story

We began with a mistake. Our prototype let a dangerous action run, rolled back
the damage, and called that prevention. It was not. A clean workspace cannot
tell a judge whether an effect never happened or was repaired later.

NerveLoop grew from that distinction. It is Track C middleware between agent
intent and a repository worker. For the staged protected delete, host policy
refuses authority before dispatch: no worker, no capability, no changed files,
and matching manifests. If admitted work bypasses the cooperative sink,
RunGuard withholds its output and restores the checkpoint. The same local Agent
record can run safely again.

From a clean clone of the exact final bundle, we created an Agent in the Web
UI, retained normal work, triggered the protected denial, showed a separate
rollback, and retained a later safe Run. The 156-second review candidate adds a
17.1-second continuous Chrome compositor capture of that functional
browser-to-API-to-AgentService-to-FixtureRunner path.
The rollback is preserved in its dedicated frame and receipt; the manifest's
final DOM query runs after the later-safe view and therefore reports
`rollbackObserved:false`, so we do not present it as a final-DOM assertion.

The design combines a monotone action-target policy with an opaque, one-use
grant bound to one Run, Agent, file, and payload. Across a 156-case/sequence
matrix, all 28 denied admission cases had zero worker dispatch, while 36/36
protected-path mutations were detected and restored. Five of six
recovery-timing faults restored; removing the workspace parent produced the
expected recovery-failed receipt.

The flagship uses `DEMO_RUNNER=1` and makes zero provider calls; it does not yet
prove the required Ark/model-backed local Runtime Agent run. These are
synthetic local outcomes, not performance or production-security claims. Our
contribution is making prevention, recovery, and safe continuation three
separate, inspectable facts.

## Official Track

**Official challenge: Problem Statement #1 — Agent Launchpad: Design and Build
Lightweight Agent Middleware. Selected subtrack: Track C — The Kill Switch
(Safety and Sandboxing).**

## The Result in 30 Seconds

NerveLoop sits between an agent's proposal and the worker that can change a
repository. In the reproducible judge path, a deterministic `FixtureRunner`
produces `delete_mock_asset` against a `protected` target. The Effect Firewall
denies it before dispatch, so the worker never starts. A separate admitted raw
write then shows the second line: RunGuard catches the post-run drift and
restores the bounded checkpoint. The same Agent finishes a later safe Run
instead of losing its whole session.

Across six deterministic local rounds:

- threat detection was **0% / 100% / 100%**;
- threat worker dispatch was **100% / 0% / 100%**;
- median logical recovery targets were **32 / 0 / 1**; and
- stale escapes were **0 / 0 / 0**

for reset-all, Effect Firewall, and RunGuard respectively. This is evidence
from a small local fixture. It is not a hardened sandbox, a provider benchmark,
or a TikTok-scale result.

## Problem

An autonomous engineer can spend an hour learning a large repository, build up
useful working state, and then propose one bad next step. Today, the operator often
faces a blunt choice: trust the action or kill the session. Both options throw
away something valuable, either safety or useful work.

There is another problem hiding behind the green checkmark. A clean folder can
mean the dangerous action never ran, or that it ran and was repaired later.
Those outcomes can leave identical bytes, but they are not the same safety
result.

NerveLoop starts from one systems rule: the component proposing an action
should not also be the component authorizing it. A prompt can guide an agent,
but it cannot enforce what the host process allows.

## Solution

NerveLoop is a small, host-owned control layer between an agent's intent and its
effect on a workspace. It is not another planner and it is not a stronger
safety prompt. It converts the next proposed effect into a known action and
target, decides whether a worker may start, and records what actually happened.

Our deterministic `DEMO_RUNNER=1` flow tells one end-to-end story on the same
Agent:

1. A normal safe Run is admitted and retained.
2. The deterministic FixtureRunner produces `delete_mock_asset` against a
   `protected` target. The **Effect Firewall** denies it before worker dispatch.
   The receipt records
   `workerSpawned:false`, worker dispatch `0`, `changedFiles: []`, an unchanged
   before manifest equal to the after manifest, and `recovery:not_needed`.
3. A separate admitted fault deliberately bypasses the cooperative write sink
   and changes the protected fixture directly. **RunGuard**, the independent
   second line after execution, withholds the result and restores the bounded
   checkpoint.
4. The same Agent completes a later safe Run and keeps its work.

That distinction is the product. NerveLoop shows whether it prevented an
effect, repaired an admitted fault, or allowed safe work to continue. It does
not collapse every clean ending into the same green badge.

For the one cooperative write in this demo, the host issues a five-second pass
that works once, for one exact Run, file, payload, Agent, and policy. The runner
cannot inspect that pass, create another, or spend it on a different write. The
receipt stores a one-way digest, never the usable bearer.

## Why This Matters

Long-running agents need room to discover their next useful step. Their
operators still need a concrete answer to a simpler question: what was actually
allowed to happen?

NerveLoop separates creativity from authority. The planner can adapt, while
host policy decides what may run. Known forbidden effects can stop before
execution. Admitted work still faces an independent end-of-run check. One bad
step does not automatically erase everything the agent learned before it.

This is deliberately narrower than “solving AI safety.” It gives an engineering
team a reproducible answer that prompts alone cannot provide: did we prevent
the effect, or did we repair it?

## How We Used AI

NerveLoop is designed so an AI planner may inspect a repository, reason about
it, and propose a next action. The host-owned middleware decides whether that
typed action receives authority and whether its result is committed. For
judging, we use a deterministic no-model runner so the same four-Run sequence
can be reproduced without credentials. We are demonstrating middleware
behavior, not model quality or provider interception.

## How We Used Codex

Codex was most useful when it proved our first story wrong. We had shown a
dangerous mutation, rolled it back, and called that prevention. It was not
prevention. We moved the decisive check before worker dispatch and kept
RunGuard as a separate recovery layer.

We then used parallel Codex sessions as builders and skeptical reviewers. They
implemented the policy and sink, generated negative controls, searched for
contradictory receipts, and translated 29 selected primary papers, project
documents, and official technical sources into testable invariants. The local
verifiers decide whether a claim passes; Codex does not grade its own work.

## Key Features

- **Prevention is visible.** Effect Firewall prevention means zero dispatch,
  unchanged state, and no recovery step.
- **Recovery is visible.** RunGuard records that a worker ran, verification
  failed, and one bounded checkpoint was restored.
- **The policy is small enough to inspect.** Five action classes and four target
  classes make a 20-cell policy. Increasing risk or sensitivity can never turn
  a denial into an allow.
- **Allowed work gets the least authority needed.** The runner receives one
  opaque, one-use child for one exact cooperative write. It never receives the
  parent or a minting API.
- **Safe context survives.** The same Agent completes later safe work after the
  protected denial and the separate rollback case.

The underlying primitives are established systems ideas. Our contribution is
to compose them at one lightweight agent-middleware seam and make the causal
difference between prevention and recovery observable.

## Architecture

The clearest one-page judge version is the dual-lane runtime truth map in
[`research/evidence/2026-09-01-runtime-boundary-diagram/nerveloop-runtime-boundary.png`](research/evidence/2026-09-01-runtime-boundary-diagram/nerveloop-runtime-boundary.png).
It keeps the verified fixture path visibly separate from the wired-but-unproven
Ark/Codex path. The longer technical note remains in
[`docs/judge/NERVELOOP-REFLEX-ARCHITECTURE.md`](docs/judge/NERVELOOP-REFLEX-ARCHITECTURE.md).

```text
Agent -> typed effect -> host-owned Effect Firewall
                           | deny -> no worker -> unchanged-state receipt
                           | allow
                           v
                 one-use parent capability
                    issue -> claim -> consume
                           v
              admitted worker + opaque child
                           v
              exact cooperative Effect Sink
                           v
              RunGuard -> retain / restore / hold
                           v
                    same Agent continues
```

AgentService does not accept the policy ceiling, capability lifecycle, sink
binding, workspace verdict, or recovery result from the runner. Those decisions
stay in host code. The runner gets no mint or inspect API, and no parent
capability. It can redeem one opaque child only through the attached port.

That statement is intentionally narrow. The product currently mediates one
exact cooperative `demo-result.md` fixture write. It does not remove ambient
filesystem authority from the process, mediate every possible effect, or create
an OS, container, microVM, or kernel boundary. The deliberate raw `.env` fault
demonstrates that limit: it bypasses the sink, then RunGuard detects and rolls
back the resulting drift.

## What We Measured

Six deterministic local rounds compare a deliberately blunt reset-all baseline
with the two NerveLoop boundaries:

| Result | Reset-all baseline | Effect Firewall | RunGuard rollback |
|---|---:|---:|---:|
| Threat detection | 0% | 100% | 100% |
| Threat worker dispatch | 100% | 0% | 100% |
| First and later safe Runs retained | 0% | 100% | 100% |
| Logical recovery targets, p50 | 32 | 0 | 1 |
| Stale escapes | 0 | 0 | 0 |

Effect Firewall is the only condition that detects the typed threat before a
worker runs, so it needs no recovery. RunGuard allows dispatch, catches the
separate post-run fault, and restores one logical target. Reset-all produces a
clean state by discarding 32 logical targets and all useful work in the fixture.

We also checked all 20 policy cells and all 130 comparable monotonicity
relations. The parser rejected 30/30 malformed proposals. A 24-case
prompt-confusable corpus produced no false or missed matches, and the tests
killed 20/20 deliberately broken policy mutants. A separate state-machine test
matched an independent oracle across all 120 claim/consume traces of length one
through four, covering 426 capability operations.

We then attacked the sink design contract more deeply than the four-Run story.
A separate source-bound reference lab, not the product broker, rejected
32,767/32,767 declared envelope mutations and 63/63
request-context mutations with zero observed escapes. One of 64 concurrent
exact redemptions succeeded. One consumed parent derived only one child;
mutating the caller's buffer after validation did not alter the snapshotted
bytes; expiry, a destination symlink, and a deterministic workspace-root
replacement failed closed. An independent lifecycle oracle matched 120 traces
and 426 operations with zero mismatches.

Those results support the process-local sink design now used for the one exact
fixture write. They do not close concurrent ancestor-swap races, remove ambient
filesystem APIs, or prove every future effect is mediated. A Stop request does
not itself revoke an already-issued child: a non-cooperative runner may redeem
before settling or finish a redemption already awaiting I/O. The Run remains
cancelled and its output is withheld, but that exact policy-authorized write
may commit.

A separate exact-commit stress matrix exercised 156 enumerated local cases and
sequences with zero unexpected assertion failures. All 36 post-run
protected-path mutations were denied and restored; all 28 denied admission
cases had zero worker dispatch; and five of six recovery-timing faults restored
successfully. Removing the workspace parent produced the expected fail-closed
`recovery:failed` outcome. These are synthetic no-model cases, not 156 official
tests, and the post-run mutations prove detection and recovery rather than
pre-dispatch prevention.

Separately, we reran the local POSIX process-supervisor drill against both the
source and compiled server runtimes. Each focused suite passed 3/3 scenarios:
the harness spawned a fixed no-model CLI and one descendant, both
SIGTERM-resistant, and observed their heartbeats stop and both PIDs disappear.
A fresh Agent then completed a normal Run. This is provider-free
integration-test evidence. Those termination and cleanup observations are
test-local; they are not persisted on `AgentRun` or exposed in the UI, and they
are not an Ark/model-backed termination claim.

For a smaller reproducible lifecycle receipt, the
[`standalone owned-child termination proof`](research/evidence/2026-09-01-process-termination-proof/README.md)
revalidates nonce-bound child identity before SIGTERM and SIGKILL, observes the
`SIGKILL` exit, and confirms the exact PID is absent afterward. It is supporting
process evidence, not product integration.

These are finite deterministic local fixtures. They are not a provider-model or
model-quality test. They are not proof of OS confinement, ambient-filesystem
removal, a hardened sandbox, kernel isolation, or production security. They do
not use TikTok data, repositories, APIs, or production access. They do not
establish performance, latency, compute, energy, GPU, or cost improvements.

## Tech Stack

TypeScript, Node.js 22, Fastify, React, Vite, SHA-256-bound receipts,
process-local one-use capabilities, an exact cooperative filesystem sink,
crash-atomic local state, and bounded workspace checkpoints. The judge path is
credential-free and makes no paid model call.

## Judging Criteria Alignment

- **Middleware Works End to End — 40%:** the exact-bundle browser path reaches
  the API, AgentService, and deterministic FixtureRunner. It shows a normal
  retained Run, zero-worker denial, a separate detected-and-restored fault, and
  later safe work on the same Agent. The official real Runtime/Ark Agent Run is
  still an open gate: the typed pre-dispatch proposal branch currently runs
  only with `DEMO_RUNNER=1`, and an explicit separate `terminated` UI state has
  not been demonstrated.
- **Technical Design and Integration — 25%:** the two bounded controls are a
  host-owned action-target admission policy and a run/file/payload-bound,
  one-use sink grant. RunGuard independently checkpoints, verifies, withholds,
  and restores around both fixture and non-demo runner dispatch.
- **Verification and Robustness — 20%:** positive and negative receipts
  distinguish prevention from recovery. The 156-case matrix covers policy
  denial, protected-path drift, recovery faults, zero-worker dispatch, cleanup,
  and later-safe continuation. A separate source-and-compiled supervisor drill
  observes owned worker/descendant cleanup, with its test-local boundary stated.
- **Demo and Reproducibility — 15%:** the Web UI, receipts, one-page
  architecture, setup instructions, and sub-three-minute candidates tell the
  same causal story. Public playback, rights review, and an official judge run
  remain external gates.

## Testing Instructions

From a fresh clone, run `npm ci`, then:

```sh
npm test -w @launchpad/server -- --run \
  src/effect-policy.test.ts src/effect-capability.test.ts \
  src/effect-sink.test.ts src/run-guard.test.ts src/agent-service.test.ts \
  src/effect-receipt-automaton.test.ts
node --test scripts/track-c-condition-benchmark.test.mjs
node --test scripts/effect-firewall-adversarial-matrix.test.mjs
node --test scripts/effect-sink-redemption-lab.test.mjs
npm run test -w @launchpad/server -- src/crash-recovery.test.ts
npm run build -w @launchpad/server
CRASH_DRILL_BUILD=1 npm run test -w @launchpad/server -- src/crash-recovery.test.ts
npm run typecheck -w @launchpad/web
npm run build -w @launchpad/web
npm run submission:source-check
```

For the local walkthrough:

```sh
zsh scripts/start-local-judge-demo.zsh
```

Open <http://127.0.0.1:5173>, enter the documented synthetic local token
`nerveloop-local-judge-demo-2026`, and choose **Stage protected-effect
incident**. Sending the fixed prompt is a separate action. Then send `show the
normal case` on the same Agent to verify later safe continuation. RunGuard's
admitted rollback fixture is a separate second-line case, not pre-dispatch
prevention.

The public video is a receipt-bound explainer generated from the same local
contracts. It is not a substitute for the runnable Playground above: judges
can stage the protected incident themselves and inspect the resulting receipt.

NerveLoop extends the organizer-provided CodeJam Starter Kit: it keeps the
starter's `AgentService` and Run lifecycle as the integration seam, then adds
typed effect admission, one-use authority, an exact cooperative sink, causal
receipts, and bounded recovery around that flow.

The `track-c` text in filenames refers to the selected subtrack, Track C — The
Kill Switch, within official Problem Statement #1: Agent Launchpad.

## Public Demo Link

**Pending.** A public deployment is not presented as evidence.

## Public Repository Link

**Target repository:** <https://github.com/RrankPyramid/CodeJam>

Use the exact signed-out-verified submission branch URL here only after the
reviewed source has been pushed; until then this field remains pending.

## Demo Video

**Public YouTube URL:** Pending.

The recommended upload candidate is a 156.000-second technical cut that follows
one story:

1. an agent with useful repository context proposes a dangerous next move;
2. the proposal becomes `delete_mock_asset / protected`;
3. Effect Firewall denies it with zero worker dispatch and unchanged manifests;
4. the same Agent completes a later safe Run;
5. a separate admitted raw write demonstrates RunGuard's rollback backstop; and
6. the closing comparison shows **32 / 0 / 1** and the honest local-only limits.

It is 1920x1080 H.264 at 24 fps with stereo AAC audio. Its 17.116667-second
browser segment comes from a Chrome DevTools Protocol screencast of an exact
clean bundle: 489 real compositor frames over 17.112 seconds, held on a 60 fps
output grid without inventing intermediate UI states. The retained receipt
records -22.6 LUFS integrated loudness, -9.2 dBTP true peak, no silence of at
least 0.25 seconds, and a successful full audio/video decode. The rollback is
preserved in a dedicated frame and receipt; because the manifest's final DOM
query occurs after the later-safe view, its `rollbackObserved` field is false.
The cut still needs continuous human playback, rights review, and an explicit
promotion decision before upload.
Its exact human voiceover map is in
[`research/2026-09-01-continuous-candidate-voiceover.md`](research/2026-09-01-continuous-candidate-voiceover.md);
no voice was generated or recorded in this pass.

This local candidate does not prove Ark/model execution, TikTok access, a
public upload, or submission. Earlier experiments and the stable fallback stay
in the private evidence archive rather than this public-facing story.

## Screenshot Shot List

1. The typed `delete_mock_asset / protected` proposal entering the Effect
   Firewall.
2. `workerSpawned:false`, worker dispatch `0`, `changedFiles: []`, and matching
   manifests.
3. The normal or later-safe receipt with the exact sink state `committed`.
4. The separate raw-write RunGuard rollback with its unredeemed child revoked.
5. The same-Agent later safe Run and six-round comparison.

## Submission Readiness Notes

The deterministic local fixture and evidence are prepared. The official
Runtime/Ark real-Agent gate, explicit termination-state proof, candidate
playback/rights/promotion, reviewed source push, public video URL, entrant
details, and final Devpost action remain open.

## Known Limitations

- The typed prompt-to-effect route is an exact deterministic fixture, not a
  general natural-language intent classifier.
- The Effect Capability registry is process-local. It is not a durable
  credential, authenticator, provider-wide interceptor, or kernel primitive.
- Both process-local authority registries are capped at 1,024 entries and do
  not yet reclaim terminal entries. Issuance fails closed at that ceiling, so
  this is a demo availability limit, not a production lifecycle design.
- Sink mediation covers one exact cooperative `demo-result.md` fixture write.
  It does not remove ambient filesystem authority or cover every effect.
- The runner receives an opaque one-use child and a redeem-only port, never the
  parent. The receipt persists a grant digest, not the bearer. This remains
  process-local user-space mediation, not authentication or OS confinement.
- RunGuard proves bounded terminal workspace recovery. It cannot prove that no
  transient effect occurred while an admitted worker was running.
- The strict receipt automaton is not yet wired into every AgentService state
  transition.
- The results are local POC evidence, not TikTok-scale or production security
  evidence.

## TODO Official Form Fields

- Team name and team-leader email: entrant-provided
- Registration confirmation: entrant-confirmed
- Problem statement: #1 Agent Launchpad; selected subtrack Track C — The Kill Switch
- Public repository: current source push pending
- Public YouTube URL: pending
- Public demo URL: pending
- Final Devpost submission confirmation: pending
