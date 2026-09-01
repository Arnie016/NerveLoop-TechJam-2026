import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyFinalReadiness,
  EXPECTED_MEDIA_ONLY_PATHS,
  extractSubmissionPacket,
  parseManifestText,
  verifyTrack1FinalReadiness,
} from './verify-track1-final-readiness.mjs';

test('manifest parser rejects duplicates, traversal, and unstable ordering', () => {
  assert.throws(() => parseManifestText('b\na\n'), /sorted/u);
  assert.throws(() => parseManifestText('a\na\n'), /unique/u);
  assert.throws(() => parseManifestText('../escape\n'), /escapes root/u);
});

test('submission packet joins a wrapped tagline and preserves entrant gates', () => {
  const packet = extractSubmissionPacket(`# NerveLoop\n\n## One-line Summary\n\nHost-owned middleware\nthat blocks effects.\n\n## Official Track\n\n**Track #1: Agent Launchpad: Design and Build Lightweight Agent Middleware**\n\nTeam name and team-leader email: entrant-provided\nRegistration confirmation: entrant-confirmed\nPublic repository: current source push pending\nPublic YouTube URL: pending\nFinal Devpost submission confirmation: pending\n`);
  assert.equal(packet.title, 'NerveLoop');
  assert.equal(packet.tagline, 'Host-owned middleware that blocks effects.');
  assert.equal(packet.officialTrackPresent, true);
  assert.equal(packet.pendingEntrantFields.length, 5);
});

test('external gates remain open even when local artifact checks pass', () => {
  const result = classifyFinalReadiness({
    mode: 'full',
    closure: {exact: true},
    packet: {
      titleCharacters: 9,
      taglineCharacters: 42,
      officialTrackPresent: true,
      pendingEntrantFields: Array(5).fill('pending'),
    },
    candidate: {passed: true},
    story: {localCandidateReady: true},
  });
  assert.equal(result.passed, true);
  assert.equal(result.releaseReady, false);
  assert.deepEqual(Object.values(result.externalGates), Array(5).fill(false));
});

test('current no-video source closure is exact and self-contained by declaration', () => {
  const result = verifyTrack1FinalReadiness({mode: 'source-only'});
  assert.equal(result.passed, true);
  assert.equal(result.status, 'PUBLIC_SOURCE_CONTRACT_READY_MEDIA_EXCLUDED');
  assert.equal(result.closures.publicSource.videoFiles, 0);
  assert.deepEqual(result.closures.operational.mediaOnlyPaths, EXPECTED_MEDIA_ONLY_PATHS);
});

test('current full candidate aligns while human and external gates stay open', () => {
  const result = verifyTrack1FinalReadiness({mode: 'full'});
  assert.equal(result.passed, true);
  assert.equal(result.status, 'LOCAL_CANDIDATE_READY_EXTERNAL_GATES_OPEN');
  assert.equal(result.releaseReady, false);
  assert.equal(result.candidate.passed, true);
  assert.equal(result.story.contractAligned, true);
  assert.equal(result.story.candidateMediaReady, true);
  assert.deepEqual(result.story.openGates, [
    'human-playback-review',
    'public-youtube-upload',
    'devpost-submission-verified',
  ]);
});
