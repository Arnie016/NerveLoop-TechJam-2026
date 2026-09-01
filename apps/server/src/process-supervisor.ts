// Runs in a separate Node process, not inside the application server. The IPC
// channel is a lifetime signal: server death closes it even after SIGKILL.
import { spawn, type ChildProcess } from "node:child_process";

const executable = process.argv[2];
if (!executable || !process.connected) process.exit(1);

const groupSignals = process.platform !== "win32";
let child: ChildProcess | undefined;
let stopping = false;
let childClosed = false;
let resultCode = 1;
let cleanupDone = false;
let cleanupFailed = false;

function signalOwned(signal: NodeJS.Signals): boolean {
  if (!child?.pid) return false;
  try {
    if (groupSignals) process.kill(-child.pid, signal);
    else {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      child.kill(signal);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    // Fixed text only: no argv, environment, or filesystem information.
    process.stderr.write("Owned process cleanup could not be confirmed\n");
    cleanupFailed = true;
    return true;
  }
}

function finishIfClosed(): void {
  if (!childClosed || !cleanupDone) return;
  process.exitCode = cleanupFailed ? 1 : resultCode;
  if (process.connected) process.disconnect();
}

function stopOwned(): void {
  if (stopping) return;
  stopping = true;
  if (!signalOwned("SIGTERM")) {
    cleanupDone = true;
    finishIfClosed();
    return;
  }
  // Keep this process alive until escalation even if the leader exits first:
  // descendants can remain in its process group and retain stdout/workspace FDs.
  setTimeout(() => {
    signalOwned("SIGKILL");
    cleanupDone = true;
    finishIfClosed();
  }, 1000);
}

function abandonOutputAndStop(): void {
  // Parent death can also close stdout/stderr before IPC disconnect arrives.
  // Drain the child's pipes so a broken output sink cannot kill this supervisor
  // before it performs group cleanup.
  child?.stdout?.unpipe(process.stdout);
  child?.stderr?.unpipe(process.stderr);
  child?.stdout?.resume();
  child?.stderr?.resume();
  stopOwned();
}

process.on("disconnect", abandonOutputAndStop);
process.stdout.on("error", abandonOutputAndStop);
process.stderr.on("error", abandonOutputAndStop);
process.on("SIGTERM", stopOwned);
process.on("SIGINT", stopOwned);

// Install lifetime handlers before starting any work. No shell is involved.
child = spawn(executable, process.argv.slice(3), {
  cwd: process.cwd(), env: process.env,
  detached: groupSignals,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout!.pipe(process.stdout);
child.stderr!.pipe(process.stderr);
child.once("error", () => {
  resultCode = 1;
  process.stderr.write("Supervised executable could not start\n");
});
child.once("exit", (code) => {
  resultCode = code ?? 1;
  // A successful CLI must not leave background descendants mutating afterward.
  stopOwned();
});
child.once("close", (code) => {
  childClosed = true;
  resultCode = code ?? 1;
  stopOwned();
  finishIfClosed();
});
// Explicit SIGKILL against this supervisor, group escape (setsid), host failure,
// Windows descendant cleanup, and external containers are outside this boundary.
