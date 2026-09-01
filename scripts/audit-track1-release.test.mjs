import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ESSENTIAL_RELEASE_GROUPS,
  GITHUB_FILE_BLOCK_BYTES,
  GITHUB_FILE_WARNING_BYTES,
  LOCAL_MEDIA_REVIEW_INPUTS,
  LOCAL_MEDIA_SUPPLIED_REVIEW_COMMANDS,
  PUBLIC_SOURCE_REPRODUCTION_COMMANDS,
  auditTrack1Release,
  collectGitSnapshot,
  forbiddenPathRule,
  writeReceiptSafely,
} from "./audit-track1-release.mjs";

const execFileAsync = promisify(execFile);
const auditScript = join(dirname(fileURLToPath(import.meta.url)), "audit-track1-release.mjs");
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (value) => createHash("sha256").update(value).digest("hex");

async function withTempTree(run) {
  const root = await mkdtemp(join(tmpdir(), "track1-release-audit-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function put(root, path, contents = "fixture\n") {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

async function createEssentialTree(root) {
  const paths = [...new Set(ESSENTIAL_RELEASE_GROUPS.flatMap(({ paths: groupPaths }) => groupPaths))];
  for (const path of paths) {
    if (path === "docs/demo/track-c-opening.json") continue;
    if (path.endsWith(".json")) await put(root, path, "{}\n");
    else await put(root, path, "Track #1 Agent Launchpad fixture\n");
  }
  await put(
    root,
    "docs/demo/track-c-opening.json",
    `${JSON.stringify({
      selectedTrack: "Track #1: Agent Launchpad: Design and Build Lightweight Agent Middleware",
      preservation: {
        currentCandidateVideo: null,
        currentNarrativeReflectedByStableArtifacts: false,
      },
    })}\n`,
  );
  return paths;
}

function snapshot({ trackedPaths = [], untrackedPaths = [], statusEntries = [], branch = "synthetic" } = {}) {
  const trackedChanges = statusEntries.filter(({ x, y }) => !(x === "?" && y === "?"));
  return {
    branch,
    trackedPaths,
    untrackedPaths,
    statusEntries,
    counts: {
      tracked: trackedPaths.length,
      untracked: untrackedPaths.length,
      changedTracked: trackedChanges.length,
      staged: trackedChanges.filter(({ x }) => x !== " ").length,
      unstaged: trackedChanges.filter(({ y }) => y !== " ").length,
      conflicts: 0,
    },
  };
}

test("complete synthetic essentials still fail closed for human and external gates", async () => {
  await withTempTree(async (root) => {
    const paths = await createEssentialTree(root);
    const receipt = await auditTrack1Release(root, {
      gitSnapshot: snapshot({ trackedPaths: paths }),
    });

    assert.equal(receipt.status, "REVIEW_REQUIRED");
    assert.equal(receipt.publicationAuthorized, false);
    assert.equal(receipt.automaticPushVerdict, null);
    assert.equal(receipt.findingCounts.missingEssential, 0);
    assert.match(receipt.freshness.gitInventoryDigest, /^[a-f0-9]{64}$/u);
    assert.match(receipt.freshness.workingTreeMetadataDigest, /^[a-f0-9]{64}$/u);
    assert.equal(receipt.mediaReview.automaticallyIncludedVideos.length, 0);
    assert(receipt.publicSourceReproductionCommands.every(({ requiresMedia }) => requiresMedia === false));
    assert(receipt.localMediaSuppliedReviewCommands.every(({ requiresHumanSelectedMedia }) => requiresHumanSelectedMedia === true));
    assert.match(receipt.externalAuthorityGate, /^OPEN:/u);
    assert(receipt.unresolvedGates.some(({ id }) => id === "external-publication-authority"));
  });
});

test("flagship capability and demo integration files are explicit middleware essentials", () => {
  const middleware = ESSENTIAL_RELEASE_GROUPS.find(({ id }) => id === "track1-middleware-source");
  assert(middleware);
  for (const path of [
    "apps/server/src/effect-capability.ts",
    "apps/server/src/effect-capability.test.ts",
    "apps/server/src/agent-service.test.ts",
    "apps/server/src/effect-sink.test.ts",
    "apps/server/src/effect-sink.ts",
    "apps/server/src/fixture-runner.ts",
  ]) {
    assert(middleware.paths.includes(path), `${path} must be in the explicit release allowlist`);
  }
  const focusedServerCommand = PUBLIC_SOURCE_REPRODUCTION_COMMANDS.find((command) => command.startsWith("npm test -w @launchpad/server"));
  assert.match(focusedServerCommand, /src\/effect-capability\.test\.ts/u);
  assert.match(focusedServerCommand, /src\/effect-receipt-automaton\.test\.ts/u);
  assert.match(focusedServerCommand, /src\/effect-sink\.test\.ts/u);
});

test("source-only reproduction and human-selected media review are separate contracts", async () => {
  const sourceCommands = PUBLIC_SOURCE_REPRODUCTION_COMMANDS.join("\n");
  assert.doesNotMatch(sourceCommands, /\.mp4\b/u);
  assert.doesNotMatch(sourceCommands, /submission:story-check/u);
  assert.doesNotMatch(sourceCommands, /render-effect-firewall-candidate/u);
  assert.doesNotMatch(sourceCommands, /run-track-c-kill-switch-demo/u);

  assert.deepEqual(LOCAL_MEDIA_REVIEW_INPUTS, [
    {
      role: "current-candidate",
      path: "docs/demo/nerveloop-effect-firewall-candidate.mp4",
      sha256: "1884b05ad3e8350c8e4b0aa8322d1b47388f1ff9392f7be985cc73467b8df36e",
    },
    {
      role: "stable-fallback",
      path: "docs/demo/nerveloop-submission-draft.mp4",
      sha256: "ed34f33a709719569806e21fdc738cca7b6e9c3a5aeda00860e84f1e6ecca2c7",
    },
  ]);
  assert.deepEqual(LOCAL_MEDIA_SUPPLIED_REVIEW_COMMANDS, [
    "node --test scripts/run-track-c-kill-switch-demo.test.mjs",
    "npm run submission:story-check",
    "node --test scripts/render-effect-firewall-candidate.test.mjs",
    "node scripts/render-effect-firewall-candidate.mjs --verify-only",
    "npm run submission:final-check",
  ]);

  const mediaVerifier = ESSENTIAL_RELEASE_GROUPS.find(({ id }) => id === "candidate-media-verifier");
  assert(mediaVerifier);
  for (const path of [
    "docs/demo/submission-storyboard.json",
    "research/evidence/2026-09-01-provenance-cleared-media-experiment/font8x8_basic.h",
    "scripts/verify-judge-story-contract.mjs",
  ]) {
    assert(mediaVerifier.paths.includes(path), `${path} must be in the explicit media verifier/support allowlist`);
  }
  assert.equal(mediaVerifier.paths.includes("docs/assets/nerveloop-reflex-architecture.svg"), false);

  await withTempTree(async (root) => {
    const paths = await createEssentialTree(root);
    const receipt = await auditTrack1Release(root, {
      gitSnapshot: snapshot({ trackedPaths: paths }),
    });
    assert.equal("publicReproductionCommands" in receipt, false);
    assert.equal(receipt.publicSourceReproductionCommands.length, PUBLIC_SOURCE_REPRODUCTION_COMMANDS.length);
    assert.equal(receipt.localMediaSuppliedReviewCommands.length, LOCAL_MEDIA_SUPPLIED_REVIEW_COMMANDS.length);
    for (const command of receipt.localMediaSuppliedReviewCommands) {
      assert.equal(command.requiresHumanSelectedMedia, true);
      assert.deepEqual(command.requiredMedia, LOCAL_MEDIA_REVIEW_INPUTS);
    }
  });
});

test("current public and operational closure manifests have an exact source-to-media relationship", async () => {
  const receipt = await auditTrack1Release(repository);
  assert.equal(receipt.closureManifestReview.passed, true);
  assert.deepEqual(receipt.closureManifestReview.publicSource, {
    path: "docs/TRACK1_PUBLIC_SOURCE_CLOSURE.txt",
    expectedCount: 104,
    count: 104,
    sha256: receipt.closureManifestReview.publicSource.sha256,
    videoFiles: [],
  });
  assert.equal(receipt.closureManifestReview.operational.count, 108);
  assert.deepEqual(receipt.closureManifestReview.operational.operationalOnly, [
    "apps/web/public/demo/video-incident/broken.mp4",
    "apps/web/public/demo/video-incident/repaired.mp4",
    "docs/demo/nerveloop-effect-firewall-candidate.mp4",
    "docs/demo/nerveloop-submission-draft.mp4",
  ]);
  assert.deepEqual(receipt.closureManifestReview.publicMissingFromOperational, []);
  assert.deepEqual(receipt.closureManifestReview.issues, []);
  assert.equal(receipt.mediaReview.candidateBinding.localSourceBindingPassed, true);
  assert.equal(receipt.mediaReview.candidateBinding.sourceBindingsChecked, 10);
  assert.deepEqual(receipt.mediaReview.candidateBinding.issues, []);
});

test("forbidden names are reported without reading or disclosing secret values", async () => {
  await withTempTree(async (root) => {
    const secretValue = "DO_NOT_DISCLOSE_SYNTHETIC_VALUE_94721";
    const tokenShapedValue = `gh${"p_"}${"A".repeat(24)}`;
    await put(root, ".env", `TOKEN=${secretValue}\n`);
    await put(root, "credentials.json", `{"password":"${secretValue}"}\n`);
    await put(root, "data/state.json", "{}\n");
    await put(root, "node_modules/pkg/index.js", "ignored\n");
    await put(root, "debug.log", "runtime output\n");
    await put(root, "src/config.ts", `export const value = "${tokenShapedValue}";\n`);
    const secretFilename = `secret-${secretValue}.txt`;
    await put(root, secretFilename, "filename fixture\n");
    const paths = [".env", "credentials.json", "data/state.json", "debug.log", "src/config.ts", secretFilename];
    const receipt = await auditTrack1Release(root, {
      gitSnapshot: snapshot({ untrackedPaths: paths }),
    });
    const encoded = JSON.stringify(receipt);

    assert.equal(encoded.includes(secretValue), false);
    assert.equal(encoded.includes(tokenShapedValue), false);
    assert.equal(forbiddenPathRule(".env.example"), null);
    assert.equal(forbiddenPathRule(".env"), "environment-secret-file");
    assert(receipt.forbiddenPathReview.presentOnDisk.some(({ path }) => path === "node_modules"));
    assert(receipt.forbiddenPathReview.inGitPublicationSet.some(({ path, rule }) => path === ".env" && rule === "environment-secret-file"));
    assert(receipt.forbiddenPathReview.inGitPublicationSet.some(({ path, rule }) => path === "credentials.json" && rule === "credential-or-secret-named-file"));
    assert.deepEqual(receipt.contentRuleReview.sensitiveFindings, [
      { path: "src/config.ts", rule: "github-token-shape" },
    ]);
    assert(receipt.forbiddenPathReview.inGitPublicationSet.some(({ path, rule }) => path.startsWith("[redacted-sensitive-filename-") && rule === "credential-or-secret-named-file"));
  });
});

test("literal Track C is flagged in human prose but allowed in legacy filenames", async () => {
  await withTempTree(async (root) => {
    await put(root, "README.md", "This human page still says Track C.\n");
    await put(root, "docs/migration.md", "Historical migration note: Track C was replaced by Track #1.\n");
    await put(root, "scripts/track-c-legacy.mjs", "// Track #1 compatibility fixture\n");
    const receipt = await auditTrack1Release(root, {
      gitSnapshot: snapshot({ trackedPaths: ["README.md", "docs/migration.md", "scripts/track-c-legacy.mjs"] }),
    });

    assert.deepEqual(receipt.contentRuleReview.staleTrackLabels, [
      { path: "README.md", rule: "stale-human-label-track-c" },
    ]);
    assert.deepEqual(receipt.contentRuleReview.historicalTrackLabelReferences, [
      { path: "docs/migration.md", rule: "historical-track-c-reference-review-only" },
    ]);
  });
});

test("the story contract is never followed through a symlink", async () => {
  await withTempTree(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), "track1-story-outside-"));
    try {
      const secretValue = "OUTSIDE_STORY_SECRET_44719";
      const outsideStory = join(outside, "story.json");
      await writeFile(outsideStory, JSON.stringify({ preservation: { currentCandidateVideo: secretValue } }));
      await mkdir(join(root, "docs/demo"), { recursive: true });
      await symlink(outsideStory, join(root, "docs/demo/track-c-opening.json"));
      const receipt = await auditTrack1Release(root, {
        gitSnapshot: snapshot({ untrackedPaths: ["docs/demo/track-c-opening.json"] }),
      });

      assert.equal(JSON.stringify(receipt).includes(secretValue), false);
      assert.equal(receipt.storyContract.parsed, false);
      assert.equal(receipt.storyContract.parseErrorRule, "story-contract-not-safe-regular-file");
      assert(receipt.specialFileReview.symlinksInGitPublicationSet.some(({ path }) => path === "docs/demo/track-c-opening.json"));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("receipt writer rejects symlink escape and arbitrary CLI destinations", async () => {
  await withTempTree(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), "track1-receipt-outside-"));
    try {
      await symlink(outside, join(root, "research"));
      await assert.rejects(
        writeReceiptSafely(root, { status: "REVIEW_REQUIRED" }),
        /symlink or non-directory/u,
      );
      assert.deepEqual(await readdir(outside), []);

      await put(root, "README.md", "must remain unchanged\n");
      const result = spawnSync(process.execPath, [
        auditScript,
        "--root",
        root,
        "--receipt",
        "README.md",
        "--write-receipt",
      ], { encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.equal(await readFile(join(root, "README.md"), "utf8"), "must remain unchanged\n");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("receipt writer refuses an existing symlink destination", async () => {
  await withTempTree(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), "track1-receipt-target-"));
    try {
      const outsideFile = join(outside, "outside.json");
      await writeFile(outsideFile, "unchanged\n");
      const receiptParent = join(root, "research/evidence/2026-09-01-track1-release-audit");
      await mkdir(receiptParent, { recursive: true });
      await symlink(outsideFile, join(receiptParent, "audit.json"));
      await assert.rejects(
        writeReceiptSafely(root, { status: "REVIEW_REQUIRED" }),
        /regular file or absent/u,
      );
      assert.equal(await readFile(outsideFile, "utf8"), "unchanged\n");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("sparse synthetic files exercise GitHub warning and hard-block thresholds", async () => {
  await withTempTree(async (root) => {
    const warningPath = "docs/warning.bin";
    const blockedPath = "docs/blocked.bin";
    await put(root, warningPath, "");
    await put(root, blockedPath, "");
    await truncate(join(root, warningPath), GITHUB_FILE_WARNING_BYTES + 1);
    await truncate(join(root, blockedPath), GITHUB_FILE_BLOCK_BYTES + 1);
    const receipt = await auditTrack1Release(root, {
      gitSnapshot: snapshot({ untrackedPaths: [warningPath, blockedPath] }),
    });

    assert.deepEqual(
      receipt.sizeReview.findings.map(({ path, rule }) => ({ path, rule })),
      [
        { path: blockedPath, rule: "github-regular-git-hard-block-over-100-mib" },
        { path: warningPath, rule: "github-regular-git-warning-over-50-mib" },
      ],
    );
  });
});

test("symlinks require review and every video remains excluded", async () => {
  await withTempTree(async (root) => {
    await put(root, "README.md", "Track #1 fixture\n");
    await mkdir(join(root, "docs/demo"), { recursive: true });
    await symlink("README.md", join(root, "readme-link.md"));
    await put(root, "docs/demo/new-candidate.mp4", "not a real movie\n");
    const receipt = await auditTrack1Release(root, {
      gitSnapshot: snapshot({
        untrackedPaths: ["README.md", "readme-link.md", "docs/demo/new-candidate.mp4"],
      }),
    });

    assert.deepEqual(receipt.specialFileReview.symlinksInGitPublicationSet, [
      { path: "readme-link.md", rule: "symlink-requires-manual-target-review" },
    ]);
    assert.deepEqual(receipt.mediaReview.automaticallyIncludedVideos, []);
    assert.deepEqual(receipt.mediaReview.excludedVideos.map(({ path }) => path), [
      "docs/demo/new-candidate.mp4",
    ]);
  });
});

test("a source-bound local candidate clears only the local binding gate and is never auto-included", async () => {
  await withTempTree(async (root) => {
    const videoPath = "docs/demo/candidate.mp4";
    const sidecarPath = "docs/demo/candidate.json";
    const sourcePath = "src/policy.ts";
    const renderPath = "scripts/render.mjs";
    const video = "synthetic movie bytes";
    const source = "export const policy = true;\n";
    const renderer = "export const render = true;\n";
    await put(root, videoPath, video);
    await put(root, sourcePath, source);
    await put(root, renderPath, renderer);
    const sidecar = {
      schemaVersion: "candidate.v1",
      video: { path: videoPath, sha256: digest(video), sizeBytes: Buffer.byteLength(video) },
      media: {
        durationSeconds: 120,
        video: { codec: "h264", pixelFormat: "yuv420p", frameRate: "24/1", width: 1920, height: 1080 },
        audio: { codec: "aac", sampleRate: 48000, channels: 2 },
      },
      sourceBindings: [{ path: sourcePath, sha256: digest(source) }],
      sampleFrames: [{ timeSeconds: 3, sha256: "a".repeat(64) }],
      renderScript: { path: renderPath, sha256: digest(renderer) },
    };
    const encodedSidecar = `${JSON.stringify(sidecar)}\n`;
    await put(root, sidecarPath, encodedSidecar);
    const storyPath = "docs/demo/track-c-opening.json";
    await put(root, storyPath, `${JSON.stringify({
      candidate: {
        video: videoPath,
        videoSha256: digest(video),
        sidecar: sidecarPath,
        sidecarSha256: digest(encodedSidecar),
        sidecarSchema: "candidate.v1",
        durationSeconds: 120,
        maximumDurationSeconds: 180,
        videoCodec: "h264",
        pixelFormat: "yuv420p",
        frameRate: "24/1",
        audioCodec: "aac",
        audioSampleRate: 48000,
        audioChannels: 2,
        width: 1920,
        height: 1080,
        sourceBindingCount: 1,
        sampleFrameCount: 1,
      },
      releaseGates: { humanPlaybackReview: false },
      preservation: { currentNarrativeReflectedByStableArtifacts: false },
    })}\n`);
    const paths = [videoPath, sidecarPath, sourcePath, renderPath, storyPath];
    const receipt = await auditTrack1Release(root, {
      gitSnapshot: snapshot({ untrackedPaths: paths }),
    });

    assert.equal(receipt.mediaReview.candidateBinding.localSourceBindingPassed, true);
    assert.equal(receipt.mediaReview.candidateBinding.sourceBindingsChecked, 1);
    assert.deepEqual(receipt.mediaReview.automaticallyIncludedVideos, []);
    assert.equal(receipt.unresolvedGates.some(({ id }) => id === "current-candidate-video"), false);
    assert.equal(receipt.unresolvedGates.some(({ id }) => id === "human-playback-and-rights-review"), true);
  });
});

test("actual temporary Git inventory distinguishes tracked, untracked and ignored state", async () => {
  await withTempTree(async (root) => {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await put(root, ".gitignore", "dist/\n.env\n");
    await put(root, "README.md", "Track #1 fixture\n");
    await execFileAsync("git", ["add", ".gitignore", "README.md"], { cwd: root });
    await put(root, "package.json", "{}\n");
    await put(root, "dist/generated.js", "build output\n");
    await put(root, ".env", "PASSWORD=synthetic-only\n");

    const gitSnapshot = await collectGitSnapshot(root);
    const receipt = await auditTrack1Release(root);

    assert.deepEqual(gitSnapshot.counts, {
      tracked: 2,
      untracked: 1,
      changedTracked: 2,
      staged: 2,
      unstaged: 0,
      conflicts: 0,
    });
    assert.equal(receipt.inventory.publicationSetCount, 3);
    assert(receipt.forbiddenPathReview.presentOnDisk.some(({ path }) => path === "dist"));
    assert(receipt.forbiddenPathReview.presentOnDisk.some(({ path }) => path === ".env"));
    assert.equal(receipt.forbiddenPathReview.inGitPublicationSet.length, 0);
  });
});
