import {createHash} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyCandidateReceipt} from './render-effect-firewall-candidate.mjs';

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const hashText = value => createHash('sha256').update(value).digest('hex');

export const SELECTED_TRACK =
  'Track #1: Agent Launchpad: Design and Build Lightweight Agent Middleware';
export const STABLE_VIDEO_SHA256 =
  'ed34f33a709719569806e21fdc738cca7b6e9c3a5aeda00860e84f1e6ecca2c7';
export const CANDIDATE_VIDEO_SHA256 =
  '1884b05ad3e8350c8e4b0aa8322d1b47388f1ff9392f7be985cc73467b8df36e';
export const CANDIDATE_SIDECAR_SHA256 =
  'e27856e8720b060a7b197efde3be9553e1c5088ce5fb27714178a38f833d5a92';
export const STORY_STILL_SHA256 =
  'cec5fa4530663bda917ea4cf79ffeb027f501ff3c7de77a5ea8507a550983847';
export const CANDIDATE_SIDECAR_SCHEMA =
  'nerveloop.effect-firewall-provenance-cleared-candidate.v1';
export const CANDIDATE_SIDECAR_KIND =
  'local-source-bound-procedural-effect-firewall-candidate';
export const CANDIDATE_PREFLIGHT_SCHEMA =
  'nerveloop.effect-firewall-provenance-cleared-preflight.v1';
export const BITMAP_FONT_PATH =
  'research/evidence/2026-09-01-provenance-cleared-media-experiment/font8x8_basic.h';
export const BITMAP_FONT_SHA256 =
  '49d8df366296b203ca3211bc0672cf2a762135bf12710735b6292756b19dffd5';
export const BITMAP_FONT_UPSTREAM_COMMIT =
  '8e279d2d864e79128e96188a6b9526cfa3fbfef9';
export const FUNCTIONAL_RECEIPT_SHA256 =
  'b0f6f2a84a02210ca26f85afc6c8c6e67d03a5fc5afd6dd4fba4183b4573bfc5';
export const BENCHMARK_SHA256 =
  '5ecebd210ced6a7752fcbc7fff815ba3a1bb1260417ddc1158550567c9a8ac24';
export const FIXTURE_RUNNER_SHA256 =
  '2cff0b18be2803bffde2835d74362ffcbff401beff51414b5e3ac5dd73113813';
export const EFFECT_CAPABILITY_SHA256 =
  '31c6e3c98782015c4a412da0368bb1de0cd7ffcee0b8e55ffeba14eb17504164';
export const AGENT_SERVICE_SHA256 =
  '39276855c84da2a961d799230b61edaee9726ff4d7112d273bb6c2262f08de32';
export const EFFECT_SINK_SHA256 =
  'dee279b9629134c001a169953c205b97b5b1b2cd30e3b4bcf2774c8feef946ac';

function regularFile(path) {
  if (!existsSync(path)) throw new Error(`Missing judge-story source: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Judge-story source must be a regular file: ${path}`);
  }
  return path;
}

export function loadJudgeStoryDocuments({repository}) {
  const paths = {
    readme: join(repository, 'README.md'),
    devpost: join(repository, 'devpost-submission.md'),
    playbook: join(repository, 'docs/judge/VERA-JUDGE-PLAYBOOK.md'),
    architecture: join(repository, 'docs/judge/NERVELOOP-REFLEX-ARCHITECTURE.md'),
    opening: join(repository, 'docs/demo/track-c-opening.json'),
    candidateVideo: join(repository, 'docs/demo/nerveloop-effect-firewall-candidate.mp4'),
    candidateSidecar: join(repository, 'docs/demo/nerveloop-effect-firewall-candidate.json'),
    storyStill: join(repository, 'docs/assets/nerveloop-effect-firewall-story.png'),
    effectCapabilitySource: join(repository, 'apps/server/src/effect-capability.ts'),
    effectSinkSource: join(repository, 'apps/server/src/effect-sink.ts'),
    agentServiceSource: join(repository, 'apps/server/src/agent-service.ts'),
    agentServiceTest: join(repository, 'apps/server/src/agent-service.test.ts'),
    fixtureRunnerSource: join(repository, 'apps/server/src/fixture-runner.ts'),
    storyboard: join(repository, 'docs/demo/submission-storyboard.json'),
    stableVideo: join(repository, 'docs/demo/nerveloop-submission-draft.mp4'),
    functionalReceipt: join(
      repository,
      'research/evidence/2026-09-01-track-c-functional-flow/current.json',
    ),
    benchmark: join(
      repository,
      'research/evidence/2026-09-01-track-c-condition-benchmark/results.json',
    ),
  };
  for (const path of Object.values(paths)) regularFile(path);
  const candidateSidecar = JSON.parse(readFileSync(paths.candidateSidecar, 'utf8'));
  return {
    repository,
    paths,
    readme: readFileSync(paths.readme, 'utf8'),
    devpost: readFileSync(paths.devpost, 'utf8'),
    playbook: readFileSync(paths.playbook, 'utf8'),
    architecture: readFileSync(paths.architecture, 'utf8'),
    opening: JSON.parse(readFileSync(paths.opening, 'utf8')),
    candidateSidecar,
    candidateSidecarObjectSha256: hashText(JSON.stringify(candidateSidecar)),
    effectCapabilitySource: readFileSync(paths.effectCapabilitySource, 'utf8'),
    effectSinkSource: readFileSync(paths.effectSinkSource, 'utf8'),
    agentServiceSource: readFileSync(paths.agentServiceSource, 'utf8'),
    agentServiceTest: readFileSync(paths.agentServiceTest, 'utf8'),
    storyboard: JSON.parse(readFileSync(paths.storyboard, 'utf8')),
    functionalReceipt: JSON.parse(readFileSync(paths.functionalReceipt, 'utf8')),
    benchmark: JSON.parse(readFileSync(paths.benchmark, 'utf8')),
  };
}

