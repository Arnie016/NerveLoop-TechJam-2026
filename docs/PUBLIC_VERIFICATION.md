# Public verification map

This repository separates checks that can run from the no-video public source
from checks that require the local operational media closure.

## Public CI

The current public workflow completed successfully for commit `38cbdb4`:
<https://github.com/Arnie016/NerveLoop-TechJam-2026/actions/runs/33470693545>.

The `Verify NerveLoop` workflow installs the locked Node 22 dependencies and
runs:

- the exact public-source closure verifier;
- TypeScript checks for the web and server workspaces;
- production builds for both workspaces;
- the independent Effect Firewall oracle and mutation suite;
- the capability and Effect Sink lifecycle lab;
- the three-condition containment/recovery benchmark.

The source contract command checks the declared no-video manifest. The focused
test command deliberately omits the readiness test's operational-media case,
because that case requires MP4 fixtures excluded from this repository.

Together these checks cover source integrity, compilation, pre-dispatch policy behavior,
cooperative capability redemption, the measured reset-all versus Effect
Firewall versus RunGuard comparison, and false-claim rejection. They do not
prove provider-backed execution, hostile-process isolation, production
security, TikTok access or judge acceptance.

## Operational-only flow

The complete same-Agent sequence is exercised by
`scripts/run-track-c-kill-switch-demo.test.mjs` in the local operational
closure:

1. normal cooperative write retained;
2. protected delete denied before worker dispatch;
3. separate admitted ambient mutation detected and rolled back;
4. later-safe cooperative write retained; and
5. the stable fallback video preserved byte-for-byte.

The public source deliberately excludes every MP4, so that final assertion is
not weakened or skipped in public CI. Its sealed local receipt is included at
`research/evidence/2026-09-01-track-c-functional-flow/current.json`; the video
bytes themselves are not published by this repository.

## Latest local focused verification

On 2026-09-01 SGT, 23 focused tests passed across the functional flow,
three-condition benchmark and adversarial matrix. The stable fallback SHA-256
before, after and at recheck was:

`ed34f33a709719569806e21fdc738cca7b6e9c3a5aeda00860e84f1e6ecca2c7`

That is local deterministic evidence, not a public CI result or independent
evaluation.
