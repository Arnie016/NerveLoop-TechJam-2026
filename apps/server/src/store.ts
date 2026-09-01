import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./types.js";
import {
  acquireWriterLease as acquireKernelWriterLease,
  releaseWriterLease as releaseKernelWriterLease,
  verifyWriterLease as verifyKernelWriterLease,
  type WriterLease as KernelWriterLease,
  type WriterLockTimingStage,
} from "./writer-lock.js";

const emptyDatabase = (): Database => ({
  version: 1,
  agents: [],
  messages: [],
  runs: [],
  runBudget: null,
  workspaceResources: null,
  workspaceLifecycleOperatorActions: null,
});
const maxStoreBytes = 64 * 1024 * 1024;

interface EntryIdentity {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  nlink: number;
}

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
  mode: number;
}

function sameEntry(expected: EntryIdentity, observed: Stats): boolean {
  return observed.isFile() && observed.nlink === expected.nlink && observed.dev === expected.dev &&
    observed.ino === expected.ino && observed.mode === expected.mode && observed.size === expected.size &&
    observed.mtimeMs === expected.mtimeMs && observed.ctimeMs === expected.ctimeMs;
}

function sameInode(expected: EntryIdentity, observed: Stats): boolean {
  return observed.isFile() && observed.nlink === 1 && observed.dev === expected.dev &&
    observed.ino === expected.ino && observed.mode === expected.mode && observed.size === expected.size;
}

function sameIdentityEntry(expected: EntryIdentity, observed: EntryIdentity): boolean {
  return observed.dev === expected.dev && observed.ino === expected.ino &&
    observed.mode === expected.mode && observed.size === expected.size &&
    observed.nlink === expected.nlink &&
    observed.mtimeMs === expected.mtimeMs && observed.ctimeMs === expected.ctimeMs;
}

function entryIdentity(entry: Stats): EntryIdentity {
  if (!entry.isFile() || entry.nlink !== 1 || entry.size > maxStoreBytes || (entry.mode & 0o7000)) {
    throw new Error("JsonStore file is outside the bounded regular-file contract");
  }
  return { dev: entry.dev, ino: entry.ino, mode: entry.mode, size: entry.size,
    mtimeMs: entry.mtimeMs, ctimeMs: entry.ctimeMs, nlink: entry.nlink };
}

async function storeParent(filePath: string): Promise<DirectoryIdentity> {
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

async function syncStoreParent(expected: DirectoryIdentity): Promise<void> {
  const before = await lstat(expected.path);
  if (!before.isDirectory() || before.isSymbolicLink() || before.dev !== expected.dev ||
      before.ino !== expected.ino || before.mode !== expected.mode) {
    throw new Error("JsonStore parent changed during persistence");
  }
  const directory = await open(
    expected.path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await directory.stat();
    if (!opened.isDirectory() || opened.dev !== expected.dev || opened.ino !== expected.ino ||
        opened.mode !== expected.mode) throw new Error("JsonStore parent changed during persistence");
    await directory.sync();
  } finally {
    await directory.close();
  }
  const after = await lstat(expected.path);
  if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== expected.dev ||
      after.ino !== expected.ino || after.mode !== expected.mode) {
    throw new Error("JsonStore parent changed during persistence");
  }
}

interface FileSnapshot {
  bytes: Buffer;
  identity: EntryIdentity;
}

async function readStoreSnapshot(filePath: string, expected?: EntryIdentity): Promise<FileSnapshot> {
  const resolved = path.resolve(filePath);
  const before = await lstat(resolved);
  const identity = entryIdentity(before);
  if (expected && !sameInode(expected, before)) throw new Error("JsonStore commit identity changed");
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameEntry(identity, await handle.stat())) throw new Error("JsonStore file changed before read");
    const bytes = Buffer.alloc(identity.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used !== identity.size || !sameEntry(identity, await handle.stat()) ||
        !sameEntry(identity, await lstat(resolved))) throw new Error("JsonStore file changed during read");
    return { bytes: Buffer.from(bytes.subarray(0, used)), identity };
  } finally {
    await handle.close();
  }
}