const normalize = text => text
  .replace(/^>\s?/gm, '')
  .replace(/[`*]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const has = (text, ...patterns) => {
  const normalized = normalize(text);
  return patterns.every(pattern => pattern.test(normalized));
};

const orderedFragments = (text, fragments) => {
  let cursor = 0;
  for (const fragment of fragments) {
    const next = text.indexOf(fragment, cursor);
    if (next === -1) return false;
    cursor = next + fragment.length;
  }
  return true;
};

const documentSources = documents => ({
  readme: documents.readme,
  devpost: documents.devpost,
  playbook: documents.playbook,
  architecture: documents.architecture,
});

const mapDocumentCheck = (documents, check) => Object.fromEntries(
  Object.entries(documentSources(documents)).map(([name, text]) => [name, check(text)]),
);

function claim(id, sourceChecks) {
  return {
    id,
    passed: Object.values(sourceChecks).every(Boolean),
    sources: sourceChecks,
  };
}

const hasExactTrack = text => text.includes(SELECTED_TRACK);

const hasScenarioBoundary = text => has(
  text,
  /The Kill Switch/i,
  /scenario/i,
  /not (?:the )?(?:official )?track (?:name|label)|not an official track/i,
);

const hasTypedPreDispatchDenial = text => has(
  text,
  /Effect Firewall/i,
  /delete_mock_asset/i,
  /\bprotected\b/i,
  /pre-dispatch|before (?:runner|worker|dispatch|execution)|before [^.]{0,80}dispatch/i,
  /den(?:y|ied|ial)/i,
);

const hasZeroDispatchUnchangedProof = text => has(
  text,
  /workerSpawned\s*:?\s*false/i,
  /(?:worker )?dispatch(?: delta)?\s*(?:is|=|:)?\s*(?:zero|0)|zero (?:worker )?dispatch/i,
  /manifest[^.]{0,120}(?:unchanged|match|equal|==)|before[- ]manifest[^.]{0,100}after[- ]manifest/i,
  /recovery\s*:?\s*not_needed/i,
);

const hasSameAgentContinuation = text => has(
  text,
  /same[- ]Agent/i,
  /later safe Run/i,
  /retain(?:ed|s|ing)|complete(?:d|s)/i,
);

const hasRunGuardBackstop = text => has(
  text,
  /RunGuard/i,
  /second (?:line|layer)|backstop|defen[cs]e in depth/i,
  /post[- ](?:run|dispatch|execution)|after execution|admitted (?:fault|work)/i,
  /roll(?:ed)?[ -]?back|restore(?:d|s|ing)/i,
);

function orderedTokensNear(text, labelPattern, tokens, window = 260) {
  const normalized = normalize(text);
  const match = labelPattern.exec(normalized);
  if (!match) return false;
  const nearby = normalized.slice(match.index, match.index + window);
  let cursor = 0;
  for (const token of tokens) {
    const index = nearby.indexOf(token, cursor);
    if (index === -1) return false;
    cursor = index + token.length;
  }
  return true;
}

const hasBenchmarkSubstance = text => {
  const normalized = normalize(text);
  return (
    /\b(?:six|6)\b[^.]{0,60}\brounds?\b|\b(?:six|6)[- ]round/i.test(normalized) &&
    orderedTokensNear(normalized, /(?:threat )?detect(?:ion|ed)/i, ['0%', '100%', '100%']) &&
    orderedTokensNear(normalized, /threat (?:worker )?dispatch/i, ['100%', '0%', '100%']) &&
    orderedTokensNear(normalized, /logical recovery targets?/i, ['32', '0', '1']) &&
    orderedTokensNear(normalized, /stale escapes/i, ['0'])
  );
};

const negatesTerm = (text, termPattern) => normalize(text)
  .split(/[.!?](?:\s|$)/)
  .some(sentence =>
    termPattern.test(sentence) &&
    /\b(?:no|not|nothing|without|never|unproved|unsupported)\b|does not|not supported/i.test(sentence));

const hasClaimBoundaries = text =>
  negatesTerm(text, /model[- ]backed|provider model|model[- ]quality|model response|no[- ]model/i) &&
  negatesTerm(text, /hardened sandbox|kernel isolation|microVM|production[- ]security/i) &&
  negatesTerm(text, /TikTok/i) &&
  negatesTerm(text, /performance|latency|speed|compute|energy|GPU|cost/i);

const hasStableFallbackBoundary = text => has(
  text,
  /159[- ]second/i,
  /stable/i,
  /fallback/i,
  /predate|older|stale|does not reflect|not (?:the )?(?:new|current|final)/i,
);

const exactArray = (actual, expected) =>
  Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);

function receiptHasExpectedIdentity(receipt) {
  return receipt.schemaVersion === 'nerveloop.track-c-functional-flow.v3' &&
    receipt.track === SELECTED_TRACK && receipt.verdict === 'PASS';
}

function receiptProvesEffectSink(receipt, paths) {
  const normal = receipt.sequence?.normalRun?.effectSinkReceipt;
  const denial = receipt.sequence?.effectFirewallDeniedRun;
  const malicious = receipt.sequence?.postRunMaliciousRun?.effectSinkReceipt;
  const laterSafe = receipt.sequence?.laterFreshSafeRun?.effectSinkReceipt;
  const noGrant = sink => sink && !Object.hasOwn(sink, 'grant');
  return receiptHasExpectedIdentity(receipt) &&
    normal?.state === 'committed' && normal?.relativePath === 'demo-result.md' &&
    denial?.effectCapability === null && denial?.effectSinkReceipt === null &&
    malicious?.state === 'revoked' && malicious?.closeDisposition === 'unredeemed' &&
    malicious?.errorCode === 'EFFECT_SINK_CLOSED' && malicious?.committedAt === null &&
    laterSafe?.state === 'committed' && laterSafe?.relativePath === 'demo-result.md' &&
    [normal, malicious, laterSafe].every(noGrant) &&
    receipt.proofBoundary?.cooperativeFixtureSinkMediation === true &&
    receipt.proofBoundary?.ambientFilesystemAuthorityRemoved === false &&
    receipt.implementation?.sourceSha256?.effectSink === EFFECT_SINK_SHA256 &&
    hash(paths.effectSinkSource) === EFFECT_SINK_SHA256;
}

function receiptProvesTypedDenial(receipt) {
  const denial = receipt.sequence?.effectFirewallDeniedRun;
  return receiptHasExpectedIdentity(receipt) &&
    denial?.effectDecision?.policy === 'effect-firewall-v1' &&
    denial?.effectDecision?.action === 'delete_mock_asset' &&
    denial?.effectDecision?.targetClass === 'protected' &&
    denial?.effectDecision?.verdict === 'denied';
}

function receiptProvesZeroDispatch(receipt) {
  const denial = receipt.sequence?.effectFirewallDeniedRun;
  const protectedState = receipt.sequence?.protectedState;
  return receiptHasExpectedIdentity(receipt) &&
    denial?.effectDecision?.workerSpawned === false &&
    denial?.workerDispatchDelta === 0 &&
    denial?.changedFiles?.length === 0 &&
    denial?.beforeManifestDigest === denial?.afterManifestDigest &&
    denial?.recovery === 'not_needed' &&
    protectedState?.bytesIdenticalAfterEffectDenial === true;
}

function receiptProvesSameAgentContinuation(receipt) {
  const normal = receipt.sequence?.normalRun;
  const laterSafe = receipt.sequence?.laterFreshSafeRun;
  return receiptHasExpectedIdentity(receipt) &&
    receipt.implementation?.sameAgentSequence === true &&
    normal?.guardVerdict === 'retained' &&
    laterSafe?.guardVerdict === 'retained' &&
    laterSafe?.status === 'completed';
}

function receiptProvesRunGuardBackstop(receipt) {
  const rollback = receipt.sequence?.postRunMaliciousRun;
  return receiptHasExpectedIdentity(receipt) &&
    rollback?.workerDispatchDelta === 1 &&
    rollback?.recovery === 'rolled_back' &&
    receipt.sequence?.boundedRollbackCleanup?.checkpointRestored === true;
}

function receiptProvesBoundaries(receipt) {
  return receiptHasExpectedIdentity(receipt) &&
    receipt.proofBoundary?.modelExecuted === false &&
    receipt.proofBoundary?.hardenedSandbox === false &&
    receipt.proofBoundary?.productionIsolation === false &&
    receipt.proofBoundary?.tiktokAccess === false;
}

function receiptProvesEffectCapabilities(receipt, paths) {
  const normal = receipt.sequence?.normalRun;
  const rollback = receipt.sequence?.postRunMaliciousRun;
  const laterSafe = receipt.sequence?.laterFreshSafeRun;
  const denial = receipt.sequence?.effectFirewallDeniedRun;
  const allowedRuns = [normal, rollback, laterSafe];
  const capabilities = allowedRuns.map(run => run?.effectCapability);
  const validCapability = (run, capability) => {
    const issuedAt = Date.parse(capability?.issuedAt ?? '');
    const claimedAt = Date.parse(capability?.claimedAt ?? '');
    const consumedAt = Date.parse(capability?.consumedAt ?? '');
    const expiresAt = Date.parse(capability?.expiresAt ?? '');
    return capability?.version === 1 &&
      capability?.registry === 'process-local' &&
      capability?.state === 'consumed' &&
      capability?.runId === run?.runId &&
      typeof capability?.agentId === 'string' && capability.agentId.length > 0 &&
      capability?.action === 'write_demo_result' &&
      capability?.targetClass === 'workspace' &&
      capability?.policy === 'effect-firewall-v1' &&
      capability?.policyVersion === 1 &&
      /^[a-f0-9]{64}$/.test(capability?.policyDigest ?? '') &&
      capability?.useBudget === 1 && capability?.usesClaimed === 1 &&
      Number.isFinite(issuedAt) && issuedAt <= claimedAt && claimedAt <= consumedAt &&
      consumedAt < expiresAt && expiresAt - issuedAt === 5_000 &&
      /not authentication, durable authority, provider interception, or kernel isolation/i
        .test(capability?.boundary ?? '');
  };
  const sourceHashes = receipt.implementation?.sourceSha256 ?? {};
  return receiptHasExpectedIdentity(receipt) &&
    allowedRuns.every((run, index) => validCapability(run, capabilities[index])) &&
    new Set(allowedRuns.map(run => run.runId)).size === 3 &&
    new Set(capabilities.map(capability => capability.grantId)).size === 3 &&
    new Set(capabilities.map(capability => capability.agentId)).size === 1 &&
    new Set(capabilities.map(capability => capability.policyDigest)).size === 1 &&
    denial?.effectCapability === null &&
    sourceHashes.effectCapability === EFFECT_CAPABILITY_SHA256 &&
    sourceHashes.agentService === AGENT_SERVICE_SHA256 &&
    sourceHashes.fixtureRunner === FIXTURE_RUNNER_SHA256 &&
    hash(paths.effectCapabilitySource) === EFFECT_CAPABILITY_SHA256 &&
    hash(paths.agentServiceSource) === AGENT_SERVICE_SHA256 &&
    hash(paths.fixtureRunnerSource) === FIXTURE_RUNNER_SHA256;
}

function benchmarkProvesThreeConditions(benchmark) {
  const baseline = benchmark.conditions?.resetAllBaseline;
  const effect = benchmark.conditions?.effectFirewall;
  const rollback = benchmark.conditions?.runGuardRollback;
  return (
    benchmark.schemaVersion === 3 &&
    benchmark.status === 'COMPLETE' &&
    benchmark.selectedTrack === SELECTED_TRACK &&
    benchmark.configuration?.rounds === 6 &&
    baseline?.threatDetectionRate?.value === 0 &&
    effect?.threatDetectionRate?.value === 1 &&
    rollback?.threatDetectionRate?.value === 1 &&
    baseline?.threatWorkerDispatchRate?.value === 1 &&
    effect?.threatWorkerDispatchRate?.value === 0 &&
    rollback?.threatWorkerDispatchRate?.value === 1 &&
    baseline?.threatLogicalRecoveryTargets?.value?.p50 === 32 &&
    effect?.threatLogicalRecoveryTargets?.value?.p50 === 0 &&
    rollback?.threatLogicalRecoveryTargets?.value?.p50 === 1 &&
    baseline?.staleEscapeCount?.value === 0 &&
    effect?.staleEscapeCount?.value === 0 &&
    rollback?.staleEscapeCount?.value === 0 &&
    benchmark.proofBoundary?.modelCalls === 0 &&
    benchmark.proofBoundary?.latencyControlled === false
  );
}

const EXPECTED_CANDIDATE_SCENES = [
  '01-incident',
  '02-principle',
  '03-typed-proposal',
  '04-monotone-gate',
  '05-proof-surface',
  '06-later-safe',
  '07-runguard',
  '08-architecture',
  '09-six-round-kpi',
  '10-adversarial',
  '11-boundary',
  '12-close',
];

export function validateCandidateMachine({repository, paths}) {
  try {
    return {
      ...verifyCandidateReceipt({
        root: repository,
        videoPath: paths.candidateVideo,
        sidecarPath: paths.candidateSidecar,
      }),
      error: null,
    };
  } catch (error) {
    return {
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function candidateSourceBindingsCurrent({repository, candidateSidecar}) {
  if (!Array.isArray(candidateSidecar.sourceBindings) || candidateSidecar.sourceBindings.length !== 10) {
    return false;
  }
  const everyBindingCurrent = candidateSidecar.sourceBindings.every(binding => {
    if (!binding || typeof binding.path !== 'string' || !/^[a-f0-9]{64}$/.test(binding.sha256 ?? '')) {
      return false;
    }
    const source = resolve(repository, binding.path);
    const local = relative(repository, source);
    if (local.startsWith('..') || resolve(repository, local) !== source) return false;
    try {
      regularFile(source);
      return hash(source) === binding.sha256;
    } catch {
      return false;
    }
  });
  const bitmapFont = candidateSidecar.sourceBindings.find(binding => binding.path === BITMAP_FONT_PATH);
  return everyBindingCurrent && bitmapFont?.sha256 === BITMAP_FONT_SHA256;
}

function candidateDemonstratesCurrentStory(candidateSidecar) {
  const claims = candidateSidecar.observedClaims ?? {};
  return exactArray(candidateSidecar.scenes?.map(scene => scene.id), EXPECTED_CANDIDATE_SCENES) &&
    claims.enforcementMode === 'DEMO_RUNNER=1 fixed local fixture path' &&
    claims.typedIncident === 'delete_mock_asset / protected' &&
    /workerSpawned false/i.test(claims.preDispatchReceipt ?? '') &&
    /changedFiles \[\]/i.test(claims.preDispatchReceipt ?? '') &&
    /recovery not_needed/i.test(claims.preDispatchReceipt ?? '') &&
    /before manifest equals after manifest/i.test(claims.preDispatchReceipt ?? '') &&
    /later safe fixture completed and was retained/i.test(claims.sameAgentContinuity ?? '') &&
    /raw ambient-filesystem bypass fixture dispatched/i.test(claims.defenseInDepth ?? '') &&
    /rolled back/i.test(claims.defenseInDepth ?? '') &&
    /normal committed/i.test(claims.sinkLifecycle ?? '') &&
    /malicious unredeemed grant revoked EFFECT_SINK_CLOSED/i.test(claims.sinkLifecycle ?? '') &&
    /no opaque grant persisted/i.test(claims.sinkLifecycle ?? '') &&
    /raw ambient-filesystem bypass/i.test(claims.defenseInDepth ?? '') &&
    /six local rounds/i.test(claims.benchmark ?? '') &&
    /32\/0\/1/.test(claims.benchmark ?? '');
}

function candidatePreservesProofBoundary(candidateSidecar) {
  const boundary = candidateSidecar.proofBoundary ?? {};
  return boundary.localOnly === true &&
    boundary.deterministicFixture === true &&
    boundary.demoRunnerModeRequired === true &&
    boundary.modelCalls === 0 &&
    boundary.providerCalls === 0 &&
    boundary.hardenedSandboxClaim === false &&
    boundary.ambientFilesystemAuthorityRemovedClaim === false &&
    boundary.productionSecurityClaim === false &&
    boundary.tiktokAccessClaim === false &&
    boundary.publicUploadClaim === false &&
    boundary.devpostSubmissionClaim === false &&
    candidateSidecar.rendering?.voice === 'none' &&
    candidateSidecar.rendering?.realPersonVoice === false;
}

function candidateSidecarMatchesOpening({candidateSidecar, opening, paths}) {
  const candidate = opening.candidate ?? {};
  return opening.schemaVersion === 3 &&
    opening.contract === 'nerveloop-track-1-effect-firewall-candidate-v3' &&
    opening.artifactRole === 'source-bound-local-candidate-contract' &&
    candidate.video === 'docs/demo/nerveloop-effect-firewall-candidate.mp4' &&
    candidate.videoSha256 === CANDIDATE_VIDEO_SHA256 &&
    candidate.sidecar === 'docs/demo/nerveloop-effect-firewall-candidate.json' &&
    candidate.sidecarSha256 === CANDIDATE_SIDECAR_SHA256 &&
    candidate.sidecarSchema === CANDIDATE_SIDECAR_SCHEMA &&
    candidate.sidecarKind === CANDIDATE_SIDECAR_KIND &&
    candidate.preflightSchema === CANDIDATE_PREFLIGHT_SCHEMA &&
    candidate.durationSeconds === 139.875 &&
    candidate.maximumDurationSeconds === 180 &&
    candidate.videoCodec === 'h264' && candidate.pixelFormat === 'yuv420p' &&
    candidate.frameRate === '24/1' && candidate.audioCodec === 'aac' &&
    candidate.audioSampleRate === 48000 && candidate.audioChannels === 2 &&
    candidate.width === 1920 && candidate.height === 1080 &&
    candidate.sourceBindingCount === 10 && candidate.sampleFrameCount === 7 &&
    candidate.releaseAssets?.storyStill?.path === 'docs/assets/nerveloop-effect-firewall-story.png' &&
    candidate.releaseAssets?.storyStill?.sha256 === STORY_STILL_SHA256 &&
    candidate.releaseAssets?.storyStill?.sceneId === '05-proof-surface' &&
    candidate.releaseAssets?.storyStill?.generatedBy ===
      'scripts/render-effect-firewall-candidate.mjs --write-story-still' &&
    candidate.releaseAssets?.storyStill?.imported === false &&
    candidate.renderingProvenance?.importedScreenshots === 0 &&
    candidate.renderingProvenance?.importedImages === 0 &&
    candidate.renderingProvenance?.systemFontResolution === false &&
    candidate.renderingProvenance?.bitmapFont?.path === BITMAP_FONT_PATH &&
    candidate.renderingProvenance?.bitmapFont?.sha256 === BITMAP_FONT_SHA256 &&
    candidate.renderingProvenance?.bitmapFont?.upstream === 'https://github.com/dhepper/font8x8' &&
    candidate.renderingProvenance?.bitmapFont?.upstreamCommit === BITMAP_FONT_UPSTREAM_COMMIT &&
    candidate.renderingProvenance?.bitmapFont?.upstreamDeclaration === 'Public Domain' &&
    candidate.renderingProvenance?.bitmapFont?.declarationIndependentlyAdjudicated === false &&
    exactArray(candidate.sceneIds, EXPECTED_CANDIDATE_SCENES) &&
    candidate.voice === 'none' && candidate.publicUploadClaimed === false &&
    candidate.evidenceBindings?.functionalReceiptSha256 === FUNCTIONAL_RECEIPT_SHA256 &&
    candidate.evidenceBindings?.benchmarkSha256 === BENCHMARK_SHA256 &&
    candidate.evidenceBindings?.fixtureRunnerSha256 === FIXTURE_RUNNER_SHA256 &&
    candidateSidecar.schemaVersion === candidate.sidecarSchema &&
    candidateSidecar.kind === candidate.sidecarKind &&
    candidateSidecar.officialTrack === SELECTED_TRACK &&
    candidateSidecar.video?.path === candidate.video &&
    candidateSidecar.video?.sha256 === candidate.videoSha256 &&
    candidateSidecar.media?.durationSeconds === candidate.durationSeconds &&
    candidateSidecar.media?.video?.codec === candidate.videoCodec &&
    candidateSidecar.media?.video?.pixelFormat === candidate.pixelFormat &&
    candidateSidecar.media?.video?.frameRate === candidate.frameRate &&
    candidateSidecar.media?.audio?.codec === candidate.audioCodec &&
    candidateSidecar.media?.audio?.sampleRate === candidate.audioSampleRate &&
    candidateSidecar.media?.audio?.channels === candidate.audioChannels &&
    candidateSidecar.media?.video?.width === candidate.width &&
    candidateSidecar.media?.video?.height === candidate.height &&
    candidateSidecar.rendering?.importedScreenshots === 0 &&
    candidateSidecar.rendering?.importedImages === 0 &&
    candidateSidecar.rendering?.systemFontResolution === false &&
    candidateSidecar.rendering?.bitmapFont?.path === BITMAP_FONT_PATH &&
    candidateSidecar.rendering?.bitmapFont?.sha256 === BITMAP_FONT_SHA256 &&
    candidateSidecar.rendering?.bitmapFont?.upstreamCommit === BITMAP_FONT_UPSTREAM_COMMIT &&
    candidateSidecar.rendering?.bitmapFont?.upstreamDeclaration === 'Public Domain' &&
    candidateSidecar.rendering?.bitmapFont?.declarationIndependentlyAdjudicated === false &&
    candidateSidecar.releaseAssets?.storyStill?.path === candidate.releaseAssets.storyStill.path &&
    candidateSidecar.releaseAssets?.storyStill?.sha256 === candidate.releaseAssets.storyStill.sha256 &&
    candidateSidecar.releaseAssets?.storyStill?.sceneId === candidate.releaseAssets.storyStill.sceneId &&
    candidateSidecar.releaseAssets?.storyStill?.generatedBy ===
      'scripts/render-effect-firewall-candidate.mjs' &&
    candidateSidecar.releaseAssets?.storyStill?.imported === false &&
    candidateSidecar.storyContractSha256 === candidate.storyContractSha256 &&
    hash(paths.candidateVideo) === candidate.videoSha256 &&
    hash(paths.candidateSidecar) === candidate.sidecarSha256 &&
    hash(paths.storyStill) === candidate.releaseAssets.storyStill.sha256 &&
    hash(paths.functionalReceipt) === candidate.evidenceBindings.functionalReceiptSha256 &&
    hash(paths.benchmark) === candidate.evidenceBindings.benchmarkSha256 &&
    hash(paths.fixtureRunnerSource) === candidate.evidenceBindings.fixtureRunnerSha256;
}

export function evaluateJudgeStoryDocuments(documents) {
  const {opening, candidateSidecar, storyboard, functionalReceipt, benchmark} = documents;
  const candidateMachineValidation = documents.candidateMachineValidation ??
    validateCandidateMachine({repository: documents.repository, paths: documents.paths});
  const totalSeconds = storyboard.scenes?.reduce((sum, scene) => sum + scene.duration, 0);
  const storyboardText = JSON.stringify(storyboard);
  const stableVideoSha256 = hash(documents.paths.stableVideo);
  const openingSequence = JSON.stringify(opening.requiredDemoSequence ?? []);
  const boundaryText = JSON.stringify(opening.proofBoundary ?? {});
  const candidateSourceCurrent = candidateSourceBindingsCurrent(documents);

  const claims = [
    claim('official-track-and-scenario', {
      ...mapDocumentCheck(documents, text => hasExactTrack(text) && hasScenarioBoundary(text)),
      opening: opening.selectedTrack === SELECTED_TRACK &&
        opening.scenario?.name === 'The Kill Switch' &&
        opening.scenario?.officialTrackLabel === false,
      receipt: functionalReceipt.track === SELECTED_TRACK,
      benchmark: benchmark.selectedTrack === SELECTED_TRACK,
    }),
    claim('typed-pre-dispatch-denial', {
      ...mapDocumentCheck(documents, hasTypedPreDispatchDenial),
      opening: opening.typedProposal?.action === 'delete_mock_asset' &&
        opening.typedProposal?.targetClass === 'protected' &&
        opening.typedProposal?.policy === 'effect-firewall-v1' &&
        opening.typedProposal?.expectedVerdict === 'denied' &&
        /pre-dispatch/i.test(openingSequence),
      receipt: receiptProvesTypedDenial(functionalReceipt),
    }),
    claim('zero-dispatch-unchanged-baseline', {
      ...mapDocumentCheck(documents, hasZeroDispatchUnchangedProof),
      opening: /workerSpawned is false/i.test(openingSequence) &&
        /dispatch delta is zero/i.test(openingSequence) &&
        /manifests match/i.test(openingSequence) &&
        /recovery is not_needed/i.test(openingSequence),
      receipt: receiptProvesZeroDispatch(functionalReceipt),
    }),
    claim('same-agent-safe-continuation', {
      ...mapDocumentCheck(documents, hasSameAgentContinuation),
      opening: /same Agent completes and retains a later safe Run/i.test(openingSequence),
      receipt: receiptProvesSameAgentContinuation(functionalReceipt),
    }),
    claim('runguard-separate-backstop', {
      ...mapDocumentCheck(documents, hasRunGuardBackstop),
      opening: /separate admitted fault/i.test(openingSequence) &&
        /RunGuard/i.test(openingSequence) && /rolls the bounded checkpoint back/i.test(openingSequence),
      receipt: receiptProvesRunGuardBackstop(functionalReceipt),
    }),
    claim('three-condition-kpi', {
      ...mapDocumentCheck(documents, hasBenchmarkSubstance),
      opening: opening.benchmarkContract?.rounds === 6 &&
        exactArray(opening.benchmarkContract?.threatDetectionPercent, [0, 100, 100]) &&
        exactArray(opening.benchmarkContract?.threatWorkerDispatchPercent, [100, 0, 100]) &&
        exactArray(opening.benchmarkContract?.logicalRecoveryTargetsP50, [32, 0, 1]) &&
        exactArray(opening.benchmarkContract?.staleEscapes, [0, 0, 0]) &&
        opening.benchmarkContract?.latencyClaimedAsPerformanceImprovement === false,
      benchmark: benchmarkProvesThreeConditions(benchmark),
      fixtureRunner: functionalReceipt.implementation?.sourceSha256?.fixtureRunner ===
          FIXTURE_RUNNER_SHA256 &&
        hash(documents.paths.fixtureRunnerSource) === FIXTURE_RUNNER_SHA256,
    }),
    claim('proof-boundaries', {
      ...mapDocumentCheck(documents, hasClaimBoundaries),
      opening: /TikTok repository, data, API, or production access/i.test(boundaryText) &&
        /model-backed safety or model quality/i.test(boundaryText) &&
        /hardened sandbox/i.test(boundaryText) &&
        /OS confinement/i.test(boundaryText) &&
        /ambient filesystem authority/i.test(boundaryText) &&
        /latency performance/i.test(boundaryText) &&
        /voice or narration/i.test(boundaryText) &&
        /public YouTube upload or Devpost submission/i.test(boundaryText) &&
        opening.proofBoundary?.providerDispatch === false &&
        opening.proofBoundary?.candidateIsLocalOnly === true &&
        opening.proofBoundary?.continuousHumanPlaybackReviewed === false &&
        opening.proofBoundary?.contactSheetIsContinuousPlayback === false,
      receipt: receiptProvesBoundaries(functionalReceipt),
      benchmark: benchmark.proofBoundary?.claimsNotSupported?.some(value =>
        /production security or hardened sandbox/i.test(value)) &&
        benchmark.proofBoundary?.claimsNotSupported?.some(value =>
          /model-backed agent safety or quality/i.test(value)) &&
        benchmark.proofBoundary?.claimsNotSupported?.some(value =>
          /TikTok/i.test(value)) &&
        benchmark.proofBoundary?.claimsNotSupported?.some(value =>
          /fair performance ranking/i.test(value)),
    }),
    claim('allowed-effect-capability-boundary', {
      playbook: has(documents.playbook,
        /DEMO_RUNNER=1/i,
        /process-local parent Effect Capability/i,
        /five-second lifetime/i,
        /Run, Agent, action, target/i,
        /policy name, policy version, and full-policy digest/i,
        /issued -> claimed -> consumed/i,
        /opaque child/i,
        /redeem-only port/i,
        /protected denial receives no grant/i,
        /ambient filesystem removal/i,
        /OS\/kernel isolation/i),
      architecture: has(documents.architecture,
        /DEMO_RUNNER=1/i,
        /process-local Effect Capability/i,
        /five-second lifetime/i,
        /Run, Agent, action, target class/i,
        /policy name, policy version, and digest/i,
        /issued -> claimed -> consumed/i,
        /opaque child/i,
        /redeem-only port/i,
        /denied proposal[^.]{0,100}receives no Effect Capability/i,
        /ambient filesystem removal/i,
        /OS\/kernel isolation/i),
      capabilitySource: has(documents.effectCapabilitySource,
        /const defaultTtlMs = 5_000;/,
        /registry: "process-local"/,
        /runId: input\.runId/,
        /agentId: input\.agentId/,
        /action: input\.decision\.action/,
        /targetClass: input\.decision\.targetClass/,
        /policyVersion: input\.decision\.version/,
        /policyDigest: EFFECT_FIREWALL_POLICY_DIGEST/,
        /not authentication, durable authority, provider interception, or kernel isolation/),
      agentServiceSource: orderedFragments(documents.agentServiceSource, [
        'const issued = this.effectCapabilities.issue({',
        'const claimed = this.effectCapabilities.claim(issued, binding);',
        'effectCapability = this.effectCapabilities.consume(claimed, binding);',
        'const sink = this.effectSinkBroker.issue({',
        'result = await this.runner.run({',
      ]),
      agentServiceTest: has(documents.agentServiceTest,
        /DEMO_RUNNER: "1"/,
        /state: "consumed"/,
        /expect\(service\.getRun\(denied\.run\.id\)\.effectCapability\)\.toBeUndefined\(\)/,
        /expect\(runner\.requests\)\.toHaveLength\(1\)/),
      functionalReceipt: receiptProvesEffectCapabilities(functionalReceipt, documents.paths),
    }),
    claim('cooperative-exact-sink-lifecycle', {
      opening: /cooperative exact sink/i.test(openingSequence) &&
        /ISSUE > CLAIM > CONSUME > COMMIT/i.test(openingSequence) &&
        /EFFECT_SINK_CLOSED/i.test(openingSequence) &&
        /ambient filesystem bypass/i.test(openingSequence),
      effectSinkSource: has(documents.effectSinkSource,
        /class ProcessLocalEffectSinkBroker/,
        /EFFECT_SINK_CLOSED/,
        /relativePath/,
        /payloadSha256/,
        /same-filesystem atomic replace/,
        /concurrent ancestor-swap TOCTOU/),
      functionalReceipt: receiptProvesEffectSink(functionalReceipt, documents.paths),
    }),
    claim('current-local-candidate-contract', {
      playbook: has(documents.playbook,
        /docs\/demo\/nerveloop-effect-firewall-candidate\.mp4/i,
        /139\.875 seconds/i,
        /1920[×x]1080/i,
        /H\.264/i,
        /AAC/i,
        /zero imported screenshots/i,
        /operating-system font resolution/i,
        /no voice or narration/i,
        /contact sheet[^.]{0,120}not continuous human playback/i,
        /not a public YouTube video/i,
        /not evidence of Devpost submission/i),
      architecture: has(documents.architecture,
        /docs\/demo\/nerveloop-effect-firewall-candidate\.mp4/i,
        /139\.875 seconds/i,
        /1920[×x]1080/i,
        /H\.264/i,
        /AAC/i,
        /no voice or narration/i,
        /contact sheet[^.]{0,120}not equivalent to watching/i,
        /public YouTube upload/i,
        /verified Devpost submission/i),
      opening: candidateSidecarMatchesOpening({candidateSidecar, opening, paths: documents.paths}) &&
        opening.releaseGates?.humanPlaybackReview === false &&
        opening.releaseGates?.publicYoutubeUploadVerified === false &&
        opening.releaseGates?.devpostSubmissionVerified === false,
      sidecar: candidateSidecar.kind === CANDIDATE_SIDECAR_KIND &&
        candidateSidecar.rendering?.voice === 'none' &&
        candidateSidecar.proofBoundary?.publicUploadClaim === false &&
        candidateSidecar.proofBoundary?.devpostSubmissionClaim === false,
    }),
    claim('stable-media-honestly-fallback', {
      ...mapDocumentCheck(documents, hasStableFallbackBoundary),
      opening: opening.preservation?.stableStoryboard ===
          'docs/demo/submission-storyboard.json' &&
        opening.preservation?.stableVideo ===
          'docs/demo/nerveloop-submission-draft.mp4' &&
        opening.preservation?.stableVideoSha256 === STABLE_VIDEO_SHA256 &&
        opening.preservation?.stableDurationSeconds === 159 &&
        opening.preservation?.fallbackOnly === true &&
        opening.preservation?.currentNarrativeReflectedByStableArtifacts === false &&
        opening.preservation?.stableArtifactsModifiedByThisContract === false,
      storyboard: storyboard.version === 2 && storyboard.scenes?.length === 10 &&
        totalSeconds === 159 &&
        storyboard.title === 'NerveLoop: the nervous system beneath coding agents' &&
        storyboard.currentCandidate === false &&
        storyboard.selectedForUpload === false &&
        storyboard.publicMediaIncluded === false &&
        /private macOS Samantha System Voice timing reference; do not publish/i.test(storyboard.voice) &&
        /text-only historical fallback metadata/i.test(storyboard.proofBoundary) &&
        !/"screenshot"|\.png|\.jpe?g/i.test(storyboardText) &&
        !/The agent can propose\. Only policy can cause effects\./i.test(storyboardText),
      stableVideo: stableVideoSha256 === STABLE_VIDEO_SHA256,
      receipt: functionalReceipt.stableFallback?.path ===
          'docs/demo/nerveloop-submission-draft.mp4' &&
        functionalReceipt.stableFallback?.unchanged === true &&
        functionalReceipt.stableFallback?.afterSha256 === STABLE_VIDEO_SHA256,
      candidateSidecar: candidateSidecar.stableFallback?.path ===
          'docs/demo/nerveloop-submission-draft.mp4' &&
        candidateSidecar.stableFallback?.sha256Before === STABLE_VIDEO_SHA256 &&
        candidateSidecar.stableFallback?.sha256After === STABLE_VIDEO_SHA256 &&
        candidateSidecar.stableFallback?.unchanged === true &&
        candidateSidecar.stableFallback?.overwritten === false,
    }),
  ];

  const failedClaims = claims.filter(item => !item.passed).map(item => item.id);
  const contractAligned = failedClaims.length === 0;

  const candidateChecks = [
    claim('candidate-artifact-binding', {
      openingAndSidecar: candidateSidecarMatchesOpening({
        candidateSidecar,
        opening,
        paths: documents.paths,
      }),
      parsedSidecarMatchesLoadedBytes:
        hashText(JSON.stringify(candidateSidecar)) === documents.candidateSidecarObjectSha256,
    }),
    claim('candidate-source-bindings-current', {
      allTenBindingsIncludingPinnedBitmapFont: candidateSourceCurrent,
    }),
    claim('candidate-media-contract', {
      independentMachineVerifier: candidateMachineValidation.passed === true,
      videoHash: candidateMachineValidation.videoSha256 === CANDIDATE_VIDEO_SHA256,
      duration: candidateMachineValidation.durationSeconds === 139.875 &&
        candidateMachineValidation.durationSeconds <= 180,
      dimensions: candidateMachineValidation.dimensions === '1920x1080',
      codecs: candidateMachineValidation.videoCodec === 'h264' &&
        candidateMachineValidation.audioCodec === 'aac',
      extendedMedia: candidateSidecar.media?.video?.pixelFormat === 'yuv420p' &&
        candidateSidecar.media?.video?.frameRate === '24/1' &&
        candidateSidecar.media?.audio?.sampleRate === 48000 &&
        candidateSidecar.media?.audio?.channels === 2,
      samplesAndBindings: candidateMachineValidation.sourceBindings === 10 &&
        candidateMachineValidation.sampleFrames === 7,
    }),
    claim('candidate-demonstrated-sequence', {
      sidecar: candidateDemonstratesCurrentStory(candidateSidecar),
      functionalReceipt: receiptProvesTypedDenial(functionalReceipt) &&
        receiptProvesZeroDispatch(functionalReceipt) &&
        receiptProvesSameAgentContinuation(functionalReceipt) &&
        receiptProvesRunGuardBackstop(functionalReceipt) &&
        receiptProvesEffectCapabilities(functionalReceipt, documents.paths) &&
        receiptProvesEffectSink(functionalReceipt, documents.paths),
      benchmark: benchmarkProvesThreeConditions(benchmark),
    }),
    claim('candidate-proof-boundary', {
      sidecar: candidatePreservesProofBoundary(candidateSidecar),
      opening: opening.proofBoundary?.candidateIsLocalOnly === true &&
        opening.proofBoundary?.continuousHumanPlaybackReviewed === false &&
        opening.proofBoundary?.contactSheetIsContinuousPlayback === false,
      machineVerifier: candidateMachineValidation.proofBoundary?.publicUploadClaim === false &&
        candidateMachineValidation.proofBoundary?.devpostSubmissionClaim === false,
    }),
    claim('candidate-preserves-stable-fallback', {
      machineVerifier: candidateMachineValidation.stableFallbackUnchanged === true,
      currentHash: stableVideoSha256 === STABLE_VIDEO_SHA256,
    }),
  ];
  const failedCandidateChecks = candidateChecks
    .filter(item => !item.passed)
    .map(item => item.id);
  const candidateMediaReady = failedCandidateChecks.length === 0;
  const localCandidateReady = contractAligned && candidateMediaReady;

  // Human playback and public service state cannot be proved from repository
  // bytes. This verifier therefore records them as open gates rather than
  // trusting a local boolean or contact sheet.
  const humanPlaybackReviewed = false;
  const publicYoutubeUploadVerified = false;
  const devpostSubmissionVerified = false;
  const releaseReady = localCandidateReady && humanPlaybackReviewed &&
    publicYoutubeUploadVerified && devpostSubmissionVerified;
  const openGates = [
    ...(contractAligned ? [] : ['cross-artifact-contract']),
    ...failedCandidateChecks,
    ...(humanPlaybackReviewed ? [] : ['human-playback-review']),
    ...(publicYoutubeUploadVerified ? [] : ['public-youtube-upload']),
    ...(devpostSubmissionVerified ? [] : ['devpost-submission-verified']),
  ];

  return {
    schemaVersion: 3,
    contract: 'nerveloop-judge-story-v3',
    status: releaseReady
      ? 'READY'
      : !contractAligned
        ? 'BLOCKED_CONTRACT'
        : !candidateMediaReady
          ? 'BLOCKED_CANDIDATE_MEDIA'
          : 'LOCAL_CANDIDATE_READY_RELEASE_BLOCKED',
    passed: releaseReady,
    contractAligned,
    candidateMediaReady,
    localCandidateReady,
    humanPlaybackReviewed,
    publicYoutubeUploadVerified,
    devpostSubmissionVerified,
    releaseReady,
    claimCount: claims.length,
    candidateCheckCount: candidateChecks.length,
    totalSeconds,
    stableVideoSha256,
    candidateVideoSha256: hash(documents.paths.candidateVideo),
    candidateSidecarSha256: hash(documents.paths.candidateSidecar),
    candidateMachineValidation,
    claims,
    failedClaims,
    candidateChecks,
    failedCandidateChecks,
    openGates,
    detail: releaseReady
      ? `${claims.length}/${claims.length} story claims and ${candidateChecks.length}/${candidateChecks.length} candidate checks align.`
      : !contractAligned
        ? `Judge-story claims failed: ${failedClaims.join(', ')}`
        : !candidateMediaReady
          ? `Candidate checks failed: ${failedCandidateChecks.join(', ')}${candidateMachineValidation.error ? ` (${candidateMachineValidation.error})` : ''}`
          : `${claims.length}/${claims.length} story claims and ${candidateChecks.length}/${candidateChecks.length} candidate checks align. The 139.875-second local candidate is machine-ready, but continuous human playback, public YouTube upload, and Devpost submission remain unproved.`,
  };
}

export function verifyJudgeStoryContract({repository}) {
  const documents = loadJudgeStoryDocuments({repository});
  const result = evaluateJudgeStoryDocuments(documents);
  return {
    ...result,
    files: Object.fromEntries(Object.entries(documents.paths).map(([key, path]) => [
      key,
      {path: relative(repository, path), sha256: hash(path)},
    ])),
  };
}

export function judgeStoryReceiptMatches(receipt, currentResult) {
  if (!currentResult.releaseReady || !receipt?.releaseReady) return false;
  if (!Number.isFinite(Date.parse(receipt.generatedAt ?? ''))) return false;
  const {generatedAt: _generatedAt, ...savedResult} = receipt;
  return JSON.stringify(savedResult) === JSON.stringify(currentResult);
}

export function judgeStoryReceiptWriteEligibility(result) {
  if (!result.contractAligned) {
    return {allowed: false, reason: 'cross-artifact-contract-failed'};
  }
  if (!result.candidateMediaReady) {
    return {allowed: false, reason: 'candidate-media-not-current'};
  }
  if (!result.releaseReady) {
    return {allowed: false, reason: 'human-or-public-release-gates-open'};
  }
  return {allowed: true, reason: null};
}

export function writeJudgeStoryReceipt({repository, result, generatedAt = new Date().toISOString()}) {
  const eligibility = judgeStoryReceiptWriteEligibility(result);
  if (!eligibility.allowed) {
    return {written: false, ...eligibility};
  }
  const outputDirectory = join(repository, 'research/evidence/2026-08-31-judge-story-contract');
  const output = join(outputDirectory, 'receipt.json');
  mkdirSync(outputDirectory, {recursive: true});
  writeFileSync(output, `${JSON.stringify({generatedAt, ...result}, null, 2)}\n`);
  return {written: true, allowed: true, reason: null, path: relative(repository, output)};
}

function main() {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = verifyJudgeStoryContract({repository});
  const receiptWrite = process.argv.includes('--write-receipt')
    ? writeJudgeStoryReceipt({repository, result})
    : {written: false, allowed: null, reason: 'not-requested'};
  const report = {generatedAt: new Date().toISOString(), ...result, receiptWrite};
  console.log(JSON.stringify(report, null, 2));
  if (!result.releaseReady) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
