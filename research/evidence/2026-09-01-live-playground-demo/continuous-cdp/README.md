# Continuous exact-bundle browser capture

Status: **local review candidate, additive, not submitted**.

This directory preserves a browser-pixels-only Chrome DevTools Protocol
`Page.startScreencast` run against a clean clone of final bundle commit
`16f04073bd46e42b3b0284120da14230d82af8c7`.

## What the clip shows

In one 17.116667-second loopback session, the programmatically driven Web UI:

1. creates an Agent;
2. retains a normal workspace-scoped Run;
3. displays the typed protected-effect denial with `BEFORE DISPATCH`,
   `VERIFIED UNCHANGED`, and `NEVER STARTED`;
4. displays a separate RunGuard denial with `VERIFIED RESTORE`, output
   `WITHHELD`, and safe continuation `READY`; and
5. retains a later safe Run on the same Agent record.

The four-state proof sheet preserves one readable frame from each terminal
state. The raw manifest's final-body `rollbackObserved` boolean is `false`
because the later-safe view replaced the rollback body before the final query.
That boolean has not been rewritten. The rollback action marker and preserved
frame `03-runguard-verified-restore.jpg` visibly show the intermediate receipt;
this is visual evidence, not a corrected machine assertion.

## Capture and resampling

- Raw capture: 489 timestamped JPEG compositor frames over 17.112171 seconds.
- Observed average: 28.576 frames/second; motion-frame gap p50 16.672 ms,
  p95 24.249 ms, maximum static gap 1.058 seconds.
- Timestamp check: 489/489 Chrome monotonic timestamps present and strictly
  increasing.
- Playback encode: the latest observed compositor frame at each 1/60-second
  output tick, producing 1,027 H.264 frames at 1920x1080, 60 fps, `yuv420p`.
- Maximum timestamp quantization from the 60 Hz output grid: 16.667 ms.
- Full browser-clip decode: passed with `ffmpeg -xerror`.

This is a continuous headless browser-content capture, not an OS or camera
recording. It has no cursor or audio. Static pages naturally produce fewer CDP
frames; the documented resampling holds the most recent real compositor frame
and does not synthesize intermediate UI states.

## Combined review candidate

`../nerveloop-continuous-exact-bundle-live-agent-demo-candidate-audiobed.mp4`
inserts the 17.116667-second browser clip into the unchanged 139.875-second
procedural candidate using two 0.5-second visual crossfades. It is exactly
156.000 seconds, 1920x1080, H.264 at 24 fps with 48 kHz stereo AAC, and passed
full audio/video decode. An excerpt from the existing procedural audio bed is
duplicated beneath the browser insert with 0.5-second audio crossfades. No
silence of at least 0.25 seconds was detected; integrated loudness is -22.6
LUFS and true peak is -9.2 dBTP. The video stream is byte-identical to the
first continuous candidate.

The earlier continuous candidate without the `-audiobed` suffix is preserved
as a superseded experiment because its browser section is silent for 16.141
seconds. The original selected procedural film and private fallback were not
overwritten. Human listening must still judge whether the repeated audio phrase
feels compositionally natural.

## Proof boundary

The run uses the documented synthetic local token and `DEMO_RUNNER=1`. It makes
no model, Ark, provider, TikTok, account, paid, deployment, upload, or external
service call. It proves the exact-bundle browser -> Fastify API ->
`AgentService` -> deterministic `FixtureRunner` path. It does not prove an
Ark/model-backed Runtime Run, general model tool interception, observed worker
termination, hostile-process isolation, public playback, rights acceptance,
production security, or Devpost submission.
