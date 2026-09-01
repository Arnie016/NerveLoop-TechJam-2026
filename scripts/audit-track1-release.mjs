import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT_RELATIVE_PATH = "research/evidence/2026-09-01-track1-release-audit/audit.json";
const defaultReceiptPath = resolve(
  scriptRoot,
  RECEIPT_RELATIVE_PATH,
);

export const GITHUB_FILE_WARNING_BYTES = 50 * 1024 * 1024;
export const GITHUB_FILE_BLOCK_BYTES = 100 * 1024 * 1024;
const MAX_TEXT_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_WALK_ENTRIES = 50_000;
const CLOSURE_CONTRACTS = Object.freeze({
  publicSource: {
    path: "docs/TRACK1_PUBLIC_SOURCE_CLOSURE.txt",
    expectedCount: 104,
    permitsVideo: false,
  },
  operational: {
    path: "docs/TRACK1_OPERATIONAL_CLOSURE.txt",
    expectedCount: 108,
    permitsVideo: true,
  },
});
const EXPECTED_OPERATIONAL_MEDIA_ONLY = Object.freeze([
  "apps/web/public/demo/video-incident/broken.mp4",
  "apps/web/public/demo/video-incident/repaired.mp4",
  "docs/demo/nerveloop-effect-firewall-candidate.mp4",
  "docs/demo/nerveloop-submission-draft.mp4",
]);

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"]);
const TEXT_EXTENSIONS = new Set([
  "",
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".sh",
  ".srt",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

export const ESSENTIAL_RELEASE_GROUPS = [
  {
    id: "project-contract",
    purpose: "Install, license, security and public orientation contract.",
    paths: [
      ".env.example",
      ".gitignore",
      "LICENSE",
      "README.md",
      "SECURITY.md",
      "package-lock.json",
      "package.json",
    ],
  },
  {
    id: "track1-middleware-source",
    purpose: "Host-owned pre-dispatch policy, recovery backstop and receipt verifier.",
    paths: [
      "apps/server/package.json",
      "apps/server/src/agent-service.test.ts",
      "apps/server/src/agent-service.ts",
      "apps/server/src/effect-capability.test.ts",
      "apps/server/src/effect-capability.ts",
      "apps/server/src/effect-policy.ts",
      "apps/server/src/effect-policy.test.ts",
      "apps/server/src/effect-receipt-automaton.ts",
      "apps/server/src/effect-receipt-automaton.test.ts",
      "apps/server/src/effect-sink.test.ts",
      "apps/server/src/effect-sink.ts",
      "apps/server/src/fixture-runner.ts",
      "apps/server/src/run-guard.ts",
      "apps/server/src/run-guard.test.ts",
    ],
  },
  {
    id: "judge-ui-source",
    purpose: "Local judge story and the API/type surface it actually renders.",
    paths: [
      "apps/web/index.html",
      "apps/web/package.json",
      "apps/web/src/App.tsx",
      "apps/web/src/EffectFirewallStory.tsx",
      "apps/web/src/api.ts",
      "apps/web/src/styles.css",
      "apps/web/src/types.ts",
      "apps/web/vite.config.ts",
    ],
  },
  {
    id: "track1-reproducibility",
    purpose: "Focused deterministic functional, comparison, adversarial and isolated sink-redemption experiments.",
    paths: [
      "scripts/effect-firewall-adversarial-matrix.mjs",
      "scripts/effect-firewall-adversarial-matrix.test.mjs",
      "scripts/effect-sink-redemption-lab.mjs",
      "scripts/effect-sink-redemption-lab.test.mjs",
      "scripts/run-track-c-kill-switch-demo.mjs",
      "scripts/run-track-c-kill-switch-demo.test.mjs",
      "scripts/track-c-condition-benchmark.mjs",
      "scripts/track-c-condition-benchmark.test.mjs",
      "scripts/audit-track1-release.mjs",
      "scripts/audit-track1-release.test.mjs",
      "scripts/verify-track1-final-readiness.mjs",
      "scripts/verify-track1-final-readiness.test.mjs",
    ],
    note: "track-c is retained only in legacy filenames and command compatibility; it is not an official track label.",
  },
  {
    id: "human-judge-docs",
    purpose: "Human-written explanation, operator path, story contract and proof boundaries.",
    paths: [
      "devpost-submission.md",
      "docs/JUDGE_QUICKSTART.md",
      "docs/TRACK1_OPERATIONAL_CLOSURE.txt",
      "docs/TRACK1_PUBLIC_SOURCE_CLOSURE.txt",
      "docs/TRACK1_RELEASE_GATE.md",
      "docs/demo/track-c-opening.json",
      "docs/judge/NERVELOOP-REFLEX-ARCHITECTURE.md",
      "docs/judge/VERA-JUDGE-PLAYBOOK.md",
      "research/DEEP_SYSTEMS_EXPERIMENTS.md",
    ],
  },
  {
    id: "curated-current-evidence",
    purpose: "Small source-bound receipts for the flagship story and the explicitly isolated sink-redemption boundary lab.",
    paths: [
      "research/evidence/2026-09-01-effect-firewall-adversarial/results.json",
      "research/evidence/2026-09-01-track-c-condition-benchmark/results.json",
      "research/evidence/2026-09-01-track-c-functional-flow/current.json",
      "research/evidence/final-algorithm-lab/README.md",
      "research/evidence/final-algorithm-lab/results.json",
    ],
    note: "Historical evidence directories are not implicitly part of the public release surface.",
  },
  {
    id: "current-static-media",
    purpose: "Current procedurally generated still for the Effect Firewall story; it still needs visual and rights review, while video is deliberately excluded.",
    paths: ["docs/assets/nerveloop-effect-firewall-story.png"],
    note: "The selected still is generated without an imported screenshot or system-font lookup. No video is essential or publication-eligible in this audit.",
  },
  {
    id: "candidate-media-verifier",
    purpose: "Deterministic local renderer, source-bound sidecar, story support and fail-closed candidate verification.",
    paths: [
      "docs/demo/nerveloop-effect-firewall-candidate.json",
      "docs/demo/submission-storyboard.json",
      "research/evidence/2026-09-01-provenance-cleared-media-experiment/font8x8_basic.h",
      "scripts/render-effect-firewall-candidate.mjs",
      "scripts/render-effect-firewall-candidate.test.mjs",
      "scripts/verify-judge-story-contract.mjs",
    ],
    note: "These source/support files make deliberately supplied local media reviewable. Both MP4s remain outside the automatic source-release set and still need independent human selection, review and upload authority.",
  },
];

export const PUBLIC_SOURCE_REPRODUCTION_COMMANDS = [
  "npm ci",
  "npm test -w @launchpad/server -- --run src/effect-policy.test.ts src/effect-capability.test.ts src/run-guard.test.ts src/agent-service.test.ts src/effect-receipt-automaton.test.ts src/effect-sink.test.ts",
  "node --test scripts/effect-firewall-adversarial-matrix.test.mjs",
  "node --test scripts/effect-sink-redemption-lab.test.mjs",
  "node --test scripts/track-c-condition-benchmark.test.mjs",
  "./node_modules/.bin/tsx scripts/track-c-condition-benchmark.mjs --json",
  "npm run typecheck -w @launchpad/web",
  "npm run build -w @launchpad/web",
  "npm run submission:source-check",
];

// Backward-compatible source-only alias. Media-dependent commands must never be
// added here; they belong to LOCAL_MEDIA_SUPPLIED_REVIEW_COMMANDS below.
export const PUBLIC_REPRODUCTION_COMMANDS = PUBLIC_SOURCE_REPRODUCTION_COMMANDS;

export const LOCAL_MEDIA_REVIEW_INPUTS = [
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
];

export const LOCAL_MEDIA_SUPPLIED_REVIEW_COMMANDS = [
  "node --test scripts/run-track-c-kill-switch-demo.test.mjs",
  "npm run submission:story-check",
  "node --test scripts/render-effect-firewall-candidate.test.mjs",
  "node scripts/render-effect-firewall-candidate.mjs --verify-only",
  "npm run submission:final-check",
];

const SECRET_CONTENT_RULES = [
  {
    rule: "private-key-material",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  },
  {
    rule: "github-token-shape",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  },
  {
    rule: "aws-access-key-shape",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  },
  {
    rule: "slack-token-shape",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  },
];

function normalizePath(value) {
  return value.split(sep).join("/").replace(/^\.\//u, "");
}

function relativePath(root, absolutePath) {
  return normalizePath(relative(root, absolutePath));
}

function isEnvTemplate(path) {
  return /(^|\/)\.env(?:\.[^/]+)*\.(?:example|sample|template)$/iu.test(path)
    || /(^|\/)\.env\.(?:example|sample|template)$/iu.test(path);
}

export function forbiddenPathRule(inputPath) {
  const path = normalizePath(inputPath);
  const parts = path.split("/").filter(Boolean);
  const base = parts.at(-1) ?? "";
  const lowerParts = parts.map((part) => part.toLowerCase());
  const lowerBase = base.toLowerCase();

  if (lowerParts.includes("node_modules")) return "dependency-install-tree";
  if (lowerParts.includes("dist") || lowerParts.includes("build")) return "build-output";
  if (lowerParts.includes("coverage")) return "coverage-output";
  if (lowerParts.includes("data") || lowerParts.includes(".data")) return "runtime-data";
  if (lowerParts.includes("workspaces")) return "agent-workspace-state";
  if (lowerParts.includes("codex-home")) return "agent-home-state";
  if (lowerParts.includes("logs") || lowerBase.endsWith(".log")) return "runtime-log";
  if (lowerParts.includes(".local")) return "local-runtime-state";

  if ((lowerBase === ".env" || lowerBase.startsWith(".env.")) && !isEnvTemplate(path)) {
    return "environment-secret-file";
  }
  if ([".netrc", ".npmrc", ".pypirc"].includes(lowerBase)) return "credential-config";
  if (["id_rsa", "id_ed25519", "id_ecdsa"].includes(lowerBase)) return "private-key-file";
  if (/\.(?:key|p12|pfx|pem)$/iu.test(lowerBase)) return "key-or-certificate-container";
  if (/(?:^|[-_.])(?:credential|credentials|secrets?)(?:[-_.]|$)/iu.test(lowerBase)) {
    return "credential-or-secret-named-file";
  }
  if (/^service[-_.]?account.*\.json$/iu.test(lowerBase)) return "service-account-file";
  return null;
}

function isPrunableDirectory(path, rule) {
  if (normalizePath(path).split("/").includes(".git")) return true;
  return rule !== null;
}

function fileType(stats) {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isSocket()) return "socket";
  if (stats.isFIFO()) return "fifo";
  if (stats.isCharacterDevice()) return "character-device";
  if (stats.isBlockDevice()) return "block-device";
  return "special";
}

async function walkReleaseTree(root) {
  const forbiddenPresences = [];
  const symlinks = [];
  const specialFiles = [];
  const regularFiles = new Map();
  let entriesVisited = 0;
  let truncated = false;

  async function visit(directory, relativeDirectory = "") {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        specialFiles.push({
          path: normalizePath(relativeDirectory || "."),
          rule: "filesystem-directory-changed-during-audit",
        });
        return;
      }
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      entriesVisited += 1;
      if (entriesVisited > MAX_WALK_ENTRIES) {
        truncated = true;
        return;
      }

      const path = normalizePath(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name);
      if (path === ".git" || path.startsWith(".git/")) continue;
      const absolutePath = resolve(root, path);
      let stats;
      try {
        stats = await lstat(absolutePath);
      } catch (error) {
        if (error?.code === "ENOENT") {
          specialFiles.push({ path, rule: "filesystem-entry-changed-during-audit" });
          continue;
        }
        throw error;
      }
      const type = fileType(stats);
      const rule = forbiddenPathRule(path);

      if (rule) {
        forbiddenPresences.push({ path, rule, type, sizeBytes: stats.size });
      }
      if (type === "symlink") {
        symlinks.push({ path, rule: "symlink-requires-manual-target-review" });
        continue;
      }
      if (type !== "file" && type !== "directory") {
        specialFiles.push({ path, rule: `special-file-${type}` });
        continue;
      }
      if (type === "file") {
        regularFiles.set(path, { mtimeMs: stats.mtimeMs, sizeBytes: stats.size, rule });
        continue;
      }
      if (!isPrunableDirectory(path, rule)) await visit(absolutePath, path);
      if (truncated) return;
    }
  }

  await visit(root);
  return {
    entriesVisited,
    forbiddenPresences,
    regularFiles,
    specialFiles,
    symlinks,
    truncated,
  };
}