function parseDatabase(bytes: Buffer): Database {
  const parsed = JSON.parse(bytes.toString("utf8")) as Database & {
    runBudget?: unknown;
    workspaceResources?: unknown;
    workspaceLifecycleOperatorActions?: unknown;
  };
  if (parsed.version !== 1 || !Array.isArray(parsed.agents) ||
      !Array.isArray(parsed.messages) || !Array.isArray(parsed.runs)) {
    throw new Error("Unsupported database format");
  }
  // Additive v1 migration. Missing means a legacy store, while any present
  // value is retained verbatim for the service's exact budget parser.
  if (parsed.runBudget === undefined) parsed.runBudget = null;
  if (parsed.runBudget !== null && (typeof parsed.runBudget !== "object" || Array.isArray(parsed.runBudget))) {
    throw new Error("Unsupported database budget format");
  }
  if (parsed.workspaceResources === undefined) parsed.workspaceResources = null;
  if (parsed.workspaceResources !== null &&
      (typeof parsed.workspaceResources !== "object" || Array.isArray(parsed.workspaceResources))) {
    throw new Error("Unsupported database workspace-resource format");
  }
  if (parsed.workspaceLifecycleOperatorActions === undefined) {
    parsed.workspaceLifecycleOperatorActions = null;
  }
  if (parsed.workspaceLifecycleOperatorActions !== null &&
      (typeof parsed.workspaceLifecycleOperatorActions !== "object" ||
       Array.isArray(parsed.workspaceLifecycleOperatorActions))) {
    throw new Error("Unsupported database workspace-operator-action format");
  }
  return parsed as Database;
}

function sameSnapshot(expected: FileSnapshot, observed: FileSnapshot): boolean {
  return sameIdentityEntry(expected.identity, observed.identity) && expected.bytes.equals(observed.bytes);
}

interface PersistedState {
  database: Database;
  snapshot: FileSnapshot;
}

export type JsonStoreTimingStage = WriterLockTimingStage |
  "baseline_cas_start" | "baseline_cas_complete" |
  "callback_start" | "callback_complete" |
  "serialize_start" | "serialize_complete" |
  "temp_write_start" | "temp_synced" |
  "precommit_cas_start" | "precommit_cas_complete" |
  "rename_start" | "renamed" | "directory_synced" |
  "readback_complete" | "mutation_complete";

export class JsonStore {
  private data: Database = emptyDatabase();
  private committed: FileSnapshot | null = null;
  private queue: Promise<void> = Promise.resolve();
  private poisoned: Error | null = null;
  private retainWriterLease = false;
  // A lease with ambiguous ownership must stay strongly reachable so garbage
  // collection cannot silently close its descriptor and admit another writer.
  private retainedWriterLease: KernelWriterLease | null = null;

