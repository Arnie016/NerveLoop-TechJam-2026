# Standalone owned-child termination proof

Status: **PASS** for one self-contained local process-lifecycle experiment.

This directory demonstrates a narrow fact: a Node parent can prove that one
PID is its own nonce-bound child, request graceful termination, re-prove the
same identity before escalation, signal only that exact child, observe its
exit, and confirm that the exact PID no longer exists.

It is not Ark, model, AgentService, sandbox, hostile-process, or production
security evidence.

## Exact standalone commands and result

Executed from this directory:

```sh
node --check child-stubborn.mjs
node --check run-process-termination-proof.mjs
node ./run-process-termination-proof.mjs
```

All three commands exited successfully. The experiment ran from
`2026-09-01T03:43:13.212Z` through `2026-09-01T03:43:13.641Z` with Node
`/opt/homebrew/Cellar/node/25.8.2/bin/node`.

## Observed lifecycle

| Stage | Exact observation |
|---|---|
| Spawn | Parent PID `91631` spawned one non-detached child, PID `91655`, with nonce `procproof-a150c199-219c-45de-99fa-8642ab6ef6c3`. |
| Pre-SIGTERM identity | ChildProcess PID, spawnfile, script argv, nonce argv, IPC challenge PID, and reported parent PID all matched; `process.kill(91655, 0)` found it alive. |
| Graceful request | Parent called `child.kill('SIGTERM')`; the exact child reported one observed SIGTERM and deliberately stayed alive. |
| Bounded wait | Child did not exit during the `350 ms` escalation window. |
| Pre-SIGKILL identity | A fresh IPC challenge again matched PID `91655`, parent PID `91631`, nonce, spawnfile, and argv; SIGTERM count was `1`. |
| Escalation | Only after that second identity proof, parent called `child.kill('SIGKILL')` on its existing ChildProcess handle. |
| Exit | Node emitted the child's exit event with `code: null` and `signal: SIGKILL`. |
| No-orphan check | The exact PID probe returned `ESRCH`; PID `91655` was no longer alive. |

The append-only machine receipt is [`receipt.jsonl`](receipt.jsonl). It records
the exact spawn API, signal APIs, PIDs, nonce, timestamps, timeouts, identity
checks, exit result, and proof boundary. This run appended one JSON object and
did not truncate an earlier receipt.

## Safety construction

- The runner calls `spawn` exactly once, for `child-stubborn.mjs`.
- It uses a private IPC channel, nonce, child-reported `pid`/`ppid`, Node's
  ChildProcess identity, exact spawn argv, and a zero-signal liveness probe.
- Any ambiguous identity check throws before the next signal. The failure path
  does not send SIGKILL; it disconnects the owned IPC handle and the child has
  its own five-second exit backstop.
- The child contains no process-spawn, network, credential, provider, file
  mutation, or service-port behavior.
- The child inherits the parent process environment because this standalone
  harness does not override `env`. Neither script reads, logs, or uses
  credentials; `credentials: false` in the receipt means no credential use was
  implemented or observed, not that the child environment was sanitized.
- The runner appends its receipt only after completion or a bounded failure.

## Separate product-harness evidence

An independent product test run supplied alongside this experiment executed:

```sh
npm run test -w @launchpad/server -- src/crash-recovery.test.ts
```

At `2026-09-01T11:41:14+08:00`, it exited `0`: 1/1 test file and 3/3 tests
passed in 10.68 seconds, with 10.57 seconds in tests. That is labeled
**product fake-CLI process cleanup evidence**. It was not executed by this
standalone script and is not Ark or provider-backed proof.

## Reproduction and checksum note

Running `node ./run-process-termination-proof.mjs` again creates a new nonce,
spawns only the new run's child, and appends another receipt line. Because the
receipt is append-only, any rerun intentionally changes its checksum; regenerate
`SHA256SUMS.txt` before distributing a later evidence snapshot.
