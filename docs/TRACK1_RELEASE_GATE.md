# Track #1 source release gate

## Current external state — 2026-09-01 SGT

The release actions below have now been completed with entrant authorization:

- reviewed no-video source is public at
  <https://github.com/Arnie016/NerveLoop-TechJam-2026>;
- public `main` is commit
  `38cbdb4b5113922e67cbd5fceb3cf1ab6a005037`;
- the remote `Verify NerveLoop` workflow completed successfully at
  <https://github.com/Arnie016/NerveLoop-TechJam-2026/actions/runs/33470693545>;
- the 156-second captioned demo is Unlisted at
  <https://youtu.be/5kj5CO14tBU>, and YouTube reported no copyright issues
  during its upload check; and
- the public Devpost portfolio page at
  <https://devpost.com/software/nerveloop-the-effect-firewall-for-ai-agents>
  was saved with the video, repository, rewritten story and four gallery cards.

An unauthenticated read returned HTTP 200 and found both the YouTube video ID
and repository URL in the public Devpost page. This proves the portfolio page,
not an organizer-approved update to the frozen pre-deadline hackathon
submission. Submission `1165259` was made before the cutoff; whether the later
portfolio edits are included in judging still requires organizer confirmation.

The stable fallback remains local and byte-identical at SHA-256
`ed34f33a709719569806e21fdc738cca7b6e9c3a5aeda00860e84f1e6ecca2c7`.

The remainder of this document preserves the pre-publication gate design and
its proof boundaries.

This gate exists because the current checkout is a working lab, not a ready-made
public repository. A useful demo, a passing focused test and a locally present
file do not answer the release question: **which exact files can a stranger
clone, understand and reproduce without receiving runtime state, credentials,
historical render debris or an obsolete story?**

`scripts/audit-track1-release.mjs` makes that question reviewable. It is local,
read-only except for its optional JSON receipt, and deliberately incapable of
returning an automatic “safe to push” verdict.

## Run it

```sh
node --test scripts/audit-track1-release.test.mjs
node scripts/audit-track1-release.mjs --write-receipt
```

The second command exits with code `1` by design and writes:

```text
research/evidence/2026-09-01-track1-release-audit/audit.json
```

`REVIEW_REQUIRED` is the only release status. The receipt can show that a local
class of findings is empty, but it never grants permission to commit, push,
upload or submit.

## Operational closure manifest

[`docs/TRACK1_OPERATIONAL_CLOSURE.txt`](TRACK1_OPERATIONAL_CLOSURE.txt) is the
explicit 108-path local rehearsal bundle. It closes the runtime import graph,
Vite assets, focused verifiers, current receipts, and human-selected media.
It is larger than the conceptual essential groups below because a judge must be
able to build and start the product, not merely read the flagship mechanism.
The manifest is a review target, not automatic Git selection: every video and
other media path still remains behind the human playback, rights, and upload
gates in this document.

[`docs/TRACK1_PUBLIC_SOURCE_CLOSURE.txt`](TRACK1_PUBLIC_SOURCE_CLOSURE.txt) is
the separate 104-path, no-video source contract used for the public-source
commands. When those commands execute successfully in a fresh copy, they verify
install, focused middleware behavior and the web build without silently
publishing any MP4. The manifest by itself is only a selection contract. It is not the full runtime-media
experience: the two incident-room clips and both submission cuts stay in the
108-path local operational manifest until a human approves their rights and use.

## Exact essential review surface

The audit names every required path and records whether it is absent,
tracked-and-unchanged, tracked-and-changed, untracked, or outside Git’s proposed
publication set. The groups are intentionally narrow:

| Group | What belongs | What does not automatically belong |
|---|---|---|
| Project contract | install lockfile, license, security policy, ignore rules, environment template, public README | real environment files or machine state |
| Track #1 middleware source | `AgentService`, one-use effect capability, exact cooperative Effect Sink, Effect Firewall, FixtureRunner integration, RunGuard, terminal receipt automaton and their focused tests | unrelated experiments merely because they exist |
| Judge UI source | current Effect Firewall story, API/types and web build surface | screenshots and renders from older stories |
| Track #1 reproducibility | functional flow, three-arm comparison, adversarial matrix, product sink tests, deeper sink-redemption lab and their tests | every script accumulated during the hackathon |
| Human judge docs | Devpost draft, quick start, current opening contract, architecture and deep-systems notes | stale lettered-track prose or unsupported performance claims |
| Curated current evidence | the three flagship receipts plus the deeper sink-redemption receipt and human boundary note | the entire historical `research/evidence` archive |
| Current static media | the named Effect Firewall still generated from the procedural renderer, still subject to visual and rights review | imported screenshots, historical renders, or any video |
| Candidate media verifier/support | deterministic renderer, source-bound JSON sidecar, pinned `font8x8_basic.h` glyph source, sanitized text-only fallback metadata, and fail-closed story verifier | screenshot/voice/video bytes or upload authority |

## Procedural media provenance

The provenance-cleared candidate contract forbids imported screenshots and
images and does not resolve an operating-system font. Scene 05 is a procedural
three-outcome plate generated by the same local renderer as the other eleven
scenes. The renderer parses this exact vendored glyph table:

| Field | Bound value |
|---|---|
| Local path | `research/evidence/2026-09-01-provenance-cleared-media-experiment/font8x8_basic.h` |
| SHA-256 | `49d8df366296b203ca3211bc0672cf2a762135bf12710735b6292756b19dffd5` |
| Upstream | `https://github.com/dhepper/font8x8` |
| Pinned commit | `8e279d2d864e79128e96188a6b9526cfa3fbfef9` |
| Upstream declaration | `Public Domain` |
| Independently adjudicated here | `false` |

That last row is deliberate: the release contract records the upstream
declaration and immutable bytes; it does not turn a source statement into an
independent legal opinion. The font header replaces the older architecture SVG
in both closure manifests, so the public and operational counts remain 104 and
108 respectively. The renderer preflight must identify itself as
`nerveloop.effect-firewall-provenance-cleared-preflight.v1`; the generated
sidecar must use schema
`nerveloop.effect-firewall-provenance-cleared-candidate.v1` and kind
`local-source-bound-procedural-effect-firewall-candidate`. Any older candidate
schema is stale rather than grandfathered into the release.

The legacy string `track-c` is allowed in filenames required for command
compatibility. A literal old lettered-track label in human-facing content is flagged because
the official label is **Track #1: Agent Launchpad: Design and Build Lightweight
Agent Middleware**. A line explicitly marked historical, legacy, migration,
renamed or replaced is retained as a non-blocking review reference instead of
being misclassified as the current product label.

## What is always held back

The scanner reports these by path and rule without reading or printing secret
values:

- `.env` variants other than explicit example/sample/template files;
- `data`, `.data`, `workspaces`, `codex-home`, `.local` and installed
  `node_modules` trees;
- `dist`, `build`, `coverage`, log directories and `*.log` files;
- credential-named files, service-account files, private-key containers and
  local credential configs;
- symlinks, sockets, FIFOs, devices and other special filesystem entries;
- high-confidence private-key and provider-token shapes in otherwise eligible
  small text files. A hit emits only `{ path, rule }`.

Known token shapes are also redacted from every emitted string. If a filename
itself appears to carry a secret value, the path component is replaced by a
one-way digest marker before stdout or receipt output.

The filesystem walk is bounded at 50,000 entries and prunes forbidden
directories. Reaching that bound is itself a blocking review finding.

## Size and media policy

Regular Git files over 50 MiB are warnings and files over 100 MiB are hard
blocks, matching [GitHub’s current documented limits](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github).
The audit does not interpret “below 100 MiB” as “worth publishing.” Repository
health, ownership and clone cost still need human judgment.

Every detected video is listed under `mediaReview.excludedVideos` and
`automaticallyIncludedVideos` is always empty. This includes the old stable
fallback and any newly rendered candidate. The audit can clear a narrower
`localSourceBindingPassed` rung by matching candidate bytes, sidecar, renderer,
declared media metadata and every listed source hash. It deliberately decodes
zero frames and never turns that local binding into publication approval. A
candidate can only enter a later human-selected release after an independent
reviewer checks all of the following:

