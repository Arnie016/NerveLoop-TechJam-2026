import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

const maxWriterLockBytes = 2048;

export interface WriterDirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
  mode: number;
}

interface WriterLockIdentity {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  nlink: number;
  uid: number;
}

interface WriterOwner {
  version: 2;
  pid: number;
  nonce: string;
  databasePathSha256: string;
  acquiredAt: number;
  helper: "darwin-lockf" | "linux-flock";
}

export interface WriterLease {
  lockPath: string;
  parent: WriterDirectoryIdentity;
  owner: WriterOwner;
  identity: WriterLockIdentity;
  handle: Awaited<ReturnType<typeof open>>;
}

interface WriterLockHelper {
  path: string;
  args: string[];
  busyExitCode: number;
  kind: WriterOwner["helper"];
}

export type WriterLockTimingStage =
  | "lease_acquire_start"
  | "helper_acquire_start"
  | "helper_acquired"
  | "owner_record_start"
  | "owner_record_written"
  | "owner_parent_validated"
  | "lease_acquired"
  | "lease_release_start"
  | "lease_released";

type WriterLockTimingObserver = (stage: WriterLockTimingStage) => void;

const databasePathDigest = (filePath: string) =>
  createHash("sha256").update(path.resolve(filePath)).digest("hex");

async function writerParent(filePath: string): Promise<WriterDirectoryIdentity> {
  const directoryPath = path.dirname(path.resolve(filePath));
  const allowedCanonicalPath = process.platform === "darwin" &&
      (directoryPath === "/var" || directoryPath.startsWith("/var/") ||
       directoryPath === "/tmp" || directoryPath.startsWith("/tmp/"))
    ? "/private" + directoryPath
    : directoryPath;
  if (await realpath(directoryPath) !== allowedCanonicalPath) {
    throw new Error("JsonStore parent is not a canonical directory");
  }
  const entry = await lstat(directoryPath);
  const expectedUid = process.getuid?.();
  if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o022) !== 0 ||
      (expectedUid !== undefined && entry.uid !== expectedUid)) {
    throw new Error("JsonStore parent is not a safe directory");
  }
  return { path: directoryPath, dev: entry.dev, ino: entry.ino, mode: entry.mode };
}

async function verifyWriterParent(expected: WriterDirectoryIdentity): Promise<void> {
  const allowedCanonicalPath = process.platform === "darwin" &&
      (expected.path === "/var" || expected.path.startsWith("/var/") ||
       expected.path === "/tmp" || expected.path.startsWith("/tmp/"))
    ? "/private" + expected.path
    : expected.path;
  const current = await lstat(expected.path);
  const expectedUid = process.getuid?.();
  if (await realpath(expected.path) !== allowedCanonicalPath || !current.isDirectory() ||
      current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino ||
      current.mode !== expected.mode || (current.mode & 0o022) !== 0 ||
      (expectedUid !== undefined && current.uid !== expectedUid)) {
    throw new Error("JsonStore parent changed during writer-lock persistence");
  }
}

function writerLockIdentity(entry: Stats): WriterLockIdentity {
  const expectedUid = process.getuid?.();
  if (!entry.isFile() || entry.nlink !== 1 || entry.size > maxWriterLockBytes ||
      (entry.mode & 0o7777) !== 0o600 ||
      (expectedUid !== undefined && entry.uid !== expectedUid)) {
    throw new Error("STORE_WRITER_LOCK_UNSAFE");
  }
  return {
    dev: entry.dev,
    ino: entry.ino,
    mode: entry.mode,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.ctimeMs,
    nlink: entry.nlink,
    uid: entry.uid,
  };
}

function sameWriterLockEntry(expected: WriterLockIdentity, observed: Stats): boolean {
  return observed.isFile() && observed.nlink === 1 && observed.dev === expected.dev &&
    observed.ino === expected.ino && observed.mode === expected.mode && observed.size === expected.size &&
    observed.mtimeMs === expected.mtimeMs && observed.ctimeMs === expected.ctimeMs &&
    observed.uid === expected.uid && (observed.mode & 0o7777) === 0o600;
}

