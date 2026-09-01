# Deep containment matrix

This receipt records a disposable, deterministic local stress experiment against
the final public-source bundle at commit
`16f04073bd46e42b3b0284120da14230d82af8c7`. The experiment made no model,
provider, credential, network, TikTok, deployment, or external-service call.

## What ran

- Four repository-size cells: 4, 16, 64, and 128 files, with six measured
  rounds plus one warmup for each of the reset-all, Effect Firewall, and
  RunGuard conditions. That is 72 measured and 84 total condition sequences.
- Nine synthetic protected-path placements crossed with modify, delete,
  permission-change, and create mutations: 36/36 were denied and restored,
  with zero protected-path strings exposed in receipts. Two ordinary-path
  controls were retained.
- All 20 declared action-target policy cells were classified. Every one of the
  14 denied cells ran both clean and with injected protected drift: 28/28
  produced zero-worker denials; all 14 drift cases restored the baseline.
- Six deterministic post-checkpoint fault timings. Five restored successfully;
  removing the workspace parent produced the expected fail-closed
  `recovery: failed` receipt. There were zero unexpected assertion failures.

The 156 runtime cases/sequences comprise 84 condition sequences, 36 protected
path cases, two ordinary controls, 28 admission cases, and six fault timings.
The 20 policy classifications are reported separately.

## Measured outcomes

Across the repository-size sweep, reset-all / Effect Firewall / RunGuard
produced threat detection of 0% / 100% / 100%, threat dispatch of
100% / 0% / 100%, later-safe retention of 0% / 100% / 100%, and zero stale
escapes in every condition. Logical recovery targets across all size rounds
were p50/p95 16/128 for reset-all, 0/0 for Effect Firewall, and 1/1 for
RunGuard. All declared local outcome gates passed in all four size cells.

Wall timings in `results.json` are uncontrolled observations from one local
host. The reset baseline bypasses AgentService, so those timings are **not a
fair performance comparison and not performance proof**. They support no
latency, CPU, memory, syscall, byte-I/O, energy, cost, or production claim.

## Integrity and boundary

- `results.json` SHA-256:
  `7de571057c760b23f93dbda253897d4365b58b845b14a5239d7728fd4d9e66ba`
- Disposable experiment harness SHA-256:
  `d73af0c7e33bb8b1c3220d64ea67c82b07f66aac679bc9ebef650d6dd986136c`
- The receipt binds the seven exercised middleware and benchmark source files
  by SHA-256.

This is enumerated synthetic local evidence, not hardened isolation, complete
filesystem mediation, production security, model quality, TikTok access,
deployment, submission, or judge acceptance.
