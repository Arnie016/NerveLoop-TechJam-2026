# Security policy

## Judge evidence endpoint

`GET /api/judge-evidence` is read-only, inherits the API bearer-token hook and
uses `Cache-Control: no-store`. Non-loopback production requires
`APP_AUTH_TOKEN`; loopback development may intentionally run without one. The
response is a bounded allow-listed projection and excludes candidate source,
held-out seeds, raw receipt paths and evaluator diagnostics. Source checkouts
reconstruct the live scorecard. Production images verify a SHA-256-sealed
sanitized snapshot and return a generic 503 on any absence, symlink, size,
schema, digest or verdict-consistency failure. The adjacent manifest detects
accidental or partial artifact modification; it is not a signature against an
operator who can rewrite the image.

NerveLoop is a hackathon proof of concept. Only the latest revision
on the default branch is supported.

## Report a vulnerability

Send the repository owner or event organizer the affected revision,
reproduction steps, impact, and suggested mitigation. Do not publish
credentials, personal data, or exploit details in an issue.

## Known limitations

- Shared demo token; no user identity, authorization, RBAC, or tenant isolation
- No CSRF protection
- No per-Agent container boundary in ECS mode
- Ordinary local containers, not hardened multi-tenant sandboxes
- Broad outbound network access
- Prompt-triggered command and file execution
- Ark key available to the server and active Runtime container
- Ark key stored in Terraform POC state
- Local advisory metadata lock and exact CAS only; no mandatory or distributed coordination

## Safe use

- Use a dedicated development machine or disposable ECS instance.
- Use a scoped, revocable Ark key and a unique `APP_AUTH_TOKEN`.
- Keep local use on loopback and restrict ECS Web and SSH CIDRs.
- Add HTTPS before sending the shared token over an untrusted network.
- Never mount production data or provide Volcengine account AK/SK to Agents.
- Stop the POC, destroy test resources, and revoke keys after the event.

Codex uses `workspace-write` when Landlock is available. On unsupported kernels,
startup warns and relies on the outer Docker or rootless Podman boundary. This
fallback is not tenant isolation.

## Local candidate-evaluation boundary

The standalone video candidate evaluator is intentionally separate from the
credentialed Runtime container above. It receives no Ark key, workspace mount,
Codex home or network permission. On the tested Mac it layers a deny-default
Seatbelt profile, PATH-only environment, capability-free Node VM realm, process
timeout, JavaScript heap flag and bounded output. Every run first probes outside
file read/write, TCP egress and subprocess denial.

This is hackathon feasibility evidence, not production multi-tenant isolation.
`sandbox-exec` is legacy same-kernel containment, Node VM is not independently a
security boundary, and the heap flag is not a kernel RSS limit. The standalone
synthetic promotion now checks a current Run/lease, unchanged baseline, exact
evaluated bytes, one-use claim, readback and rollback. A local opt-in AgentService
hook now withholds output until post-promotion RunGuard verification, independent
read-only acceptance, authority closure, and a final manifest recheck succeed.
Its bounded durable journal can restore an interrupted exact candidate after an
ordinary process SIGKILL; the service independently requires the full pre-Run
manifest before releasing the Agent. Ordinary startup does not enable this hook.
Sudden power loss, hostile directory races, and production multi-tenant
isolation remain unresolved.

## Metadata-store boundary

The local JSON store uses bounded no-follow regular-file reads, a unique
same-directory exclusive temporary inode, file sync, rename, parent-directory
sync, exact-byte reconciliation, and a persistent process-local poison state for
ambiguous post-rename observations. A cooperative kernel writer lease rejects
live contenders before callback and holds authority across exact baseline
identity/byte checks, callback, commit and release. The current implementation
uses a kernel `flock` on one stable, never-unlinked single-link `0600` inode;
process death releases the retained descriptor automatically, with no PID-based
reaper. Tests exercise ordinary SIGKILL at three commit stages, a real
live-contender/dead-owner/same-inode-successor sequence, stale-instance and
same-byte-inode CAS, unsafe lock symlinks/hard links/modes, temp substitution,
and callback-reference escape.

These controls do not establish power-loss/torn-write durability, mandatory
locking against bypassing writers, hostile same-user pathname-race resistance,
ancestor swaps after canonical-path validation, replication, or disaster
recovery. Linux helper availability is declared in the container image but not
runtime-proven in the current no-daemon environment. Orphaned pre-rename
database temps may retain metadata until an operator or containing fixture
removes them.

## Workspace lifecycle accounting boundary

The opt-in `logical-bytes-v1` governor performs a bounded metadata-only scan of
active Agent workspaces, `.deleted` archives, and retained RunGuard
staging/quarantine directories. It does not follow links or read file contents;
links, hard links, special files, unsafe ownership/modes, unknown root entries,
budget overflow, and concurrent metadata changes make the scan incomplete. Run
admission reserves worst-case growth in the same durable store mutation that
creates the Run, and records a separate durable dispatch immediately before the
runner call. Only a reservation proven not dispatched can be cancelled.

This is cooperative logical-byte admission, not a disk, block, inode, memory,
CPU, GPU, network, tenant, or kernel containment boundary. It cannot prevent
transient within-Run exhaustion or a same-user process that bypasses the
service. Create, instruction update, and archive now use durable, digest-bound
two-phase intents: staging bytes are reserved, exact payloads are fsynced and
renamed, and a fresh process deterministically completes prepared, staged, or
renamed states. Ambiguous states preserve every path and close new admission.
The operator inspection endpoint returns bounded metadata and consistency
digests, not payload contents or filesystem paths. Retry/cancel mutations are
disabled unless `APP_AUTH_TOKEN` is configured, require current ledger, intent,
Agent-CAS, and probe-evidence digests, and revalidate under process-cooperative
per-Agent plus workspace authority. Retry is limited to exact before/stage/after;
cancel is metadata-only and limited to exact-before. Unsafe or mismatched states
retain every path. The shared token is authentication only, not operator RBAC,
identity, or a cryptographic signature over the evidence.
Each operator POST also requires a client UUID. A separate policy-bound,
digest-sealed journal records retry acceptance in the same `JsonStore` commit
as intent reopen and records cancellation in the same commit as intent removal.
Retry becomes terminal only in the same later commit as exact lifecycle
completion or fail-closed reconciliation. Replay checks the action/request
digest before the old intent CAS, so a lost response cannot reapply the action;
the same UUID with different evidence is denied. Accepted entries are never
evicted (maximum 32); terminal entries retain the newest 128. This is a bounded
idempotency cache, not an append-only audit log or operator identity record.
This is ordinary cooperative process-crash recovery, not hostile same-UID
pathname-race resistance or power-loss/torn-write proof. Production availability
still requires native no-clobber/dirfd primitives, an independent
filesystem/container quota, reserve margin, and identity/RBAC plus an external
append-only audit sink when durable attribution beyond the bounded replay window
is required.
