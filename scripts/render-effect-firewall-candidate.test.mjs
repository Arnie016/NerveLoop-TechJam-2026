import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  candidatePath,
  receiptPath,
  repository,
  scenes,
  stableFallbackPath,
  storyStillPath,
  validateCandidateInputs,
  verifyCandidateReceipt,
} from './render-effect-firewall-candidate.mjs';

const renderer = join(repository, 'scripts/render-effect-firewall-candidate.mjs');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function temporarySidecar(t, mutate) {
  const directory = mkdtempSync(join(tmpdir(), 'nerveloop-candidate-sidecar-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  mutate(receipt);
  const output = join(directory, 'candidate.json');
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  return output;
}

test('preflight is bounded, local, source-bound, and preserves the stable fallback', () => {
  const before = {
    sha256: hash(stableFallbackPath),
    size: statSync(stableFallbackPath).size,
    mtimeMs: statSync(stableFallbackPath).mtimeMs,
  };
  const validation = validateCandidateInputs();
  const after = {
    sha256: hash(stableFallbackPath),
    size: statSync(stableFallbackPath).size,
    mtimeMs: statSync(stableFallbackPath).mtimeMs,
  };

  assert.equal(validation.schemaVersion, 'nerveloop.effect-firewall-provenance-cleared-preflight.v1');
  assert.equal(validation.output, 'docs/demo/nerveloop-effect-firewall-candidate.mp4');
  assert.equal(validation.receipt, 'docs/demo/nerveloop-effect-firewall-candidate.json');
  assert.equal(validation.scenes, 12);
  assert.equal(validation.dimensions, '1920x1080');
  assert.equal(validation.frameRate, 24);
  assert.ok(validation.nominalDurationSeconds > 120 && validation.nominalDurationSeconds <= 175);
  assert.equal(validation.voice, 'none');
  assert.equal(validation.externalCalls, 0);
  assert.equal(validation.modelCalls, 0);
  assert.equal(validation.sourceBindings.length, 10);
  assert.deepEqual(validation.releaseAssets.storyStill, {
    path: 'docs/assets/nerveloop-effect-firewall-story.png',
    sha256: hash(storyStillPath),
    sceneId: '05-proof-surface',
    generatedBy: 'scripts/render-effect-firewall-candidate.mjs',
    imported: false,
  });
  const fontBindings = validation.sourceBindings.filter(binding =>
    binding.path.endsWith('/font8x8_basic.h'));
  assert.equal(fontBindings.length, 1);
  assert.deepEqual(
    {path: fontBindings[0].path, sha256: fontBindings[0].sha256},
    {
      path: 'research/evidence/2026-09-01-provenance-cleared-media-experiment/font8x8_basic.h',
      sha256: '49d8df366296b203ca3211bc0672cf2a762135bf12710735b6292756b19dffd5',
    },
  );
  assert.match(fontBindings[0].role, /bitmap font/i);
  assert.deepEqual(validation.observedEvidence, {
    functionalVerdict: 'PASS',
    benchmarkRounds: 6,
    adversarialVerdict: 'PASS',
  });
  assert.deepEqual(after, before);
});

test('candidate and source-bound sidecar verify against fresh media samples', () => {
  const result = verifyCandidateReceipt();

  assert.equal(result.passed, true);
  assert.equal(result.videoSha256, hash(candidatePath));
  assert.equal(result.dimensions, '1920x1080');
  assert.equal(result.videoCodec, 'h264');
  assert.equal(result.audioCodec, 'aac');
  assert.ok(result.durationSeconds > 120 && result.durationSeconds <= 175);
  assert.equal(result.sourceBindings, 10);
  assert.equal(result.sampleFrames, 7);
  assert.equal(result.stableFallbackUnchanged, true);
  assert.equal(result.proofBoundary.demoRunnerModeRequired, true);
  assert.equal(result.proofBoundary.modelCalls, 0);
  assert.equal(result.proofBoundary.providerCalls, 0);
  assert.equal(result.proofBoundary.publicUploadClaim, false);
  assert.equal(result.proofBoundary.devpostSubmissionClaim, false);
});

test('sidecar binds the exact demonstrated sequence and boundary', () => {
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));

  assert.equal(receipt.schemaVersion, 'nerveloop.effect-firewall-provenance-cleared-candidate.v1');
  assert.equal(receipt.kind, 'local-source-bound-procedural-effect-firewall-candidate');
  assert.equal(receipt.rendering.importedScreenshots, 0);
  assert.equal(receipt.rendering.importedImages, 0);
  assert.equal(receipt.rendering.systemFontResolution, false);
  assert.deepEqual(receipt.rendering.bitmapFont, {
    path: 'research/evidence/2026-09-01-provenance-cleared-media-experiment/font8x8_basic.h',
    sha256: '49d8df366296b203ca3211bc0672cf2a762135bf12710735b6292756b19dffd5',
    upstreamCommit: '8e279d2d864e79128e96188a6b9526cfa3fbfef9',
    upstreamDeclaration: 'Public Domain',
    declarationIndependentlyAdjudicated: false,
  });
  assert.deepEqual(receipt.releaseAssets.storyStill, {
    path: 'docs/assets/nerveloop-effect-firewall-story.png',
    sha256: hash(storyStillPath),
    sceneId: '05-proof-surface',
    generatedBy: 'scripts/render-effect-firewall-candidate.mjs',
    imported: false,
  });
  assert.equal(receipt.observedClaims.enforcementMode, 'DEMO_RUNNER=1 fixed local fixture path');
  assert.equal(receipt.observedClaims.typedIncident, 'delete_mock_asset / protected');
  assert.match(receipt.observedClaims.preDispatchReceipt, /workerSpawned false/);
  assert.match(receipt.observedClaims.preDispatchReceipt, /changedFiles \[\]/);
  assert.match(receipt.observedClaims.preDispatchReceipt, /recovery not_needed/);
  assert.match(receipt.observedClaims.preDispatchReceipt, /before manifest equals after manifest/);
  assert.match(receipt.observedClaims.sameAgentContinuity, /later safe fixture completed and was retained/);
  assert.match(receipt.observedClaims.sinkLifecycle, /normal committed/);
  assert.match(receipt.observedClaims.sinkLifecycle, /malicious unredeemed grant revoked EFFECT_SINK_CLOSED/);
  assert.match(receipt.observedClaims.sinkLifecycle, /no opaque grant persisted/);
  assert.match(receipt.observedClaims.defenseInDepth, /raw ambient-filesystem bypass/);
  assert.match(receipt.observedClaims.defenseInDepth, /raw ambient-filesystem bypass fixture dispatched/);
  assert.match(receipt.observedClaims.benchmark, /32\/0\/1/);
  assert.match(receipt.observedClaims.adversarial, /20 lattice cells/);
  assert.deepEqual(receipt.scenes.map(scene => scene.id), scenes.map(scene => scene.id));
});