1. exact path and SHA-256;
2. duration and audio/video codecs;
3. successful playback and readable opening frame;
4. narrative match to the current Effect Firewall contract;
5. <=3-minute Devpost requirement;
6. asset/voice/music ownership;
7. explicit approval to upload it.

The source audit does not create that validation receipt and cannot satisfy the
upload gate.

## Public source-only clean-clone contract

The JSON records these commands as **not executed by the audit**. Run them on
the exact proposed commit in a fresh temporary clone. This contract needs no
MP4 and deliberately does not run the media-dependent story verifier:

```sh
npm ci
npm test -w @launchpad/server -- --run \
  src/effect-policy.test.ts src/effect-capability.test.ts src/run-guard.test.ts \
  src/agent-service.test.ts src/effect-receipt-automaton.test.ts src/effect-sink.test.ts
node --test scripts/effect-firewall-adversarial-matrix.test.mjs
node --test scripts/effect-sink-redemption-lab.test.mjs
node --test scripts/track-c-condition-benchmark.test.mjs
./node_modules/.bin/tsx scripts/track-c-condition-benchmark.mjs --json
npm run typecheck -w @launchpad/web
npm run build -w @launchpad/web
npm run submission:source-check
```

The receipt records these as `publicSourceReproductionCommands`. A local dirty
worktree pass is not a clean-clone pass. Likewise, the presence of a public
repository URL does not prove that the current implementation is at that URL.

## Local media-supplied review contract

These are a separate, non-publication contract. Run them only after a human has
selected and locally supplied both exact files:

| Role | Local path | Required SHA-256 |
|---|---|---|
| Current candidate | `docs/demo/nerveloop-effect-firewall-candidate.mp4` | `1884b05ad3e8350c8e4b0aa8322d1b47388f1ff9392f7be985cc73467b8df36e` |
| Stable fallback | `docs/demo/nerveloop-submission-draft.mp4` | `ed34f33a709719569806e21fdc738cca7b6e9c3a5aeda00860e84f1e6ecca2c7` |

With those human-selected files present, run:

```sh
node --test scripts/run-track-c-kill-switch-demo.test.mjs
npm run submission:story-check
node --test scripts/render-effect-firewall-candidate.test.mjs
node scripts/render-effect-firewall-candidate.mjs --verify-only
npm run submission:final-check
```

The receipt records these as `localMediaSuppliedReviewCommands`, with both
required paths and hashes attached to every command. These commands do not make
either video part of the automatic Git selection, do not replace continuous
human playback or rights review, and do not authorize upload.

## Receipt safety and freshness

The writer has one fixed destination. It rejects a symlinked audit root,
symlinked parent component, symlinked destination and any CLI attempt to select
another output file. The final file is opened with the platform's no-follow
flag. The story contract is parsed only when the filesystem walk proved it is
a safe regular file; a symlink is reported, never followed.

Each receipt binds the current Git `HEAD`, Git inventory digest and a working
tree metadata digest. The receipt excludes its own output file from the latter
to avoid a self-changing digest. These are freshness tripwires, not content or
release attestations: rerun after any source, story, evidence or media change.

## Human publication checklist

- Read the captured tracked/untracked/category counts in a freshly rerun JSON receipt;
  never bulk-add this checkout.
- Select only the essential paths plus any individually justified support
  file. Treat the large historical evidence/media categories as opt-in.
- Resolve every forbidden-path, sensitive-content, stale-label, symlink,
  special-file and size finding.
- Review source, dependency, font, still-image, music, voice and video rights.
- Run the public source-only clean-clone contract and bind results to the exact
  commit SHA.
- After human selection, supply both exact hash-matched MP4s and run the local
  media review contract without treating that as publication approval.
- Independently validate one final video, then verify its public YouTube URL
  from an unauthenticated surface.
- Verify the public repository commit from an unauthenticated surface.
- Obtain entrant approval for the exact commit and media before pushing or
  submitting.

## Proof boundary

This is a local names/metadata/bounded-pattern audit. It does not prove the
absence of every secret, dependency safety, license compliance, production
security, public reproducibility, media quality, remote parity, or a completed
Devpost submission. The external authority gate remains open until the entrant
reviews and explicitly approves the exact release.