async function gitOutput(root, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.toString("utf8");
}

function splitNull(value) {
  return value.split("\0").filter(Boolean).map(normalizePath);
}

function parsePorcelain(value) {
  const tokens = value.split("\0").filter(Boolean);
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const x = token[0] ?? " ";
    const y = token[1] ?? " ";
    const path = normalizePath(token.slice(3));
    entries.push({ x, y, path });
    if ([x, y].some((code) => code === "R" || code === "C")) index += 1;
  }
  return entries;
}

export async function collectGitSnapshot(root) {
  const [trackedRaw, untrackedRaw, statusRaw, branchRaw, head] = await Promise.all([
    gitOutput(root, ["ls-files", "-z"]),
    gitOutput(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
    gitOutput(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    gitOutput(root, ["branch", "--show-current"]),
    gitOutput(root, ["rev-parse", "--verify", "HEAD"]).then((value) => value.trim()).catch(() => null),
  ]);
  const trackedPaths = splitNull(trackedRaw);
  const untrackedPaths = splitNull(untrackedRaw);
  const statusEntries = parsePorcelain(statusRaw);
  const trackedChanges = statusEntries.filter(({ x, y }) => !(x === "?" && y === "?"));
  return {
    branch: branchRaw.trim() || null,
    head,
    trackedPaths,
    untrackedPaths,
    statusEntries,
    counts: {
      tracked: trackedPaths.length,
      untracked: untrackedPaths.length,
      changedTracked: trackedChanges.length,
      staged: trackedChanges.filter(({ x }) => x !== " ").length,
      unstaged: trackedChanges.filter(({ y }) => y !== " ").length,
      conflicts: trackedChanges.filter(({ x, y }) => x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")).length,
    },
  };
}

function gitState(path, trackedSet, untrackedSet, changedSet) {
  if (trackedSet.has(path)) return changedSet.has(path) ? "tracked-changed" : "tracked-unchanged";
  if (untrackedSet.has(path)) return "untracked";
  return "not-in-git-publication-set";
}

function isHumanFacingPath(path) {
  const extension = extname(path).toLowerCase();
  return path === "README.md"
    || path === "devpost-submission.md"
    || path.startsWith("docs/") && [".html", ".json", ".md", ".srt", ".svg"].includes(extension)
    || path === "apps/web/index.html"
    || path.startsWith("apps/web/src/") && [".css", ".html", ".js", ".jsx", ".ts", ".tsx"].includes(extension);
}

function isTextCandidate(path, metadata) {
  return metadata.sizeBytes <= MAX_TEXT_SCAN_BYTES && TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}

async function inspectTextCandidates(root, candidatePaths, regularFiles) {
  const historicalTrackLabelReferences = [];
  const inspectionErrors = [];
  const staleTrackLabels = [];
  const sensitiveContentFindings = [];
  const scanned = [];
  for (const path of [...candidatePaths].sort()) {
    const metadata = regularFiles.get(path);
    if (!metadata || metadata.rule || !isTextCandidate(path, metadata)) continue;
    let buffer;
    try {
      buffer = await readFile(resolve(root, path));
    } catch {
      inspectionErrors.push({ path, rule: "text-file-changed-or-unreadable-during-audit" });
      continue;
    }
    if (buffer.includes(0)) continue;
    const text = buffer.toString("utf8");
    scanned.push(path);
    if (isHumanFacingPath(path)) {
      let hasStaleLabel = false;
      let hasHistoricalReference = false;
      for (const line of text.split(/\r?\n/u)) {
        if (!/\bTrack\s+C\b/iu.test(line)) continue;
        if (/\b(?:compatib|former|histor|legacy|migration|not\s+(?:an?\s+)?official|old\s+label|obsolete|quoted|renamed|replaced|stale)\w*/iu.test(line)) {
          hasHistoricalReference = true;
        } else {
          hasStaleLabel = true;
        }
      }
      if (hasStaleLabel) staleTrackLabels.push({ path, rule: "stale-human-label-track-c" });
      if (hasHistoricalReference) {
        historicalTrackLabelReferences.push({ path, rule: "historical-track-c-reference-review-only" });
      }
    }
    for (const { rule, pattern } of SECRET_CONTENT_RULES) {
      if (pattern.test(text)) sensitiveContentFindings.push({ path, rule });
    }
  }
  return {
    historicalTrackLabelReferences,
    inspectionErrors,
    scannedTextFileCount: scanned.length,
    sensitiveContentFindings,
    staleTrackLabels,
  };
}

async function inspectClosureManifests(root, regularFiles) {
  const manifests = {};
  const allIssues = [];
  for (const [id, contract] of Object.entries(CLOSURE_CONTRACTS)) {
    const issues = [];
    const metadata = regularFiles.get(contract.path);
    let entries = [];
    let manifestSha256 = null;
    if (!metadata || metadata.rule) {
      issues.push({ path: contract.path, rule: "closure-manifest-not-safe-regular-file" });
    } else {
      try {
        const raw = await readFile(resolve(root, contract.path));
        manifestSha256 = createHash("sha256").update(raw).digest("hex");
        entries = raw.toString("utf8").split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
      } catch {
        issues.push({ path: contract.path, rule: "closure-manifest-unreadable" });
      }
    }
    if (entries.length !== contract.expectedCount) {
      issues.push({ path: contract.path, rule: "closure-manifest-count-mismatch" });
    }
    if (new Set(entries).size !== entries.length) {
      issues.push({ path: contract.path, rule: "closure-manifest-duplicate-path" });
    }
    if (JSON.stringify(entries) !== JSON.stringify([...entries].sort())) {
      issues.push({ path: contract.path, rule: "closure-manifest-not-sorted" });
    }
    const videoFiles = [];
    for (const path of entries) {
      if (isAbsolute(path) || path === ".." || path.startsWith("../") || path.includes("/../") || path.includes("\\")) {
        issues.push({ path: contract.path, rule: "closure-manifest-unsafe-path" });
        continue;
      }
      if (!regularFiles.has(path) || regularFiles.get(path)?.rule) {
        issues.push({ path, rule: "closure-entry-not-safe-regular-file" });
      }
      if (VIDEO_EXTENSIONS.has(extname(path).toLowerCase())) videoFiles.push(path);
    }
    if (!contract.permitsVideo && videoFiles.length > 0) {
      issues.push({ path: contract.path, rule: "public-closure-contains-video" });
    }
    manifests[id] = {
      path: contract.path,
      expectedCount: contract.expectedCount,
      count: entries.length,
      sha256: manifestSha256,
      videoFiles,
      entries,
      issues,
    };
    allIssues.push(...issues);
  }

  const publicSet = new Set(manifests.publicSource.entries);
  const operationalSet = new Set(manifests.operational.entries);
  const publicMissingFromOperational = manifests.publicSource.entries
    .filter((path) => !operationalSet.has(path));
  const operationalOnly = manifests.operational.entries
    .filter((path) => !publicSet.has(path));
  if (publicMissingFromOperational.length > 0) {
    allIssues.push({
      path: CLOSURE_CONTRACTS.operational.path,
      rule: "operational-closure-missing-public-entry",
    });
  }
  if (JSON.stringify(operationalOnly) !== JSON.stringify(EXPECTED_OPERATIONAL_MEDIA_ONLY)) {
    allIssues.push({
      path: CLOSURE_CONTRACTS.operational.path,
      rule: "operational-only-paths-mismatch",
    });
  }

  return {
    passed: allIssues.length === 0,
    publicSource: {
      path: manifests.publicSource.path,
      expectedCount: manifests.publicSource.expectedCount,
      count: manifests.publicSource.count,
      sha256: manifests.publicSource.sha256,
      videoFiles: manifests.publicSource.videoFiles,
    },
    operational: {
      path: manifests.operational.path,
      expectedCount: manifests.operational.expectedCount,
      count: manifests.operational.count,
      sha256: manifests.operational.sha256,
      operationalOnly,
    },
    publicMissingFromOperational,
    issues: allIssues,
    proofBoundary:
      "This validates declared file selection, regular-file presence and the exact source/media relationship. It does not execute install, build, tests, playback or public-clone verification.",
  };
}

async function readStoryContract(root, regularFiles) {
  const path = "docs/demo/track-c-opening.json";
  const metadata = regularFiles.get(path);
  if (!metadata || metadata.rule) {
    return { path, parsed: null, parseError: "story-contract-not-safe-regular-file" };
  }
  try {
    const contents = await readFile(resolve(root, path), "utf8");
    const parsed = JSON.parse(contents);
    return { path, parsed, parseError: null };
  } catch {
    return { path, parsed: null, parseError: "story-contract-unreadable-or-invalid-json" };
  }
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeStoryPath(value) {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) return null;
  const normalized = normalizePath(value);
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) return null;
  return normalized;
}

async function sha256File(root, path) {
  return createHash("sha256").update(await readFile(resolve(root, path))).digest("hex");
}

async function inspectCandidateBinding(root, storyContract, regularFiles) {
  const candidate = storyContract.parsed?.candidate;
  const issues = [];
  if (!candidate || typeof candidate !== "object") {
    return {
      localSourceBindingPassed: false,
      videoPath: null,
      sidecarPath: null,
      sourceBindingsChecked: 0,
      decodedFramesCheckedByThisAudit: 0,
      issues: [{ path: storyContract.path, rule: "candidate-contract-missing" }],
    };
  }

  const videoPath = safeStoryPath(candidate.video);
  const sidecarPath = safeStoryPath(candidate.sidecar);
  if (!videoPath) issues.push({ path: storyContract.path, rule: "candidate-video-path-invalid" });
  if (!sidecarPath) issues.push({ path: storyContract.path, rule: "candidate-sidecar-path-invalid" });
  for (const [path, role] of [[videoPath, "video"], [sidecarPath, "sidecar"]]) {
    if (!path) continue;
    const metadata = regularFiles.get(path);
    if (!metadata || metadata.rule) issues.push({ path, rule: `candidate-${role}-not-safe-regular-file` });
    if (metadata?.sizeBytes > GITHUB_FILE_BLOCK_BYTES) issues.push({ path, rule: `candidate-${role}-over-100-mib` });
  }

  let sidecar = null;
  if (sidecarPath && !issues.some(({ path }) => path === sidecarPath)) {
    try {
      if ((regularFiles.get(sidecarPath)?.sizeBytes ?? Infinity) > MAX_TEXT_SCAN_BYTES) {
        issues.push({ path: sidecarPath, rule: "candidate-sidecar-too-large" });
      } else {
        sidecar = JSON.parse(await readFile(resolve(root, sidecarPath), "utf8"));
      }
    } catch {
      issues.push({ path: sidecarPath, rule: "candidate-sidecar-unreadable-or-invalid-json" });
    }
  }

  if (videoPath && !issues.some(({ path }) => path === videoPath)) {
    const actualVideoHash = await sha256File(root, videoPath);
    if (actualVideoHash !== candidate.videoSha256) {
      issues.push({ path: videoPath, rule: "candidate-video-hash-mismatch-story" });
    }
    if (sidecar && actualVideoHash !== sidecar.video?.sha256) {
      issues.push({ path: videoPath, rule: "candidate-video-hash-mismatch-sidecar" });
    }
    if (sidecar && regularFiles.get(videoPath)?.sizeBytes !== sidecar.video?.sizeBytes) {
      issues.push({ path: videoPath, rule: "candidate-video-size-mismatch-sidecar" });
    }
  }
  if (sidecarPath && sidecar && !issues.some(({ path }) => path === sidecarPath)) {
    const actualSidecarHash = await sha256File(root, sidecarPath);
    if (actualSidecarHash !== candidate.sidecarSha256) {
      issues.push({ path: sidecarPath, rule: "candidate-sidecar-hash-mismatch-story" });
    }
    if (sidecar.schemaVersion !== candidate.sidecarSchema) {
      issues.push({ path: sidecarPath, rule: "candidate-sidecar-schema-mismatch-story" });
    }
    if (candidate.sidecarKind && sidecar.kind !== candidate.sidecarKind) {
      issues.push({ path: sidecarPath, rule: "candidate-sidecar-kind-mismatch-story" });
    }
    if (sidecar.video?.path !== videoPath) {
      issues.push({ path: sidecarPath, rule: "candidate-sidecar-video-path-mismatch" });
    }
    const provenance = candidate.renderingProvenance;
    if (provenance && (
      sidecar.rendering?.importedScreenshots !== provenance.importedScreenshots
      || sidecar.rendering?.importedImages !== provenance.importedImages
      || sidecar.rendering?.systemFontResolution !== provenance.systemFontResolution
      || sidecar.rendering?.bitmapFont?.path !== provenance.bitmapFont?.path
      || sidecar.rendering?.bitmapFont?.sha256 !== provenance.bitmapFont?.sha256
      || sidecar.rendering?.bitmapFont?.upstreamCommit !== provenance.bitmapFont?.upstreamCommit
      || sidecar.rendering?.bitmapFont?.upstreamDeclaration !== provenance.bitmapFont?.upstreamDeclaration
      || sidecar.rendering?.bitmapFont?.declarationIndependentlyAdjudicated !==
        provenance.bitmapFont?.declarationIndependentlyAdjudicated
    )) {
      issues.push({ path: sidecarPath, rule: "candidate-rendering-provenance-mismatch-story" });
    }
  }

  if (!(Number(candidate.durationSeconds) > 0 && Number(candidate.durationSeconds) <= Number(candidate.maximumDurationSeconds) && Number(candidate.maximumDurationSeconds) <= 180)) {
    issues.push({ path: storyContract.path, rule: "candidate-duration-contract-invalid" });
  }
  if (sidecar && Number(sidecar.media?.durationSeconds) !== Number(candidate.durationSeconds)) {
    issues.push({ path: sidecarPath, rule: "candidate-duration-mismatch-sidecar" });
  }
  const mediaComparisons = [
    [candidate.videoCodec, sidecar?.media?.video?.codec, "video-codec"],
    [candidate.pixelFormat, sidecar?.media?.video?.pixelFormat, "pixel-format"],
    [candidate.frameRate, sidecar?.media?.video?.frameRate, "frame-rate"],
    [candidate.audioCodec, sidecar?.media?.audio?.codec, "audio-codec"],
    [Number(candidate.audioSampleRate), Number(sidecar?.media?.audio?.sampleRate), "audio-sample-rate"],
    [Number(candidate.audioChannels), Number(sidecar?.media?.audio?.channels), "audio-channels"],
    [Number(candidate.width), Number(sidecar?.media?.video?.width), "width"],
    [Number(candidate.height), Number(sidecar?.media?.video?.height), "height"],
  ];
  for (const [declared, observed, label] of mediaComparisons) {
    if (!sidecar || declared !== observed) {
      issues.push({ path: sidecarPath ?? storyContract.path, rule: `candidate-${label}-mismatch-sidecar` });
    }
  }

  let sourceBindingsChecked = 0;
  if (!Array.isArray(sidecar?.sourceBindings)
    || sidecar.sourceBindings.length !== Number(candidate.sourceBindingCount)) {
    issues.push({ path: sidecarPath ?? storyContract.path, rule: "candidate-source-binding-count-mismatch" });
  } else {
    for (const source of sidecar.sourceBindings) {
      const path = safeStoryPath(source?.path);
      if (!path || !regularFiles.has(path) || regularFiles.get(path)?.rule) {
        issues.push({ path: path ?? sidecarPath, rule: "candidate-source-binding-path-invalid" });
        continue;
      }
      sourceBindingsChecked += 1;
      if (await sha256File(root, path) !== source.sha256) {
        issues.push({ path, rule: "candidate-source-binding-hash-mismatch" });
      }
    }
  }
  if (!Array.isArray(sidecar?.sampleFrames)
    || sidecar.sampleFrames.length !== Number(candidate.sampleFrameCount)) {
    issues.push({ path: sidecarPath ?? storyContract.path, rule: "candidate-sample-frame-count-mismatch" });
  }

  const renderScriptPath = safeStoryPath(sidecar?.renderScript?.path);
  if (!renderScriptPath || !regularFiles.has(renderScriptPath) || regularFiles.get(renderScriptPath)?.rule) {
    issues.push({ path: renderScriptPath ?? sidecarPath, rule: "candidate-render-script-path-invalid" });
  } else if (await sha256File(root, renderScriptPath) !== sidecar.renderScript.sha256) {
    issues.push({ path: renderScriptPath, rule: "candidate-render-script-hash-mismatch" });
  }

  return {
    localSourceBindingPassed: issues.length === 0,
    videoPath,
    sidecarPath,
    sourceBindingsChecked,
    decodedFramesCheckedByThisAudit: 0,
    issues,
    proofBoundary:
      "Binds local candidate bytes, sidecar metadata, render source and source files. This audit does not decode frames, listen to audio, watch the full video, verify rights, upload it or make it part of an automatic Git selection.",
  };
}

function redactedMarker(rule, value) {
  return `[redacted-${rule}-${createHash("sha256").update(value).digest("hex").slice(0, 12)}]`;
}

function redactKnownSecretShapes(value) {
  return value
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, (match) => redactedMarker("github-token", match))
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, (match) => redactedMarker("aws-key", match))
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu, (match) => redactedMarker("slack-token", match));
}