async function resolveWriterLockHelper(): Promise<WriterLockHelper> {
  const candidates: WriterLockHelper[] = process.platform === "darwin"
    ? [{
      path: "/usr/bin/lockf",
      args: ["-s", "-t", "0", "3"],
      busyExitCode: 75,
      kind: "darwin-lockf",
    }]
    : process.platform === "linux"
      ? [
        { path: "/usr/bin/flock", args: ["-n", "-E", "75", "3"], busyExitCode: 75,
          kind: "linux-flock" },
        { path: "/bin/flock", args: ["-n", "-E", "75", "3"], busyExitCode: 75,
          kind: "linux-flock" },
      ]
      : [];
  for (const candidate of candidates) {
    try {
      await access(candidate.path, constants.X_OK);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("STORE_WRITER_LOCK_HELPER_UNAVAILABLE");
      }
    }
  }
  throw new Error("STORE_WRITER_LOCK_HELPER_UNAVAILABLE");
}

async function lockOpenFileDescription(
  handle: Awaited<ReturnType<typeof open>>,
  helper: WriterLockHelper,
): Promise<void> {
  const child = spawn(helper.path, helper.args, {
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    stdio: ["ignore", "ignore", "pipe", handle.fd],
  });
  let stderr = "";
  child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2048); });
  const outcome = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
  }>((resolve, reject) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 5_000);
    child.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, timedOut });
    });
  }).catch(error => {
    throw new Error(`STORE_WRITER_LOCK_HELPER_FAILED: ${String(error).slice(0, 256)}`);
  });

  if (!outcome.timedOut && outcome.signal === null && outcome.code === 0) return;
  if (!outcome.timedOut && outcome.signal === null && outcome.code === helper.busyExitCode) {
    throw new Error("STORE_WRITER_ACTIVE");
  }
  throw new Error(
    `STORE_WRITER_LOCK_HELPER_FAILED: ${outcome.code}/${outcome.signal}: ${stderr}`.slice(0, 512),
  );
}

export async function acquireWriterLease(
  filePath: string,
  observe?: WriterLockTimingObserver,
): Promise<WriterLease> {
  observe?.("lease_acquire_start");
  const destination = path.resolve(filePath);
  const parent = await writerParent(destination);
  const lockPath = destination + ".writer-lock";
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      lockPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("STORE_WRITER_LOCK_UNSAFE");
    }
    throw error;
  }

  try {
    const opened = writerLockIdentity(await handle.stat());
    if (!sameWriterLockEntry(opened, await lstat(lockPath))) {
      throw new Error("STORE_WRITER_LOCK_UNSAFE");
    }

    observe?.("helper_acquire_start");
    const helper = await resolveWriterLockHelper();
    await lockOpenFileDescription(handle, helper);
    observe?.("helper_acquired");
    if (!sameWriterLockEntry(opened, await handle.stat()) ||
        !sameWriterLockEntry(opened, await lstat(lockPath))) {
      throw new Error("STORE_WRITER_LOCK_LOST");
    }

    observe?.("owner_record_start");
    const owner: WriterOwner = {
      version: 2,
      pid: process.pid,
      nonce: randomUUID(),
      databasePathSha256: databasePathDigest(destination),
      acquiredAt: Date.now(),
      helper: helper.kind,
    };
    const bytes = Buffer.from(JSON.stringify(owner), "utf8");
    let written = 0;
    while (written < bytes.length) {
      const result = await handle.write(bytes, written, bytes.length - written, written);
      if (!result.bytesWritten) throw new Error("STORE_WRITER_LOCK_WRITE_FAILED");
      written += result.bytesWritten;
    }
    await handle.truncate(bytes.length);
    observe?.("owner_record_written");
    // This record is diagnostic, never lock authority. Kernel descriptor state
    // provides exclusion, so durability fsyncs here would add a full commit-like
    // cost without improving the ordinary process-crash guarantee.
    await verifyWriterParent(parent);
    observe?.("owner_parent_validated");

    const identity = writerLockIdentity(await handle.stat());
    if (!sameWriterLockEntry(identity, await lstat(lockPath))) {
      throw new Error("STORE_WRITER_LOCK_LOST");
    }
    observe?.("lease_acquired");
    return { lockPath, parent, owner, identity, handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function verifyWriterLease(lease: WriterLease, filePath: string): Promise<void> {
  if (lease.owner.databasePathSha256 !== databasePathDigest(filePath) ||
      !sameWriterLockEntry(lease.identity, await lease.handle.stat()) ||
      !sameWriterLockEntry(lease.identity, await lstat(lease.lockPath))) {
    throw new Error("STORE_WRITER_LOCK_LOST");
  }
}

export async function releaseWriterLease(
  lease: WriterLease,
  filePath: string,
  observe?: WriterLockTimingObserver,
): Promise<void> {
  observe?.("lease_release_start");
  await verifyWriterLease(lease, filePath);
  await lease.handle.close();
  observe?.("lease_released");
}
