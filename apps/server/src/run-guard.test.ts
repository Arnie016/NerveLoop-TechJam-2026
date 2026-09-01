import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { RunGuard } from "./run-guard.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const sockets: Server[] = [];

afterEach(async () => {
  await Promise.all(sockets.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "guard-fs-"));
  roots.push(root);
  const workspacePath = path.join(root, "w");
  await mkdir(workspacePath);
  await writeFile(path.join(workspacePath, "normal.txt"), "baseline");
  const guard = new RunGuard("workspace-write");
  const prepare = () => guard.prepare({ agentId: "fixture-agent", runId: "fixture-run", workspacePath });
  return { root, workspacePath, guard, prepare };
}

async function specialFile(kind: "fifo" | "socket", target: string): Promise<void> {
  if (kind === "fifo") {
    await execFileAsync("mkfifo", [target], { timeout: 1000, env: { PATH: "/usr/bin:/bin" } });
  } else {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(target, resolve);
    });
    sockets.push(server);
  }
}

describe.skipIf(process.platform === "win32")("RunGuard filesystem boundary", () => {
  async function overBudgetDirectories(workspacePath: string, shape: "wide" | "deep") {
    if (shape === "deep") {
      await mkdir(path.join(workspacePath, ...Array<string>(33).fill("d")), { recursive: true });
    } else {
      for (let index = 0; index < 257; index++) {
        await mkdir(path.join(workspacePath, "dir-" + index));
      }
    }
  }

  it.each(["wide", "deep"] as const)("denies an over-budget %s directory baseline", async (shape) => {
    const { workspacePath, prepare } = await setup();
    await overBudgetDirectories(workspacePath, shape);
    const session = await prepare();
    expect(session.receipt.verdict).toBe("denied");
    expect(session.before).toBeNull();
  });

  it.each(["wide", "deep"] as const)("quarantines an over-budget %s post-run directory tree", async (shape) => {
    const { workspacePath, prepare, guard } = await setup();
    const session = await prepare();
    await overBudgetDirectories(workspacePath, shape);
    const receipt = await guard.verify(session, workspacePath);
    expect(receipt).toMatchObject({ verdict: "denied", recovery: "rolled_back" });
    expect(receipt.recoveredManifestDigest).toBe(receipt.beforeManifestDigest);
    expect(await readFile(path.join(workspacePath, "normal.txt"), "utf8")).toBe("baseline");
    await expect(lstat(path.join(workspacePath, shape === "wide" ? "dir-0" : "d")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts exactly 256 descendant directories with a maximum depth of 32", async () => {
    const { workspacePath, prepare, guard } = await setup();
    const deepest = path.join(workspacePath, ...Array<string>(32).fill("d"));
    await mkdir(deepest, { recursive: true });
    for (let index = 0; index < 224; index++) await mkdir(path.join(workspacePath, "dir-" + index));
    await writeFile(path.join(deepest, "leaf.txt"), "bounded leaf");
    const session = await prepare();
    expect(session.receipt.verdict).toBe("pending");
    expect((await guard.verify(session, workspacePath)).verdict).toBe("retained");
  });

  it("keeps manifest ordering independent of filesystem enumeration order", async () => {
    const { workspacePath, prepare, guard } = await setup();
    await writeFile(path.join(workspacePath, "z.txt"), "z");
    await writeFile(path.join(workspacePath, "a.txt"), "a");
    const session = await prepare();
    await rm(path.join(workspacePath, "z.txt"));
    await rm(path.join(workspacePath, "a.txt"));
    await writeFile(path.join(workspacePath, "a.txt"), "a");
    await writeFile(path.join(workspacePath, "z.txt"), "z");
    const receipt = await guard.verify(session, workspacePath);
    expect(receipt).toMatchObject({ verdict: "retained", changedFiles: [] });
    expect(receipt.afterManifestDigest).toBe(receipt.beforeManifestDigest);
  });

  it.each(["incremental", "quarantine"] as const)("preserves executable and private-file permissions during %s recovery", async (recovery) => {
    const { workspacePath, prepare, guard } = await setup();
    const script = path.join(workspacePath, "normal.txt");
    const privateFile = path.join(workspacePath, ".env");
    await chmod(script, 0o755);
    await writeFile(privateFile, "private fixture");
    await chmod(privateFile, 0o600);
    const session = await prepare();
    await writeFile(script, "unverified script");
    await writeFile(privateFile, "unverified private fixture");
    if (recovery === "quarantine") await specialFile("fifo", path.join(workspacePath, "special"));
    const receipt = await guard.verify(session, workspacePath);
    expect(receipt).toMatchObject({ verdict: "denied", recovery: "rolled_back" });
    expect((await lstat(script)).mode & 0o777).toBe(0o755);
    expect((await lstat(privateFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(script, "utf8")).toBe("baseline");
  });

  it("detects a protected-file permission change even when its contents are unchanged", async () => {
    const { workspacePath, prepare, guard } = await setup();
    const privateFile = path.join(workspacePath, ".env");
    await writeFile(privateFile, "private fixture");
    await chmod(privateFile, 0o600);
    const session = await prepare();
    await chmod(privateFile, 0o644);
    const receipt = await guard.verify(session, workspacePath);
    expect(receipt).toMatchObject({ verdict: "denied", recovery: "rolled_back" });
    expect((await lstat(privateFile)).mode & 0o777).toBe(0o600);
  });

  it("denies a hard-linked baseline before issuing a usable checkpoint", async () => {
    const { root, workspacePath, prepare } = await setup();
    const external = path.join(root, "outside.txt");
    await writeFile(external, "outside fixture bytes");
    await link(external, path.join(workspacePath, "linked.txt"));
    const session = await prepare();
    expect(session.receipt.verdict).toBe("denied");
    expect(session.before).toBeNull();
    expect(JSON.stringify(session.receipt)).not.toContain("outside fixture bytes");
    expect(await readFile(external, "utf8")).toBe("outside fixture bytes");
  });

  it("denies an identical-byte hard-link swap that content hashes alone cannot distinguish", async () => {
    const { root, workspacePath, prepare, guard } = await setup();
    const external = path.join(root, "outside.txt");
    await writeFile(external, "baseline");
    const session = await prepare();
    const target = path.join(workspacePath, "normal.txt");
    await rm(target);
    await link(external, target);
    const receipt = await guard.verify(session, workspacePath);
    expect(receipt).toMatchObject({ verdict: "denied", recovery: "rolled_back" });
    expect((await lstat(target)).nlink).toBe(1);
    expect(await readFile(external, "utf8")).toBe("baseline");
    expect(receipt.recoveredManifestDigest).toBe(receipt.beforeManifestDigest);
  });

  it("never restores protected baseline bytes through an outside hard link", async () => {
    const { root, workspacePath, prepare, guard } = await setup();
    const external = path.join(root, "outside.txt");
    const target = path.join(workspacePath, ".env");
    await writeFile(external, "outside sentinel must not change");
    await writeFile(target, "protected baseline fixture");
    const session = await prepare();
    await rm(target);
    await link(external, target);
    const receipt = await guard.verify(session, workspacePath);
    expect(await readFile(external, "utf8"), "rollback must not overwrite the external alias").toBe("outside sentinel must not change");
    expect(receipt).toMatchObject({ verdict: "denied", recovery: "rolled_back" });
    expect(await readFile(target, "utf8")).toBe("protected baseline fixture");
    expect((await lstat(target)).nlink).toBe(1);
    for (const secret of [".env", "outside.txt", "protected baseline fixture", "outside sentinel must not change", root]) {
      expect(JSON.stringify(receipt)).not.toContain(secret);
    }
  });

  it("detects a newly-created outside alias even when workspace bytes are unchanged", async () => {
    const { root, workspacePath, prepare, guard } = await setup();
    const session = await prepare();
    const external = path.join(root, "outside-alias.txt");
    await link(path.join(workspacePath, "normal.txt"), external);
    const receipt = await guard.verify(session, workspacePath);
    expect(receipt).toMatchObject({ verdict: "denied", recovery: "rolled_back" });
    // Post-run verification cannot undo the runner's outside write; it must not
    // pretend to inspect or delete that alias. Recovery creates a private copy.
    expect(await readFile(external, "utf8")).toBe("baseline");
    expect((await lstat(path.join(workspacePath, "normal.txt"))).nlink).toBe(1);
  });

  it.each(["fifo", "socket"] as const)("rejects a baseline %s without reading or connecting to it", async (kind) => {
    const { workspacePath, prepare } = await setup();
    const target = path.join(workspacePath, "special");
    await specialFile(kind, target);
    const session = await prepare();
    expect(session.receipt.verdict).toBe("denied");
    expect(session.before).toBeNull();
    expect(JSON.stringify(session.receipt)).not.toContain(target);
  });

  it.each(["fifo", "socket"] as const)("quarantines a post-run %s instead of silently retaining it", async (kind) => {
    const { workspacePath, prepare, guard } = await setup();
    const session = await prepare();
    const target = path.join(workspacePath, "special");
    await specialFile(kind, target);
    const receipt = await guard.verify(session, workspacePath);
    expect(receipt).toMatchObject({ verdict: "denied", recovery: "rolled_back" });
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(workspacePath, "normal.txt"), "utf8")).toBe("baseline");
    expect(receipt.recoveredManifestDigest).toBe(receipt.beforeManifestDigest);
  });
});
