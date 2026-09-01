# NerveLoop judge quickstart

This is the shortest credential-free route to the local NerveLoop middleware
demo. It uses the fixed no-model runner, binds both services to loopback and
does not call Codex, Ark, TikTok, a provider API or cloud infrastructure.

## Prerequisites

- Node.js 22 or newer;
- npm 10 or newer; and
- the repository's locked dependencies already restored.

For a fresh clone, `npm ci` restores the declared dependencies. The launcher
itself never installs, downloads, builds an image or reads provider credentials.

## Preflight without launching

```sh
zsh scripts/start-local-judge-demo.zsh --check
```

Expected terminal marker: `JUDGE_DEMO_PREFLIGHT_PASS`, followed by loopback
URLs, `runner=fixed-no-model` and `launch_performed=false`.

## Start the local demo

```sh
zsh scripts/start-local-judge-demo.zsh
```

Open <http://127.0.0.1:5173/>. When prompted, enter the documented synthetic
local token `nerveloop-local-judge-demo-2026`. The token is not an account or
provider credential and the services are reachable only through loopback.

The launcher deliberately uses API port 3100 to avoid the starter kit's common
port-3000 collision. Override either loopback port when necessary:

```sh
NERVELOOP_DEMO_API_PORT=3200 \
NERVELOOP_DEMO_WEB_PORT=5273 \
zsh scripts/start-local-judge-demo.zsh
```

Press `Ctrl+C` once to terminate the exact two processes owned by the launcher.
It does not kill browsers, containers or unrelated development servers.

## What to inspect

1. Click **Create Agent**, name the disposable workspace, keep the default
   instructions, and submit the dialog. Select that Agent if it is not already
   open. The page must identify **Track #1 — Agent Launchpad** and explain one
   authority boundary: the Agent proposes; host policy decides what may start.
2. Choose **Run the retained workspace-change fixture** and send it. This is the
   initial normal Run: a worker starts, the bounded change is retained, and its
   Effect Capability reaches the `consumed` state. The exact cooperative
   `demo-result.md` write must also finish with sink state `committed`; the
   stored receipt contains a digest, not the opaque child bearer.
3. Click **Stage protected-effect incident**, then explicitly send the loaded
   prompt. The receipt must say **Worker never started**, **Protected state
   verified unchanged**, zero tracked workspace changes, and
   `recovery: not_needed`. It must not contain an Effect Capability: denial
   creates no authority.
4. Choose **Run the protected-path denial fixture** and send it. This is the
   deliberately admitted second-line case: a worker starts, RunGuard detects
   a raw ambient `.env` write, the unredeemed sink child closes, and the receipt
   says `recovery: rolled_back`. It must not be described as pre-dispatch
   prevention or proof that ambient filesystem authority was removed.
5. Send `show the normal case` on the same Agent. The story should change to
   **Later safe Run retained** only after that retained receipt exists. Open the
   Evidence vault only when the benchmark or exact runtime receipts are useful.

These are inspection instructions, not proof of a public deployment or external
submission. The deterministic fixture does not call a model or TikTok service.

## Verify the public source package

```sh
npm test -w @launchpad/server -- --run \
  src/effect-policy.test.ts src/effect-capability.test.ts \
  src/effect-sink.test.ts src/run-guard.test.ts src/agent-service.test.ts \
  src/effect-receipt-automaton.test.ts
node --test scripts/track-c-condition-benchmark.test.mjs
node --test scripts/effect-firewall-adversarial-matrix.test.mjs
node --test scripts/effect-sink-redemption-lab.test.mjs
npm run typecheck -w @launchpad/web
npm run build -w @launchpad/web
npm run submission:source-check
```

These commands run in the declared 104-path public source closure, which contains
no MP4. They verify the policy lattice, one-use capability lifecycle, focused
AgentService behavior, three-condition benchmark, adversarial matrix, receipt
automaton, adversarial sink-redemption experiment and current web build without
retiming unrelated GPU or sibling experiments. AgentService and FixtureRunner
now mediate one exact cooperative `demo-result.md` write through that sink
shape. This remains process-local user-space mediation: it does not remove
ambient filesystem authority, cover every effect, or create OS confinement.

## Verify the locally supplied media package

After a human has deliberately supplied the exact candidate and stable fallback
listed in `docs/TRACK1_RELEASE_GATE.md`, run:

```sh
node --test scripts/run-track-c-kill-switch-demo.test.mjs
npm run submission:story-check
node --test scripts/render-effect-firewall-candidate.test.mjs
node scripts/render-effect-firewall-candidate.mjs --verify-only
npm run submission:final-check
```

The media-supplied final command exits zero only when the current 104-path no-video source
contract, 108-path operational contract, Devpost title/tagline, candidate bytes,
source bindings and judge-story claims align. Its successful status is
`LOCAL_CANDIDATE_READY_EXTERNAL_GATES_OPEN`: human playback, public repository,
YouTube, team fields and Devpost submission remain explicitly false. `npm run
submission:source-check` remains the correct public-clone command. The older
`submission:check` command audits historical fallback-video artifacts and is
not the final Effect Firewall judge route.

## Boundary

This route proves only a local controlled fixture on the checked-out source. It
does not prove provider-model intelligence, TikTok access, production scale,
public deployment, Devpost submission or judge acceptance.
