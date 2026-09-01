#!/usr/bin/env node

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync, readFileSync} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {verifyCandidateReceipt} from './render-effect-firewall-candidate.mjs';
import {verifyJudgeStoryContract} from './verify-judge-story-contract.mjs';

export const OFFICIAL_TRACK =
  'Track #1: Agent Launchpad: Design and Build Lightweight Agent Middleware';
export const PUBLIC_MANIFEST = 'docs/TRACK1_PUBLIC_SOURCE_CLOSURE.txt';
export const OPERATIONAL_MANIFEST = 'docs/TRACK1_OPERATIONAL_CLOSURE.txt';
export const EXPECTED_PUBLIC_COUNT = 104;
export const EXPECTED_OPERATIONAL_COUNT = 108;
export const EXPECTED_MEDIA_ONLY_PATHS = Object.freeze([
  'apps/web/public/demo/video-incident/broken.mp4',
  'apps/web/public/demo/video-incident/repaired.mp4',
  'docs/demo/nerveloop-effect-firewall-candidate.mp4',
  'docs/demo/nerveloop-submission-draft.mp4',
]);

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const videoExtension = /\.(?:avi|m4v|mkv|mov|mp4|webm)$/iu;
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function regularFile(path, label) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular file`);
  return path;
}

export function parseManifestText(text) {
  const paths = text.split(/\r?\n/u).map(value => value.trim()).filter(Boolean);
  assert.ok(paths.length > 0, 'manifest must not be empty');
  assert.equal(new Set(paths).size, paths.length, 'manifest paths must be unique');
  assert.deepEqual(paths, [...paths].sort(), 'manifest paths must be sorted');
  for (const path of paths) {
    assert.equal(isAbsolute(path), false, `manifest path must be relative: ${path}`);
    assert.equal(path.startsWith('../') || path.includes('/../'), false, `manifest path escapes root: ${path}`);
    assert.equal(path.includes('\\'), false, `manifest path must use forward slashes: ${path}`);
  }
  return paths;
}

function loadManifest(repository, manifestPath, {requireEntries}) {
  const absoluteManifest = regularFile(join(repository, manifestPath), manifestPath);
  const paths = parseManifestText(readFileSync(absoluteManifest, 'utf8'));
  if (requireEntries) {
    for (const path of paths) {
      const absolute = resolve(repository, path);
      assert.equal(relative(repository, absolute).startsWith('..'), false, `manifest path escapes repository: ${path}`);
      regularFile(absolute, path);
    }
  }
  return {path: manifestPath, sha256: sha256(absoluteManifest), paths};
}

export function summarizeClosures({publicPaths, operationalPaths}) {
  const publicSet = new Set(publicPaths);
  const operationalSet = new Set(operationalPaths);
  const publicMissingFromOperational = publicPaths.filter(path => !operationalSet.has(path));
  const operationalOnly = operationalPaths.filter(path => !publicSet.has(path));
  const publicVideos = publicPaths.filter(path => videoExtension.test(path));
  return {
    publicCount: publicPaths.length,
    operationalCount: operationalPaths.length,
    publicVideos,
    publicMissingFromOperational,
    operationalOnly,
    exact:
      publicPaths.length === EXPECTED_PUBLIC_COUNT &&
      operationalPaths.length === EXPECTED_OPERATIONAL_COUNT &&
      publicVideos.length === 0 &&
      publicMissingFromOperational.length === 0 &&
      JSON.stringify(operationalOnly) === JSON.stringify(EXPECTED_MEDIA_ONLY_PATHS),
  };
}

export function extractSubmissionPacket(text) {
  const title = text.match(/^# (.+)$/mu)?.[1]?.trim() ?? '';
  const summaryBlock = text.match(/## One-line Summary\s+([\s\S]*?)(?=\n## )/u)?.[1] ?? '';
  const tagline = summaryBlock.replace(/\s+/gu, ' ').trim();
  return {
    title,
    titleCharacters: title.length,
    tagline,
    taglineCharacters: tagline.length,
    officialTrackPresent: text.includes(`**${OFFICIAL_TRACK}**`),
    pendingEntrantFields: [
      'Team name and team-leader email: entrant-provided',
      'Registration confirmation: entrant-confirmed',
    ].filter(value => text.includes(value)),
    publicationLinks: {
      repository: text.match(/Public repository:\s*(https:\/\/\S+)/u)?.[1] ?? null,
      youtube: text.match(/Public YouTube URL:\s*(https:\/\/\S+)/u)?.[1] ?? null,
      projectPage: text.match(/Public project page:\s*(https:\/\/\S+)/u)?.[1] ?? null,
    },
  };
}

export function classifyFinalReadiness({mode, closure, packet, candidate = null, story = null}) {
  const packetAligned =
    packet.titleCharacters > 0 && packet.titleCharacters <= 60 &&
    packet.taglineCharacters > 0 && packet.taglineCharacters <= 200 &&
    packet.officialTrackPresent && packet.pendingEntrantFields.length === 2;
  const sourceReady = closure.exact && packetAligned;
  const localCandidateReady = mode === 'source-only'
    ? null
    : candidate?.passed === true && story?.localCandidateReady === true;
  const passed = sourceReady && (mode === 'source-only' || localCandidateReady === true);
  const externalGates = {
    humanPlaybackReview: false,
    publicRepositoryVerified: false,
    publicYoutubeVerified: false,
    teamFieldsConfirmed: false,
    devpostSubmissionVerified: false,
  };
  return {
    mode,
    status: passed
      ? mode === 'source-only'
        ? 'PUBLIC_SOURCE_CONTRACT_READY_MEDIA_EXCLUDED'
        : 'LOCAL_CANDIDATE_READY_EXTERNAL_GATES_OPEN'
      : 'LOCAL_FINAL_CHECK_FAILED',
    passed,
    sourceReady,
    localCandidateReady,
    releaseReady: false,
    externalGates,
  };
}

export function verifyTrack1FinalReadiness({repository = scriptRoot, mode = 'full'} = {}) {
  assert.ok(mode === 'full' || mode === 'source-only', `unsupported readiness mode: ${mode}`);
  const publicManifest = loadManifest(repository, PUBLIC_MANIFEST, {requireEntries: true});
  const operationalManifest = loadManifest(repository, OPERATIONAL_MANIFEST, {
    requireEntries: mode === 'full',
  });
  const closure = summarizeClosures({
    publicPaths: publicManifest.paths,
    operationalPaths: operationalManifest.paths,
  });
  const packet = extractSubmissionPacket(readFileSync(regularFile(
    join(repository, 'devpost-submission.md'),
    'devpost-submission.md',
  ), 'utf8'));
  const candidate = mode === 'full'
    ? verifyCandidateReceipt({
      root: repository,
      videoPath: join(repository, 'docs/demo/nerveloop-effect-firewall-candidate.mp4'),
      sidecarPath: join(repository, 'docs/demo/nerveloop-effect-firewall-candidate.json'),
    })
    : null;
  const story = mode === 'full' ? verifyJudgeStoryContract({repository}) : null;
  const readiness = classifyFinalReadiness({mode, closure, packet, candidate, story});
  return {
    schemaVersion: 1,
    kind: 'nerveloop-track1-final-readiness',
    officialTrack: OFFICIAL_TRACK,
    ...readiness,
    closures: {
      publicSource: {
        path: publicManifest.path,
        sha256: publicManifest.sha256,
        files: publicManifest.paths.length,
        videoFiles: closure.publicVideos.length,
      },
      operational: {
        path: operationalManifest.path,
        sha256: operationalManifest.sha256,
        files: operationalManifest.paths.length,
        mediaOnlyPaths: closure.operationalOnly,
      },
      exactRelationship: closure.exact,
      publicMissingFromOperational: closure.publicMissingFromOperational,
    },
    submissionPacket: packet,
    candidate: candidate && {
      passed: candidate.passed,
      videoSha256: candidate.videoSha256,
      durationSeconds: candidate.durationSeconds,
      dimensions: candidate.dimensions,
      sourceBindings: candidate.sourceBindings,
      sampleFrames: candidate.sampleFrames,
      stableFallbackUnchanged: candidate.stableFallbackUnchanged,
    },
    story: story && {
      status: story.status,
      contractAligned: story.contractAligned,
      candidateMediaReady: story.candidateMediaReady,
      localCandidateReady: story.localCandidateReady,
      claimCount: story.claimCount,
      candidateCheckCount: story.candidateCheckCount,
      failedClaims: story.failedClaims,
      failedCandidateChecks: story.failedCandidateChecks,
      openGates: story.openGates,
    },
    proofBoundary:
      'A passing source-only result proves the declared no-video file contract, not command execution. A passing full result proves current local artifact and story alignment, not continuous human playback, rights approval, a public repository or video, Devpost submission, production isolation, provider interception, TikTok access, or judge acceptance.',
  };
}

function main() {
  const mode = process.argv.includes('--source-only') ? 'source-only' : 'full';
  const result = verifyTrack1FinalReadiness({mode});
  process.stdout.write(`${JSON.stringify({generatedAt: new Date().toISOString(), ...result}, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