  constructor(
    private readonly filePath: string,
    // Internal deterministic crash-test seam. Production does not configure it.
    private readonly options: {
      onPersistStage?: (stage: "temp_synced" | "renamed" | "directory_synced") => void | Promise<void>;
      renameFile?: typeof rename;
      // Internal synchronous benchmark observer. Production does not configure it.
      onTimingStage?: (stage: JsonStoreTimingStage) => void;
    } = {},
  ) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await storeParent(this.filePath);
    const lease = await acquireKernelWriterLease(this.filePath, this.options.onTimingStage);
    let initialized = false;
    try {
      const snapshot = await readStoreSnapshot(this.filePath);
      this.data = parseDatabase(snapshot.bytes);
      this.committed = snapshot;
      initialized = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const persisted = await this.persist(this.data, lease, null);
      this.data = persisted.database;
      this.committed = persisted.snapshot;
      initialized = true;
    } finally {
      if (!this.retainWriterLease) {
        try { await releaseKernelWriterLease(lease, this.filePath, this.options.onTimingStage); }
        catch {
          this.retainWriterLease = true;
          this.retainedWriterLease ??= lease;
          this.poisoned ??= new Error("JsonStore writer lease could not be released; restart required");
          if (initialized) throw this.poisoned;
        }
      } else {
        this.retainedWriterLease ??= lease;
      }
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      if (this.poisoned) throw this.poisoned;
      if (!this.committed) throw new Error("JsonStore is not initialized");
      const lease = await acquireKernelWriterLease(this.filePath, this.options.onTimingStage);
      let committed = false;
      let releaseFailure: Error | null = null;
      try {
        this.options.onTimingStage?.("baseline_cas_start");
        const observed = await readStoreSnapshot(this.filePath);
        if (!sameSnapshot(this.committed, observed)) {
          this.poisoned = new Error("JsonStore baseline changed; restart required");
          throw this.poisoned;
        }
        await verifyKernelWriterLease(lease, this.filePath);
        this.options.onTimingStage?.("baseline_cas_complete");
        const next = structuredClone(this.data);
        this.options.onTimingStage?.("callback_start");
        result = await mutation(next);
        this.options.onTimingStage?.("callback_complete");
        await verifyKernelWriterLease(lease, this.filePath);
        const persisted = await this.persist(next, lease, observed);
        this.data = persisted.database;
        this.committed = persisted.snapshot;
        committed = true;
      } finally {
        if (!this.retainWriterLease) {
          try { await releaseKernelWriterLease(lease, this.filePath, this.options.onTimingStage); }
          catch {
            this.retainWriterLease = true;
            this.retainedWriterLease ??= lease;
            this.poisoned ??= new Error("JsonStore writer lease could not be released; restart required");
            if (!committed) releaseFailure = this.poisoned;
          }
        } else {
          this.retainedWriterLease ??= lease;
        }
      }
      if (releaseFailure) throw releaseFailure;
      this.options.onTimingStage?.("mutation_complete");
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(
    data: Database,
    lease: KernelWriterLease,
    baseline: FileSnapshot | null,
  ): Promise<PersistedState> {
    this.options.onTimingStage?.("serialize_start");
    const serialized = Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf8");
    if (serialized.length > maxStoreBytes) throw new Error("JsonStore exceeds its persistence budget");
    const persistedDatabase = parseDatabase(serialized);
    this.options.onTimingStage?.("serialize_complete");
    const destination = path.resolve(this.filePath);
    const parent = await storeParent(destination);
    if (parent.dev !== lease.parent.dev || parent.ino !== lease.parent.ino ||
        parent.mode !== lease.parent.mode || parent.path !== lease.parent.path) {
      throw new Error("JsonStore writer lease parent changed");
    }
    const temporaryPath = destination + ".tmp-" + randomUUID();
    let renameAttempted = false;
    let temporaryIdentity: EntryIdentity | null = null;
    let temporary: Awaited<ReturnType<typeof open>> | null = null;
    try {
      this.options.onTimingStage?.("temp_write_start");
      temporary = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await temporary.writeFile(serialized);
      await temporary.sync();
      temporaryIdentity = entryIdentity(await temporary.stat());
      this.options.onTimingStage?.("temp_synced");
      await this.options.onPersistStage?.("temp_synced");
      if (!sameEntry(temporaryIdentity, await lstat(temporaryPath))) {
        throw new Error("JsonStore temporary file changed before rename");
      }
      this.options.onTimingStage?.("precommit_cas_start");
      await verifyKernelWriterLease(lease, destination);
      if (baseline) {
        const current = await readStoreSnapshot(destination);
        if (!sameSnapshot(baseline, current)) {
          this.poisoned = new Error("JsonStore baseline changed before commit; restart required");
          throw this.poisoned;
        }
      } else {
        try {
          await lstat(destination);
          this.poisoned = new Error("JsonStore baseline appeared before commit; restart required");
          throw this.poisoned;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await verifyKernelWriterLease(lease, destination);
      this.options.onTimingStage?.("precommit_cas_complete");
      this.options.onTimingStage?.("rename_start");
      renameAttempted = true;
      await (this.options.renameFile ?? rename)(temporaryPath, destination);
      if (!sameInode(temporaryIdentity, await lstat(destination))) {
        throw new Error("JsonStore destination changed after rename");
      }
      await temporary.close(); temporary = null;
      this.options.onTimingStage?.("renamed");
      await this.options.onPersistStage?.("renamed");
      await syncStoreParent(parent);
      this.options.onTimingStage?.("directory_synced");
      await this.options.onPersistStage?.("directory_synced");
      const committed = await readStoreSnapshot(destination, temporaryIdentity);
      if (!committed.bytes.equals(serialized)) throw new Error("JsonStore committed bytes changed");
      this.options.onTimingStage?.("readback_complete");
      return { database: persistedDatabase, snapshot: committed };
    } catch (error) {
      await temporary?.close().catch(() => undefined); temporary = null;
      if (!renameAttempted) {
        if (temporaryIdentity) {
          try {
            if (sameEntry(temporaryIdentity, await lstat(temporaryPath))) await unlink(temporaryPath);
          } catch (cleanupError) {
            if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
              // Never remove a substituted path. The failed unique entry stays forensic.
            }
          }
        }
        throw error;
      }
      // Rename is the commit point. If a later sync/observer reports an error,
      // reread the authoritative path: exact new bytes mean the commit happened
      // and memory must advance with disk rather than diverge until restart.
      try {
        await syncStoreParent(parent);
        const observed = await readStoreSnapshot(destination, temporaryIdentity ?? undefined);
        if (observed.bytes.equals(serialized)) {
          this.options.onTimingStage?.("readback_complete");
          return { database: persistedDatabase, snapshot: observed };
        }
      } catch {
        // Preserve the original error when the commit cannot be reconciled.
      }
      this.poisoned ??= new Error("JsonStore commit state is uncertain; restart required");
      this.retainWriterLease = true;
      this.retainedWriterLease ??= lease;
      throw this.poisoned;
    }
  }
}
