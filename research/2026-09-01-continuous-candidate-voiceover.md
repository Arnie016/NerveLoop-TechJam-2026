# Human voiceover map for the 156-second continuous-CDP candidate

Use this only with
`research/evidence/2026-09-01-live-playground-demo/nerveloop-continuous-exact-bundle-live-agent-demo-candidate-audiobed.mp4`
(SHA-256
`46a67fb7cb5825ddd26f86a78c21611143ec1e21db848a16ea9b53df1dd58041`).

The browser interaction spans approximately **00:19.500–00:36.617**, with a
0.500-second crossfade at each boundary. The procedural film resumes from its
original 00:20.000 point at output 00:36.117, so later procedural cues use a
16.117-second offset.

The browser segment is a continuous, cursorless Chrome compositor capture from
a clean clone of exact bundle commit
`16f04073bd46e42b3b0284120da14230d82af8c7`. Chrome emitted 489 timestamped
frames over 17.112 seconds. Playback holds the latest observed real compositor
frame on a 60 Hz output grid; it does not synthesize intermediate UI states.
The run is a deterministic `DEMO_RUNNER=1` no-model fixture, not Ark, TikTok,
or production proof.

Read naturally around 140 words per minute. The browser sequence moves quickly,
so keep its lines short and let the four terminal receipts carry the detail.
A rights-cleared human recording still needs a full-speed playback and audio
mix review against the exact export.

| Candidate time | Visual beat | Voiceover |
|---|---|---|
| 00:00.000–00:07.500 | Useful work gives way to a risky next request. | “An agent can do useful work, then ask for one action that should never happen.” |
| 00:09.350–00:17.500 | Host and agent boundary. | “NerveLoop keeps that decision outside the agent. The agent proposes; the host decides what may run.” |
| 00:19.700–00:23.000 | Exact-bundle Web UI; Agent creation and normal Run. | “Exact bundle. Local, deterministic, no model.” |
| 00:23.150–00:26.900 | Protected proposal and pre-dispatch receipt. | “Protected delete denied before dispatch. Worker never starts.” |
| 00:27.050–00:31.000 | Separate admitted fault and RunGuard receipt. | “RunGuard catches drift, withholds output, and restores the checkpoint.” |
| 00:31.150–00:35.800 | Later-safe receipt on the same Agent. | “The same Agent stays ready and retains later-safe work.” |
| 00:36.817–00:43.717 | Typed proposal. | “The fixture becomes a typed action and target. Unknown or extra fields fail closed.” |
| 00:47.517–00:53.517 | Monotone authority gate. | “The rule is small and monotone: greater risk can narrow authority, never widen it.” |
| 01:00.917–01:08.217 | Causal receipt. | “The receipt separates prevention from repair: zero worker dispatch, zero changed files, and no rollback disguised as prevention.” |
| 01:12.217–01:18.617 | Later-safe procedural scene. | “A safe write gets fresh one-use authority and commits on the same Agent.” |
| 01:22.617–01:30.517 | RunGuard procedural scene. | “If admitted work crosses scope, RunGuard verifies, restores, or holds before another Run.” |
| 01:34.917–01:43.417 | Architecture. | “Policy decides. A one-use grant limits the cooperative sink. RunGuard checks the result.” |
| 01:48.317–01:58.917 | Six-round comparison. | “Across six local rounds, reset-all touched thirty-two logical paths, prevention touched zero, and bounded rollback touched one. Those are path counts, not speed.” |
| 02:02.617–02:09.817 | Adversarial matrix. | “The one-hundred-fifty-six-case matrix spans policy denial, protected drift, recovery faults, and safe continuation.” |
| 02:15.017–02:24.217 | Proof boundary. | “The real Runtime already has checkpoint and rollback, but typed pre-dispatch control has not been proven with Ark or a model.” |
| 02:25.417–02:33.917 | Closing principle. | “What we prove is narrower and useful: prevention, recovery, and safe continuation are three different facts.” |

No voice was generated, recorded, or uploaded during this evidence pass.