function redactSensitivePath(value) {
  return redactKnownSecretShapes(value)
    .split("/")
    .map((component) => {
      if (/(?:^|[-_.])(?:api[-_]?key|credential|password|secret|token)[=._-][^/]{8,}/iu.test(component)) {
        return redactedMarker("sensitive-filename", component);
      }
      return component;
    })
    .join("/");
}

function disclosureSafe(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => disclosureSafe(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, disclosureSafe(childValue, childKey)]),
    );
  }
  if (typeof value !== "string") return value;
  const knownShapesRedacted = redactKnownSecretShapes(value);
  return /path|candidateVideo/iu.test(key)
    ? redactSensitivePath(knownShapesRedacted)
    : knownShapesRedacted;
}

function summarizeCategories(paths, trackedSet, untrackedSet) {
  const counts = {};
  for (const path of paths) {
    const extension = extname(path).toLowerCase();
    let category = "other-review-required";
    if (VIDEO_EXTENSIONS.has(extension) || /\.(?:gif|jpe?g|png|svg|webp)$/iu.test(extension)) category = "media";
    else if (path.startsWith("research/evidence/")) category = "evidence";
    else if (path.startsWith("apps/") && /\.(?:[cm]?[jt]sx?|css|html)$/iu.test(extension)) category = "application-source";
    else if (path.startsWith("scripts/")) category = "scripts-and-verifiers";
    else if (path.startsWith("docs/") || extension === ".md") category = "documentation";
    else if ([".json", ".toml", ".yaml", ".yml"].includes(extension) || ["Dockerfile", ".gitignore"].includes(path)) category = "project-config";
    const current = counts[category] ?? { total: 0, tracked: 0, untracked: 0 };
    current.total += 1;
    if (trackedSet.has(path)) current.tracked += 1;
    if (untrackedSet.has(path)) current.untracked += 1;
    counts[category] = current;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function candidateVideoFromStory(story) {
  return story.parsed?.candidate?.video
    ?? story.parsed?.preservation?.currentCandidateVideo
    ?? null;
}

function makeStoryGates(storyContract, candidateBinding, gitSnapshot, staleTrackLabels) {
  const preservation = storyContract.parsed?.preservation ?? null;
  const currentCandidateVideo = candidateVideoFromStory(storyContract);
  return [
    {
      id: "official-track-label",
      cleared: staleTrackLabels.length === 0,
      evidence: staleTrackLabels.length === 0
        ? "No literal human-facing 'Track C' labels were found in the scanned publication set."
        : `${staleTrackLabels.length} human-facing file(s) still contain a literal 'Track C' label.`,
    },
    {
      id: "current-source-is-public",
      cleared: false,
      evidence: `${gitSnapshot.counts.changedTracked} changed tracked and ${gitSnapshot.counts.untracked} untracked file(s) require deliberate source review; this audit does not inspect or change the remote.`,
    },
    {
      id: "fresh-story-contract-verifier",
      cleared: false,
      evidence: "Run npm run submission:story-check after the final source and media choices; this inventory does not inherit an older pass.",
    },
    {
      id: "current-candidate-video",
      cleared: candidateBinding.localSourceBindingPassed,
      evidence: candidateBinding.localSourceBindingPassed
        ? `The local candidate, sidecar, renderer and ${candidateBinding.sourceBindingsChecked} source binding(s) match; the MP4 remains excluded from automatic Git selection.`
        : currentCandidateVideo
          ? `A candidate is named by the story contract (${currentCandidateVideo}) but its local source binding is incomplete or stale.`
        : "The story contract names no current candidate video; the stable MP4 is fallback-only and does not reflect the current narrative.",
    },
    {
      id: "human-playback-and-rights-review",
      cleared: storyContract.parsed?.releaseGates?.humanPlaybackReview === true,
      evidence: storyContract.parsed?.releaseGates?.humanPlaybackReview === true
        ? "The story contract records human playback review; rights and upload authority remain separate gates."
        : "Local hash/source checks do not replace watching the full video, listening to audio, checking readable frames and confirming asset rights.",
    },
    {
      id: "public-youtube-url",
      cleared: false,
      evidence: "A public <=3-minute YouTube URL still requires entrant action and live verification.",
    },
    {
      id: "external-publication-authority",
      cleared: false,
      evidence: "Commit, push, upload and Devpost submission require explicit entrant authority after human review.",
    },
  ];
}

export async function auditTrack1Release(root, { gitSnapshot: providedGitSnapshot } = {}) {
  const absoluteRoot = resolve(root);
  const [walk, gitSnapshot] = await Promise.all([
    walkReleaseTree(absoluteRoot),
    providedGitSnapshot ? Promise.resolve(providedGitSnapshot) : collectGitSnapshot(absoluteRoot),
  ]);
  const trackedSet = new Set(gitSnapshot.trackedPaths.map(normalizePath));
  const untrackedSet = new Set(gitSnapshot.untrackedPaths.map(normalizePath));
  const changedSet = new Set(
    gitSnapshot.statusEntries
      .filter(({ x, y }) => !(x === "?" && y === "?"))
      .map(({ path }) => normalizePath(path)),
  );
  const publicationSet = new Set([...trackedSet, ...untrackedSet]);

  const essentialGroups = ESSENTIAL_RELEASE_GROUPS.map((group) => ({
    ...group,
    files: group.paths.map((path) => ({
      path,
      present: walk.regularFiles.has(path),
      gitState: gitState(path, trackedSet, untrackedSet, changedSet),
    })),
  }));
  const missingEssential = essentialGroups.flatMap((group) => group.files
    .filter(({ present }) => !present)
    .map(({ path }) => ({ path, rule: `missing-essential:${group.id}` })));
  const unpublishedEssential = essentialGroups.flatMap((group) => group.files
    .filter(({ present, gitState: state }) => present && state === "not-in-git-publication-set")
    .map(({ path }) => ({ path, rule: `essential-not-in-git-publication-set:${group.id}` })));
  const untrackedEssential = essentialGroups.flatMap((group) => group.files
    .filter(({ present, gitState: state }) => present && state === "untracked")
    .map(({ path }) => ({ path, rule: `untracked-essential-requires-selection:${group.id}` })));
  const changedTrackedEssential = essentialGroups.flatMap((group) => group.files
    .filter(({ present, gitState: state }) => present && state === "tracked-changed")
    .map(({ path }) => ({ path, rule: `changed-essential-requires-diff-review:${group.id}` })));

  const publicationForbidden = [...publicationSet]
    .map((path) => ({ path, rule: forbiddenPathRule(path) }))
    .filter(({ rule }) => rule !== null)
    .sort((left, right) => left.path.localeCompare(right.path));
  const publicationSymlinks = walk.symlinks.filter(({ path }) => publicationSet.has(path));
  const publicationSpecialFiles = walk.specialFiles.filter(({ path }) => publicationSet.has(path));

  const sizeFindings = [...publicationSet]
    .map((path) => ({ path, sizeBytes: walk.regularFiles.get(path)?.sizeBytes ?? null }))
    .filter(({ sizeBytes }) => sizeBytes !== null && sizeBytes > GITHUB_FILE_WARNING_BYTES)
    .map(({ path, sizeBytes }) => ({
      path,
      sizeBytes,
      rule: sizeBytes > GITHUB_FILE_BLOCK_BYTES
        ? "github-regular-git-hard-block-over-100-mib"
        : "github-regular-git-warning-over-50-mib",
    }))
    .sort((left, right) => right.sizeBytes - left.sizeBytes || left.path.localeCompare(right.path));

  const textInspection = await inspectTextCandidates(
    absoluteRoot,
    publicationSet,
    walk.regularFiles,
  );
  const storyContract = await readStoryContract(absoluteRoot, walk.regularFiles);
  const candidateBinding = await inspectCandidateBinding(
    absoluteRoot,
    storyContract,
    walk.regularFiles,
  );
  const closureManifestReview = await inspectClosureManifests(
    absoluteRoot,
    walk.regularFiles,
  );
  const videoFiles = [...publicationSet]
    .filter((path) => VIDEO_EXTENSIONS.has(extname(path).toLowerCase()))
    .map((path) => ({
      path,
      sizeBytes: walk.regularFiles.get(path)?.sizeBytes ?? null,
      publicationEligible: false,
      rule: "video-excluded-pending-human-playback-rights-and-authority",
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  const storyGates = makeStoryGates(
    storyContract,
    candidateBinding,
    gitSnapshot,
    textInspection.staleTrackLabels,
  );
  const unresolvedStoryGateCount = storyGates.filter(({ cleared }) => !cleared).length;
  const blockingFindingCount = missingEssential.length
    + unpublishedEssential.length
    + untrackedEssential.length
    + changedTrackedEssential.length
    + publicationForbidden.length
    + publicationSymlinks.length
    + publicationSpecialFiles.length
    + sizeFindings.filter(({ rule }) => rule.includes("hard-block")).length
    + textInspection.sensitiveContentFindings.length
    + textInspection.staleTrackLabels.length
    + textInspection.inspectionErrors.length
    + candidateBinding.issues.length
    + closureManifestReview.issues.length
    + unresolvedStoryGateCount
    + (storyContract.parseError ? 1 : 0)
    + (walk.truncated ? 1 : 0);

  const gitInventoryDigest = sha256Json({
    trackedPaths: [...trackedSet].sort(),
    untrackedPaths: [...untrackedSet].sort(),
    statusEntries: gitSnapshot.statusEntries,
  });
  const workingTreeMetadataDigest = sha256Json(
    [...publicationSet]
      .filter((path) => path !== RECEIPT_RELATIVE_PATH)
      .sort()
      .map((path) => ({
        path,
        gitState: gitState(path, trackedSet, untrackedSet, changedSet),
        present: walk.regularFiles.has(path),
        sizeBytes: walk.regularFiles.get(path)?.sizeBytes ?? null,
        mtimeMs: walk.regularFiles.get(path)?.mtimeMs ?? null,
      })),
  );
  const generatedAt = new Date().toISOString();

  const receipt = {
    schemaVersion: 1,
    kind: "track1-source-release-human-review-gate",
    generatedAt,
    officialTrack: "Track #1: Agent Launchpad: Design and Build Lightweight Agent Middleware",
    status: "REVIEW_REQUIRED",
    publicationAuthorized: false,
    automaticPushVerdict: null,
    proofBoundary:
      "Local names, metadata, bounded text rules and Git inventory only. It does not prove secret absence, clean-room reproducibility, remote parity, media quality, licensing approval, public availability or Devpost submission.",
    inventory: {
      branch: gitSnapshot.branch,
      head: gitSnapshot.head ?? null,
      ...gitSnapshot.counts,
      filesystemEntriesVisited: walk.entriesVisited,
      filesystemWalkTruncated: walk.truncated,
      publicationSetCount: publicationSet.size,
      categoryCounts: summarizeCategories(publicationSet, trackedSet, untrackedSet),
    },
    freshness: {
      capturedAt: generatedAt,
      gitHead: gitSnapshot.head ?? null,
      gitInventoryDigest,
      workingTreeMetadataDigest,
      receiptExcludedFromWorkingTreeMetadataDigest: RECEIPT_RELATIVE_PATH,
      rerunRequiredAfterAnyFileChange: true,
    },
    essentialGroups,
    missingEssential,
    unpublishedEssential,
    essentialGitStateReview: {
      untracked: untrackedEssential,
      changedTracked: changedTrackedEssential,
    },
    forbiddenPathReview: {
      presentOnDisk: walk.forbiddenPresences,
      inGitPublicationSet: publicationForbidden,
    },
    specialFileReview: {
      symlinksOnDisk: walk.symlinks,
      symlinksInGitPublicationSet: publicationSymlinks,
      specialFilesOnDisk: walk.specialFiles,
      specialFilesInGitPublicationSet: publicationSpecialFiles,
    },
    sizeReview: {
      githubRegularGitWarningBytes: GITHUB_FILE_WARNING_BYTES,
      githubRegularGitHardBlockBytes: GITHUB_FILE_BLOCK_BYTES,
      officialReference: "https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github",
      findings: sizeFindings,
    },
    contentRuleReview: {
      scannedTextFileCount: textInspection.scannedTextFileCount,
      inspectionErrors: textInspection.inspectionErrors,
      historicalTrackLabelReferences: textInspection.historicalTrackLabelReferences,
      sensitiveFindings: textInspection.sensitiveContentFindings,
      staleTrackLabels: textInspection.staleTrackLabels,
      disclosureRule: "Findings contain path and rule only; no matching value or surrounding content is emitted.",
    },
    mediaReview: {
      automaticallyIncludedVideos: [],
      excludedVideos: videoFiles,
      candidateVideoFromStoryContract: candidateVideoFromStory(storyContract),
      stableFallbackCurrentNarrative: storyContract.parsed?.preservation?.currentNarrativeReflectedByStableArtifacts ?? null,
      independentValidationRequired: true,
      candidateBinding,
    },
    storyContract: {
      path: storyContract.path,
      parsed: storyContract.parsed !== null,
      parseErrorRule: storyContract.parseError,
      digest: storyContract.parsed ? sha256Json(storyContract.parsed) : null,
    },
    closureManifestReview,
    unresolvedGates: storyGates.filter(({ cleared }) => !cleared),
    publicSourceReproductionCommands: PUBLIC_SOURCE_REPRODUCTION_COMMANDS.map((command) => ({
      command,
      executedByThisAudit: false,
      requiresMedia: false,
    })),
    localMediaSuppliedReviewCommands: LOCAL_MEDIA_SUPPLIED_REVIEW_COMMANDS.map((command) => ({
      command,
      executedByThisAudit: false,
      requiresHumanSelectedMedia: true,
      requiredMedia: LOCAL_MEDIA_REVIEW_INPUTS,
    })),
    humanReviewChecklist: [
      "Select files deliberately from the essential groups; do not bulk-add the dirty worktree.",
      "Resolve every forbidden, sensitive-name/content, symlink, special-file, oversize and stale-label finding without printing secrets.",
      "Clone the exact proposed commit into a clean temporary directory and run every public source reproduction command without adding either MP4.",
      "Only after a human selects the exact candidate and stable fallback, supply both hash-matched MP4s locally and run every local media review command.",
      "Review licenses and ownership for every source, dependency, screenshot, font and media asset selected for release.",
      "Keep all video excluded until an independent reviewer binds hash, duration, codecs, opening frame, narrative match and playback result.",
      "Verify the public repository commit and public <=3-minute YouTube URL from unauthenticated surfaces.",
      "Obtain explicit entrant authority before commit, push, upload or Devpost submission.",
    ],
    findingCounts: {
      blocking: blockingFindingCount,
      missingEssential: missingEssential.length,
      unpublishedEssential: unpublishedEssential.length,
      untrackedEssential: untrackedEssential.length,
      changedTrackedEssential: changedTrackedEssential.length,
      forbiddenInPublicationSet: publicationForbidden.length,
      symlinksInPublicationSet: publicationSymlinks.length,
      specialFilesInPublicationSet: publicationSpecialFiles.length,
      githubHardBlocks: sizeFindings.filter(({ rule }) => rule.includes("hard-block")).length,
      githubWarnings: sizeFindings.filter(({ rule }) => rule.includes("warning")).length,
      sensitiveContentRules: textInspection.sensitiveContentFindings.length,
      textInspectionErrors: textInspection.inspectionErrors.length,
      candidateBindingIssues: candidateBinding.issues.length,
      closureManifestIssues: closureManifestReview.issues.length,
      staleTrackLabels: textInspection.staleTrackLabels.length,
      excludedVideos: videoFiles.length,
      unresolvedStoryAndAuthorityGates: unresolvedStoryGateCount,
    },
    externalAuthorityGate:
      "OPEN: no commit, push, upload, public-link verification or Devpost submission is authorized or performed by this audit.",
  };
  return disclosureSafe(receipt);
}

function parseArgs(argv) {
  const args = { root: scriptRoot, writeReceipt: false, receiptPath: defaultReceiptPath };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write-receipt") args.writeReceipt = true;
    else if (argument === "--root") args.root = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  args.receiptPath = resolve(args.root, RECEIPT_RELATIVE_PATH);
  return args;
}

export async function writeReceiptSafely(root, receipt) {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, RECEIPT_RELATIVE_PATH);
  const rootStats = await lstat(absoluteRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("Audit root must be a real directory, not a symlink.");
  }

  const parentParts = dirname(RECEIPT_RELATIVE_PATH).split("/");
  let current = absoluteRoot;
  for (const part of parentParts) {
    current = resolve(current, part);
    try {
      const stats = await lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error("Receipt parent path contains a symlink or non-directory.");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current);
      const created = await lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new Error("Receipt parent directory was not created safely.");
      }
    }
  }

  const [realRoot, realParent] = await Promise.all([realpath(absoluteRoot), realpath(dirname(target))]);
  const parentRelative = relative(realRoot, realParent);
  if (parentRelative === ".." || parentRelative.startsWith(`..${sep}`)) {
    throw new Error("Receipt parent resolves outside the audited repository.");
  }

  try {
    const existing = await lstat(target);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("Receipt destination must be a regular file or absent.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error("This platform cannot guarantee no-follow receipt writes.");
  }
  const handle = await open(
    target,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return target;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const receipt = await auditTrack1Release(args.root);
  if (args.writeReceipt) {
    await writeReceiptSafely(args.root, receipt);
    receipt.receiptPath = relativePath(args.root, args.receiptPath);
  }
  console.log(JSON.stringify(receipt, null, 2));
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
