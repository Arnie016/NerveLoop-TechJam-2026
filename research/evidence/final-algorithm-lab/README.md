# Final algorithm lab: sink-side effect redemption

Official entry: **Track #1: Agent Launchpad: Design and Build Lightweight Agent Middleware**
Scenario: **The Kill Switch**

## Outcome

This isolated experiment tests a stronger sink-side architecture: attenuate a consumed dispatch capability into a one-use envelope bound to the exact Run, Agent, action, target class, policy digest, file path, payload digest, and expiry; then spend it inside a filesystem reference monitor before I/O. The product now has a separately tested cooperative broker for its one exact `demo-result.md` fixture effect; this lab remains an independent adversarial oracle rather than the integration proof.

| Check | Exact local result |
| --- | ---: |
| Production policy lattice | 6 allowed / 14 denied; 0 capabilities issued for denied cells |
| Sink attenuation | 1 exact sink scope accepted / 5 other allowed scopes rejected |
| HMAC envelope mutation combinations | 32767/32767 rejected; 0 escapes |
| Request-context mutation combinations | 63/63 rejected; 0 escapes |
| Exact concurrent redemptions | 1/64 succeeded; 63 rejected |
| Exact expiry boundary | SINK_CAPABILITY_EXPIRED; file created: false |
| Pre-existing symlink fault | SINK_EFFECT_FAILED; external sentinel unchanged: true; grant fail-stopped: true |
| Parent attenuation | second child: SINK_PARENT_ALREADY_DERIVED; one parent/one child: true |
| Workspace-root replacement | SINK_ROOT_CHANGED; external file created: false |
| Mutable payload after validation | snapshotted bytes preserved: true |

| Capability lifecycle oracle | 120 traces / 426 operations; 0 mismatches |

Verdict: **PASS** in 237.589 ms on darwin/arm64.

## Research to design

- [If Agents Were Angels, No Governance Would Be Necessary: Out-of-Band Policy Enforcement at a Trusted Tool Boundary](https://arxiv.org/abs/2608.27646): Keep effect authorization outside agent reasoning and mediate the typed operation and resource at the trusted boundary. This lab does not reproduce the paper's proxy, Cedar core, benchmark, data filtering, or security guarantees.
- [Capsicum: Practical Capabilities for UNIX](https://www.usenix.org/conference/usenixsecurity10/legacy-presentation/capsicum-practical-capabilities-unix): Bind narrowly scoped authority to an object and make the effect path present that authority instead of relying on ambient privilege. This user-space Node prototype is not Capsicum, kernel capability mode, or a hardened sandbox.
- [Macaroons: Cookies with Contextual Caveats for Decentralized Authorization in the Cloud](https://www.ndss-symposium.org/ndss2014/ndss-2014-programme/macaroons-cookies-contextual-caveats-decentralized-authorization-cloud/): Cryptographically bind contextual restrictions such as who, what, where, and when to an authorization token. The envelope below is a process-local HMAC prototype, not a macaroon, delegation system, or distributed credential.
- [TLA+ Model Checking Made Symbolic](https://www.microsoft.com/en-us/research/publication/tla-model-checking-made-symbolic/): Check a finite transition system against explicit safety invariants rather than relying only on example traces. This is a bounded deterministic state-space experiment, not a TLA+ specification or formal proof.

## Honest boundary

This is a deterministic, local, synthetic reference-monitor prototype. The lab harness does **not execute the product broker**; the separate functional receipt and server tests cover the cooperative `AgentService -> FixtureRunner -> demo-result.md` path. The product still leaves ambient Node filesystem authority available to fixture code, so RunGuard remains the rollback backstop. Node's path-based APIs do not close every concurrent ancestor-swap race. This is not authentication, durable/distributed authority, arbitrary race exhaustion, a hardened sandbox, provider interception, production evidence, TikTok integration, or judge acceptance. A production design would need mediation at every real effect sink plus removal of raw sink access from workers.

## Reproduce

```sh
node --test scripts/effect-sink-redemption-lab.test.mjs
node scripts/effect-sink-redemption-lab.mjs --write-evidence --json
```

Receipt payload SHA-256: `d6ef290f143ca3344d25197a17da25b09c0d08973894a43e08469ace8ed40b9e`
Results file SHA-256: `fccd0992fa343a1a6659a1385a4c934c2a31763e58049b41eeb00b2dfcc8ce6f`