test('tampered candidate video hash is rejected before acceptance', t => {
  const sidecarPath = temporarySidecar(t, receipt => {
    receipt.video.sha256 = '0'.repeat(64);
  });

  assert.throws(
    () => verifyCandidateReceipt({root: repository, videoPath: candidatePath, sidecarPath}),
    /candidate video hash mismatch/,
  );
});

test('stale or tampered source binding is rejected', t => {
  const sidecarPath = temporarySidecar(t, receipt => {
    receipt.sourceBindings[0].sha256 = 'f'.repeat(64);
  });

  assert.throws(
    () => verifyCandidateReceipt({root: repository, videoPath: candidatePath, sidecarPath}),
    /candidate source binding is stale or tampered/,
  );
});

test('tampered decoded sample receipt is rejected', t => {
  const sidecarPath = temporarySidecar(t, receipt => {
    receipt.sampleFrames[0].sha256 = 'a'.repeat(64);
  });

  assert.throws(
    () => verifyCandidateReceipt({root: repository, videoPath: candidatePath, sidecarPath}),
    /candidate sample frames are stale or tampered/,
  );
});

test('renderer has no network, provider, voice, Swift, or ImageMagick route', () => {
  const source = readFileSync(renderer, 'utf8');

  assert.doesNotMatch(source, /from ['"]node:(?:http|https|net|tls|dgram)['"]/);
  assert.doesNotMatch(source, /\bfetch\s*\(|api\.openai\.com|['"]curl['"]/);
  assert.doesNotMatch(source, /\/usr\/bin\/say|\/usr\/bin\/swift|['"](?:magick|convert)['"]/);
  assert.doesNotMatch(source, /proofScreenshot|scene\.asset/);
  assert.match(source, /procedural Node PNG plates/);
  assert.match(source, /font8x8_basic\.h/);
  assert.match(source, /importedScreenshots:\s*0/);
  assert.match(source, /systemFontResolution:\s*false/);
  assert.match(source, /externalCalls: 0/);
  assert.match(source, /modelCalls: 0/);
});

test('CLI verify-only emits the same bounded verification contract', () => {
  const result = spawnSync(process.execPath, [renderer, '--verify-only'], {
    cwd: repository,
    encoding: 'utf8',
    timeout: 120_000,
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  const verification = JSON.parse(result.stdout);
  assert.equal(verification.passed, true);
  assert.equal(verification.videoSha256, hash(candidatePath));
  assert.equal(verification.dimensions, '1920x1080');
  assert.equal(verification.stableFallbackUnchanged, true);
});
