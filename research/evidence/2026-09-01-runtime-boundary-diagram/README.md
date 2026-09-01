# NerveLoop runtime-boundary diagram

Status: standalone judge-facing candidate; not promoted into the sealed source,
release packet, existing architecture frame, or submission video.

The diagram separates two architectures that must not be presented as one:

- **Fixture lane:** the verified `DEMO_RUNNER=1` typed Effect Firewall and
  process-local exact Effect Sink path. It makes no model or provider call.
- **Non-demo lane:** the implemented `DEMO_RUNNER=0` Codex/Ark runtime path,
  including the pre-run RunGuard checkpoint, process supervisor/timeout and
  post-run RunGuard verification/recovery. The flagship has not executed this
  lane with Ark and has not demonstrated worker termination.

The terminal-state panel renders two alternatives rather than one misleading
sequence. Prevention ends `denied -> worker never started -> asset unchanged ->
same Agent ready`. A separately admitted failure ends `output withheld ->
restored -> same Agent ready`. If recovery fails, the run remains held for an
operator and does not reconnect to the ready state. The open red gate is deliberately
conspicuous so an implementation path cannot be mistaken for provider-backed
proof.

## Files

- `nerveloop-runtime-boundary.svg`: authored 1920 x 1080 source.
- `nerveloop-runtime-boundary.png`: rendered 1920 x 1080 review candidate.
- `receipt.json`: source binding, hashes, rendering facts, and proof boundary.

## Verification

- SVG parsed successfully with `xmllint --noout`.
- PNG reports 1920 x 1080 RGBA through `sips` and `file`.
- The PNG was visually inspected at original resolution: the two lanes, threat
  asset, two alternative terminal branches, legend, and open acceptance gate
  are legible with no observed clipping.

This artifact does not prove an Ark/model-backed Agent Run, observed worker
termination, hostile-process isolation, production security, TikTok access,
deployment, publication, submission, or judge acceptance.
