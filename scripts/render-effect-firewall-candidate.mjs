import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {deflateSync} from 'node:zlib';

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const candidatePath = join(repository, 'docs/demo/nerveloop-effect-firewall-candidate.mp4');
export const receiptPath = join(repository, 'docs/demo/nerveloop-effect-firewall-candidate.json');
export const storyStillPath = join(repository, 'docs/assets/nerveloop-effect-firewall-story.png');
export const stableFallbackPath = join(repository, 'docs/demo/nerveloop-submission-draft.mp4');
export const frameRate = 24;
export const transitionSeconds = 0.65;

const WIDTH = 1920;
const HEIGHT = 1080;
const SAMPLE_RATE = 48_000;
const scriptPath = fileURLToPath(import.meta.url);
const fontPath = join(repository, 'research/evidence/2026-09-01-provenance-cleared-media-experiment/font8x8_basic.h');
// Pinned from https://github.com/dhepper/font8x8 at commit
// 8e279d2d864e79128e96188a6b9526cfa3fbfef9. The retained header declares
// Public Domain; this source-bound assertion is provenance, not legal advice.
const FONT_HEADER_SHA256 = '49d8df366296b203ca3211bc0672cf2a762135bf12710735b6292756b19dffd5';
const FONT_UPSTREAM_COMMIT = '8e279d2d864e79128e96188a6b9526cfa3fbfef9';

const sources = [
  {
    path: 'research/evidence/2026-09-01-track-c-functional-flow/current.json',
    role: 'same-Agent pre-dispatch denial, post-run rollback, and later-safe receipt',
  },
  {
    path: 'research/evidence/2026-09-01-track-c-condition-benchmark/results.json',
    role: 'six-round three-condition KPI source',
  },
  {
    path: 'research/evidence/2026-09-01-effect-firewall-adversarial/results.json',
    role: 'finite lattice, shape, prompt, monotonicity, and mutation source',
  },
  {path: 'apps/server/src/effect-policy.ts', role: 'host-owned monotone Effect Firewall implementation'},
  {path: 'apps/server/src/effect-capability.ts', role: 'process-local one-use Effect Capability implementation'},
  {path: 'apps/server/src/effect-sink.ts', role: 'cooperative exact-path process-local sink redemption and terminal receipt implementation'},
  {path: 'apps/server/src/agent-service.ts', role: 'pre-dispatch policy, capability, and worker-ordering seam'},
  {path: 'apps/server/src/fixture-runner.ts', role: 'deterministic typed-effect and admitted-drift worker fixture'},
  {path: 'apps/server/src/run-guard.ts', role: 'separate post-run verification and rollback implementation'},
  {
    path: 'research/evidence/2026-09-01-provenance-cleared-media-experiment/font8x8_basic.h',
    role: 'commit-pinned 8x8 Basic Latin bitmap font used for every text glyph; retained header declares Public Domain',
  },
];

export const scenes = Object.freeze([
  {id: '01-incident', duration: 10, accent: 'coral', pulse: [110, 1130, 596]},
  {id: '02-principle', duration: 11, accent: 'cyan', pulse: [160, 1530, 806]},
  {id: '03-typed-proposal', duration: 12, accent: 'coral', pulse: [90, 1250, 682]},
  {id: '04-monotone-gate', duration: 14, accent: 'coral', pulse: [250, 1270, 760]},
  {id: '05-proof-surface', duration: 12, accent: 'coral', pulse: [150, 1760, 935]},
  {id: '06-later-safe', duration: 11, accent: 'cyan', pulse: [230, 1610, 675]},
  {id: '07-runguard', duration: 13, accent: 'amber', pulse: [210, 1550, 655]},
  {id: '08-architecture', duration: 14, accent: 'cyan', pulse: [90, 1700, 610]},
  {id: '09-six-round-kpi', duration: 15, accent: 'cyan', pulse: [180, 1690, 918]},
  {id: '10-adversarial', duration: 13, accent: 'coral', pulse: [120, 1520, 900]},
  {id: '11-boundary', duration: 11, accent: 'amber', pulse: [340, 1520, 800]},
  {id: '12-close', duration: 11, accent: 'cyan', pulse: [210, 1580, 770]},
]);

const palette = Object.freeze({
  bg: [6, 11, 13, 255],
  bg2: [10, 19, 21, 255],
  ink: [240, 239, 232, 255],
  muted: [132, 147, 150, 255],
  faint: [60, 75, 79, 255],
  line: [42, 59, 63, 255],
  cyan: [101, 230, 220, 255],
  cyanDim: [32, 99, 99, 255],
  coral: [255, 103, 94, 255],
  coralDim: [105, 43, 42, 255],
  amber: [225, 182, 96, 255],
  green: [109, 228, 175, 255],
});

function loadPublicDomainGlyphs(path) {
  const source = readFileSync(path, 'utf8');
  assert.match(source, /Author: Daniel Hepper/);
  assert.match(source, /License: Public Domain/);
  const declaration = source.match(/char\s+font8x8_basic\[128\]\[8\]\s*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(declaration, 'Could not locate font8x8_basic[128][8] declaration');
  const rows = [...declaration[1].matchAll(/\{\s*((?:0x[0-9A-Fa-f]{2}\s*,?\s*){8})\}/g)]
    .map(match => [...match[1].matchAll(/0x([0-9A-Fa-f]{2})/g)].map(value => Number.parseInt(value[1], 16)));
  assert.equal(rows.length, 128, 'Expected exactly 128 Basic Latin bitmap glyphs');
  assert.ok(rows.every(glyph => glyph.length === 8), 'Every bitmap glyph must contain exactly 8 rows');
  return Object.freeze(rows.map(glyph => Object.freeze(glyph)));
}

const glyphs = loadPublicDomainGlyphs(fontPath);
const FONT_SCALE = 0.625;

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const shaBytes = value => createHash('sha256').update(value).digest('hex');
const shaText = value => createHash('sha256').update(value).digest('hex');
const assertRegular = (path, label) => {
  assert.ok(existsSync(path), `Missing ${label}: ${path}`);
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular non-symlink file`);
};
const run = (binary, args, options = {}) => execFileSync(binary, args, {
  cwd: options.cwd ?? repository,
  encoding: options.encoding ?? 'utf8',
  stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  timeout: options.timeout ?? 300_000,
  maxBuffer: 32 * 1024 * 1024,
});
const probe = path => JSON.parse(run('ffprobe', [
  '-v', 'error', '-show_format', '-show_streams', '-of', 'json', path,
]));

class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4);
  }

  blend(x, y, color) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const offset = (y * this.width + x) * 4;
    const alpha = (color[3] ?? 255) / 255;
    const inverse = 1 - alpha;
    this.data[offset] = Math.round(color[0] * alpha + this.data[offset] * inverse);
    this.data[offset + 1] = Math.round(color[1] * alpha + this.data[offset + 1] * inverse);
    this.data[offset + 2] = Math.round(color[2] * alpha + this.data[offset + 2] * inverse);
    this.data[offset + 3] = 255;
  }

  fill(color) {
    for (let offset = 0; offset < this.data.length; offset += 4) {
      this.data[offset] = color[0];
      this.data[offset + 1] = color[1];
      this.data[offset + 2] = color[2];
      this.data[offset + 3] = color[3] ?? 255;
    }
  }

  gradient(accent = palette.cyan, focusX = 0.72, focusY = 0.42) {
    const ax = this.width * focusX;
    const ay = this.height * focusY;
    const radius = Math.hypot(this.width, this.height) * 0.62;
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const dx = x - ax;
        const dy = y - ay;
        const halo = Math.max(0, 1 - Math.hypot(dx, dy) / radius);
        const vignette = Math.max(0, Math.hypot((x - this.width / 2) / this.width, (y - this.height / 2) / this.height) - 0.18);
        const offset = (y * this.width + x) * 4;
        this.data[offset] = Math.max(0, Math.round(7 + accent[0] * halo * 0.035 - vignette * 13));
        this.data[offset + 1] = Math.max(0, Math.round(12 + accent[1] * halo * 0.04 - vignette * 15));
        this.data[offset + 2] = Math.max(0, Math.round(14 + accent[2] * halo * 0.055 - vignette * 17));
        this.data[offset + 3] = 255;
      }
    }
    for (let x = 0; x < this.width; x += 48) this.rect(x, 0, 1, this.height, [80, 105, 108, 12]);
    for (let y = 0; y < this.height; y += 48) this.rect(0, y, this.width, 1, [80, 105, 108, 12]);
    this.rect(24, 24, this.width - 48, 1, palette.line);
    this.rect(24, this.height - 25, this.width - 48, 1, palette.line);
    this.rect(24, 24, 1, this.height - 48, palette.line);
    this.rect(this.width - 25, 24, 1, this.height - 48, palette.line);
  }

  rect(x, y, width, height, color) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + width));
    const y1 = Math.min(this.height, Math.ceil(y + height));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) this.blend(px, py, color);
    }
  }

  line(x0, y0, x1, y1, color, width = 1) {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let index = 0; index <= steps; index += 1) {
      const t = index / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      this.circle(x, y, width / 2, color, true);
    }
  }

  circle(cx, cy, radius, color, filled = false, thickness = 2) {
    const x0 = Math.max(0, Math.floor(cx - radius - thickness));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + radius + thickness));
    const y0 = Math.max(0, Math.floor(cy - radius - thickness));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + radius + thickness));
    const inner = Math.max(0, radius - thickness);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const distance = Math.hypot(x - cx, y - cy);
        if ((filled && distance <= radius) || (!filled && distance <= radius && distance >= inner)) {
          this.blend(x, y, color);
        }
      }
    }
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBuffer.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return output;
}

function png(canvas) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(canvas.width, 0);
  header.writeUInt32BE(canvas.height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc((canvas.width * 4 + 1) * canvas.height);
  for (let y = 0; y < canvas.height; y += 1) {
    const target = y * (canvas.width * 4 + 1);
    scanlines[target] = 0;
    canvas.data.copy(scanlines, target + 1, y * canvas.width * 4, (y + 1) * canvas.width * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines, {level: 9})),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function textWidth(value, unit, spacing = unit) {
  const pixelUnit = unit * FONT_SCALE;
  const pixelSpacing = spacing * FONT_SCALE;
  return [...value.toUpperCase()].reduce((sum, _character, index) => (
    sum + 8 * pixelUnit + (index === value.length - 1 ? 0 : pixelSpacing)
  ), 0);
}

function drawText(canvas, value, x, y, unit, color, options = {}) {
  const normalized = value.toUpperCase();
  const spacing = options.spacing ?? unit;
  const pixelUnit = unit * FONT_SCALE;
  const pixelSpacing = spacing * FONT_SCALE;
  let cursor = options.align === 'center' ? x - textWidth(normalized, unit, spacing) / 2 : x;
  if (options.align === 'right') cursor = x - textWidth(normalized, unit, spacing);
  for (const character of normalized) {
    const codePoint = character.codePointAt(0);
    const glyph = glyphs[codePoint >= 0 && codePoint < 128 ? codePoint : 63];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < 8; column += 1) {
        if (((glyph[row] >> column) & 1) === 0) continue;
        if (options.glow) canvas.rect(cursor + column * pixelUnit - pixelUnit * 0.2, y + row * pixelUnit - pixelUnit * 0.2, pixelUnit * 1.4, pixelUnit * 1.4, [...color.slice(0, 3), 30]);
        canvas.rect(cursor + column * pixelUnit, y + row * pixelUnit, Math.max(1, pixelUnit * 0.78), Math.max(1, pixelUnit * 0.78), color);
      }
    }
    cursor += 8 * pixelUnit + pixelSpacing;
  }
}

function label(canvas, value, x, y, color = palette.muted, options = {}) {
  drawText(canvas, value, x, y, 3, color, {spacing: 3, ...options});
}

function headline(canvas, lines, x, y, unit = 12, color = palette.ink, lineGap = unit * 9) {
  for (const [index, line] of lines.entries()) drawText(canvas, line, x, y + index * lineGap, unit, color, {spacing: unit});
}

function masthead(canvas, sceneIndex, title, accent) {
  canvas.rect(68, 54, 4, 14, palette.cyan);
  canvas.rect(78, 46, 4, 22, accent);
  canvas.rect(88, 51, 4, 17, palette.coral);
  label(canvas, 'TIKTOK TECHJAM 2026 / OFFICIAL TRACK #1 / AGENT LAUNCHPAD', 112, 48, palette.muted);
  label(canvas, `NERVELOOP / ${String(sceneIndex + 1).padStart(2, '0')} / ${title}`, 1850, 48, palette.faint, {align: 'right'});
  canvas.rect(68, 92, 1784, 1, palette.line);
}

function footer(canvas, copy) {
  const rightCopy = 'LOCAL / NO MODEL CALLS';
  const leftX = 68;
  const rightX = 1850;
  const minimumGap = 48;
  const leftEnd = leftX + textWidth(copy, 3, 3);
  const rightStart = rightX - textWidth(rightCopy, 3, 3);
  assert.ok(
    leftEnd + minimumGap <= rightStart,
    `Footer copy collision: "${copy}" ends at ${leftEnd.toFixed(1)}px; right label starts at ${rightStart.toFixed(1)}px`,
  );
  canvas.rect(68, 984, 1784, 1, palette.line);
  label(canvas, copy, leftX, 1010, palette.faint);
  label(canvas, rightCopy, rightX, 1010, palette.faint, {align: 'right'});
}

function drawNeuralLine(canvas, x0, x1, y, color, amplitude = 16, nodes = 7) {
  let px = x0;
  let py = y;
  for (let index = 1; index <= 100; index += 1) {
    const t = index / 100;
    const x = x0 + (x1 - x0) * t;
    const wave = Math.sin(t * Math.PI * 3) * amplitude * Math.sin(t * Math.PI);
    const nextY = y + wave;
    canvas.line(px, py, x, nextY, [...color.slice(0, 3), 150], 2);
    px = x;
    py = nextY;
  }
  for (let index = 0; index < nodes; index += 1) {
    const t = index / (nodes - 1);
    const x = x0 + (x1 - x0) * t;
    const nodeY = y + Math.sin(t * Math.PI * 3) * amplitude * Math.sin(t * Math.PI);
    canvas.circle(x, nodeY, 7, color, false, 2);
  }
}

function panel(canvas, x, y, width, height, accent = palette.line) {
  canvas.rect(x, y, width, height, [9, 16, 18, 235]);
  canvas.rect(x, y, width, 1, accent);
  canvas.rect(x, y, 3, height, accent);
  canvas.rect(x, y + height - 1, width, 1, palette.line);
  canvas.rect(x + width - 1, y, 1, height, palette.line);
}

function renderPlate(sceneIndex) {
  const scene = scenes[sceneIndex];
  const accent = palette[scene.accent];
  const canvas = new Canvas(WIDTH, HEIGHT);
  canvas.gradient(accent, sceneIndex % 2 === 0 ? 0.72 : 0.3, sceneIndex % 3 === 0 ? 0.35 : 0.55);
  masthead(canvas, sceneIndex, scene.id.replace(/^\d+-/, '').replaceAll('-', ' '), accent);

  if (scene.id === '01-incident') {
    label(canvas, 'NORMAL SAFE RUN / RETAINED', 86, 156, palette.cyan);
    headline(canvas, ['SAFE WORK LANDS.', 'THEN RISK ARRIVES.'], 86, 216, 11, palette.ink, 112);
    panel(canvas, 86, 535, 930, 220, palette.coral);
    label(canvas, 'THEN THE SAME AGENT PROPOSES', 122, 572, palette.muted);
    drawText(canvas, 'DELETE_MOCK_ASSET', 122, 628, 8, palette.coral, {spacing: 8, glow: true});
    label(canvas, 'TARGET CLASS / PROTECTED', 122, 716, palette.ink);
    canvas.circle(1395, 560, 128, palette.coralDim, false, 2);
    canvas.circle(1395, 560, 88, palette.coral, false, 3);
    canvas.line(1350, 515, 1440, 605, palette.coral, 7);
    canvas.line(1440, 515, 1350, 605, palette.coral, 7);
    drawNeuralLine(canvas, 1050, 1260, 560, palette.coral, 22, 4);
    label(canvas, 'THE INCIDENT ARRIVES AS INTENT.', 1080, 756, palette.muted);
    label(canvas, 'NOT YET AS AN EFFECT.', 1137, 788, palette.cyan);
    footer(canvas, 'A HUMAN-READABLE INCIDENT, BOUND TO A MACHINE-READABLE RECEIPT.');
  } else if (scene.id === '02-principle') {
    label(canvas, 'THE DESIGN RULE', 88, 170, palette.cyan);
    headline(canvas, ['THE AGENT CAN', 'PROPOSE.'], 88, 244, 15, palette.ink, 148);
    headline(canvas, ['ONLY POLICY CAN', 'CAUSE EFFECTS.'], 88, 552, 13, palette.coral, 132);
    drawNeuralLine(canvas, 1040, 1710, 806, palette.cyan, 26, 9);
    canvas.rect(1375, 670, 6, 272, palette.coral);
    label(canvas, 'THOUGHT', 1035, 866, palette.muted);
    label(canvas, 'TRUSTED BOUNDARY', 1270, 866, palette.coral);
    label(canvas, 'ACTION', 1570, 866, palette.muted);
    footer(canvas, 'THE MIDDLEWARE IS THE NERVOUS SYSTEM BETWEEN THOUGHT AND ACTION.');
  } else if (scene.id === '03-typed-proposal') {
    label(canvas, '01 / TURN LANGUAGE INTO STRUCTURE', 88, 160, palette.cyan);
    headline(canvas, ['INTENT BECOMES', 'A TYPED PROPOSAL.'], 88, 228, 12, palette.ink, 120);
    panel(canvas, 88, 532, 1050, 250, palette.cyan);
    label(canvas, 'EXACT SCHEMA / VERSION 1', 126, 570, palette.muted);
    drawText(canvas, '{ ACTION: DELETE_MOCK_ASSET,', 126, 625, 5, palette.ink, {spacing: 5});
    drawText(canvas, '  TARGETCLASS: PROTECTED }', 126, 692, 5, palette.coral, {spacing: 5, glow: true});
    label(canvas, 'UNKNOWN OR EXTRA FIELDS FAIL CLOSED.', 126, 748, palette.muted);
    canvas.circle(1450, 570, 106, palette.coral, false, 2);
    canvas.circle(1450, 570, 60, palette.coralDim, false, 2);
    drawText(canvas, 'HOST', 1450, 545, 5, palette.coral, {align: 'center'});
    drawNeuralLine(canvas, 1168, 1340, 570, palette.coral, 18, 4);
    label(canvas, 'PROMPT TEXT DOES NOT WIDEN AUTHORITY.', 1245, 744, palette.muted);
    footer(canvas, 'EXACT ROUTE / OTHER DEMO RUNS DECLARE WORKSPACE EFFECTS.');
  } else if (scene.id === '04-monotone-gate') {
    label(canvas, '02 / LET THE HOST READ RISK, NOT CONFIDENCE', 88, 154, palette.cyan);
    headline(canvas, ['A MONOTONE', 'AUTHORITY GATE.'], 88, 220, 9, palette.ink, 95);
    label(canvas, 'ACTION RISK + TARGET SENSITIVITY <= 2', 90, 505, palette.amber);
    const startX = 1130;
    const startY = 420;
    const gapX = 135;
    const gapY = 130;
    const actionLabels = ['READ', 'WRITE', 'XFORM', 'PUBLISH', 'DELETE'];
    const targetLabels = ['SCRATCH', 'WORKSPACE', 'CANDIDATE', 'PROTECTED'];
    const actionLabelUnit = 2.5;
    const actionLabelSpacing = 2.5;
    const minimumActionLabelGap = 24;
    for (let column = 0; column < actionLabels.length - 1; column += 1) {
      const leftWidth = textWidth(actionLabels[column], actionLabelUnit, actionLabelSpacing);
      const rightWidth = textWidth(actionLabels[column + 1], actionLabelUnit, actionLabelSpacing);
      const observedGap = gapX - leftWidth / 2 - rightWidth / 2;
      assert.ok(
        observedGap >= minimumActionLabelGap,
        `Action header collision: ${actionLabels[column]} / ${actionLabels[column + 1]} leave only ${observedGap.toFixed(1)}px`,
      );
    }
    for (let column = 0; column < 5; column += 1) {
      drawText(canvas, actionLabels[column], startX + column * gapX, 362, actionLabelUnit, palette.muted, {
        align: 'center',
        spacing: actionLabelSpacing,
      });
    }
    for (let row = 0; row < 4; row += 1) {
      label(canvas, targetLabels[row], 930, startY + row * gapY - 8, row === 3 ? palette.coral : palette.muted);
      for (let column = 0; column < 5; column += 1) {
        const allowed = row + column <= 2;
        const isIncident = row === 3 && column === 4;
        const color = allowed ? palette.cyan : palette.coralDim;
        canvas.circle(startX + column * gapX, startY + row * gapY, isIncident ? 32 : 22, isIncident ? palette.coral : color, false, isIncident ? 5 : 3);
        if (allowed) canvas.circle(startX + column * gapX, startY + row * gapY, 6, palette.cyan, true);
        if (isIncident) {
          canvas.line(startX + column * gapX - 14, startY + row * gapY - 14, startX + column * gapX + 14, startY + row * gapY + 14, palette.coral, 4);
          canvas.line(startX + column * gapX + 14, startY + row * gapY - 14, startX + column * gapX - 14, startY + row * gapY + 14, palette.coral, 4);
        }
      }
    }
    label(canvas, '5 ACTIONS X 4 TARGET CLASSES', 90, 590, palette.ink);
    label(canvas, 'RISK UP OR SENSITIVITY UP', 90, 654, palette.muted);
    drawText(canvas, 'CAN NEVER TURN DENY INTO ALLOW.', 90, 706, 5, palette.coral, {spacing: 5});
    label(canvas, 'RECEIPT / WORKER 0 / CHANGED FILES 0', 90, 822, palette.cyan);
    label(canvas, 'RECOVERY NOT_NEEDED / BEFORE = AFTER', 90, 866, palette.cyan);
    footer(canvas, 'A SMALL POLICY SPACE CAN BE EXHAUSTIVELY CHECKED, NOT HAND-WAVED.');
  } else if (scene.id === '05-proof-surface') {
    label(canvas, '03 / READ THE RECEIPT AS A STORY', 88, 154, palette.cyan);
    headline(canvas, ['ONE AGENT.', 'THREE OUTCOMES.'], 88, 220, 10, palette.ink, 104);
    const railX = 1080;
    const rows = [330, 565, 800];
    const events = [
      {number: '01', title: 'SAFE WRITE', state: 'COMMITTED', color: palette.cyan, detail: 'EARLIER SAFE WORK RETAINED'},
      {number: '02', title: 'PROTECTED DELETE', state: 'DENIED BEFORE DISPATCH', color: palette.coral, detail: 'WORKER 0 / CHANGED FILES 0'},
      {number: '03', title: 'LATER SAFE WRITE', state: 'COMMITTED', color: palette.green, detail: 'SAME AGENT / FRESH GRANT'},
    ];
    canvas.line(railX, rows[0], railX, rows.at(-1), palette.line, 4);
    for (const [index, event] of events.entries()) {
      const y = rows[index];
      canvas.circle(railX, y, 34, event.color, false, 4);
      drawText(canvas, event.number, railX, y - 12, 3, event.color, {align: 'center'});
      panel(canvas, 1165, y - 78, 590, 158, event.color);
      label(canvas, event.title, 1205, y - 40, palette.ink);
      drawText(canvas, event.state, 1205, y + 3, 4, event.color, {spacing: 4, glow: index === 1});
      label(canvas, event.detail, 1205, y + 52, palette.muted);
    }
    panel(canvas, 88, 575, 720, 242, palette.coral);
    label(canvas, 'DENIAL RECEIPT / SOURCE-BOUND', 126, 615, palette.muted);
    drawText(canvas, 'WORKER SPAWNED  0', 126, 665, 4, palette.coral, {spacing: 4});
    drawText(canvas, 'CHANGED FILES   0', 126, 718, 4, palette.coral, {spacing: 4});
    drawText(canvas, 'BEFORE = AFTER', 126, 771, 4, palette.cyan, {spacing: 4, glow: true});
    label(canvas, 'THE PROOF SURFACE IS RECONSTRUCTED FROM LOCAL RECEIPTS.', 88, 890, palette.muted);
    label(canvas, 'NO UI SCREENSHOT IS IMPORTED INTO THIS CUT.', 88, 926, palette.cyan);
    footer(canvas, 'THE HOST DECIDES BEFORE A WORKER EXISTS; LATER SAFE WORK STILL LANDS.');
  } else if (scene.id === '06-later-safe') {
    label(canvas, '04 / SAFETY WITHOUT PARALYSIS', 88, 158, palette.cyan);
    headline(canvas, ['SAME AGENT.', 'LATER SAFE RUN.'], 88, 228, 13, palette.ink, 132);
    canvas.circle(275, 660, 72, palette.cyan, false, 4);
    canvas.circle(275, 660, 10, palette.cyan, true);
    drawText(canvas, 'A', 275, 632, 8, palette.cyan, {align: 'center'});
    drawNeuralLine(canvas, 380, 800, 675, palette.cyan, 22, 6);
    panel(canvas, 820, 542, 700, 255, palette.cyan);
    label(canvas, 'ALLOWED EFFECT', 858, 584, palette.muted);
    drawText(canvas, 'WRITE_DEMO_RESULT', 858, 638, 6, palette.cyan, {spacing: 6, glow: true});
    label(canvas, 'TARGET / WORKSPACE', 858, 708, palette.ink);
    label(canvas, 'RESULT / RETAINED', 858, 748, palette.green);
    label(canvas, 'EXACT SINK RECEIPT / COMMITTED', 858, 786, palette.cyan);
    canvas.circle(1630, 675, 58, palette.green, false, 4);
    canvas.line(1600, 676, 1621, 697, palette.green, 5);
    canvas.line(1621, 697, 1665, 644, palette.green, 5);
    footer(canvas, 'THE DENIAL DOES NOT POISON THE AGENT OR ERASE ITS EARLIER SAFE WORK.');
  } else if (scene.id === '07-runguard') {
    label(canvas, '05 / A SEPARATE SECOND LINE', 88, 158, palette.amber);
    headline(canvas, ['IF A PERMITTED WORKER', 'CROSSES SCOPE...'], 88, 224, 7, palette.ink, 78);
    const y = 690;
    const nodes = [220, 590, 980, 1390, 1690];
    const names = ['CHECKPOINT', 'WORKER', 'VERIFY', 'ROLL BACK', 'READY'];
    for (let index = 0; index < nodes.length - 1; index += 1) canvas.line(nodes[index] + 65, y, nodes[index + 1] - 65, y, palette.line, 3);
    for (const [index, x] of nodes.entries()) {
      const color = index === 1 || index === 3 ? palette.coral : (index === 2 ? palette.amber : palette.cyan);
      canvas.circle(x, y, 54, color, false, 3);
      drawText(canvas, String(index + 1), x, y - 14, 4, color, {align: 'center'});
      label(canvas, names[index], x, y + 90, color, {align: 'center'});
    }
    canvas.line(1390, 630, 980, 530, palette.coral, 3);
    canvas.line(980, 530, 220, 630, palette.coral, 3);
    label(canvas, 'RESTORE ONLY THE OBSERVED DELTA', 860, 486, palette.coral);
    panel(canvas, 1100, 190, 650, 190, palette.amber);
    label(canvas, 'SEPARATE POST-RUN INCIDENT', 1138, 232, palette.muted);
    drawText(canvas, 'RECOVERY: ROLLED_BACK', 1138, 282, 4, palette.amber, {spacing: 4});
    label(canvas, 'UNREDEEMED SINK GRANT WAS REVOKED.', 1138, 332, palette.cyan);
    label(canvas, 'ACTUAL PROTECTED DRIFT WAS NOT RETAINED.', 1138, 360, palette.coral);
    footer(canvas, 'EFFECT FIREWALL PREVENTS; RUNGUARD VERIFIES, RESTORES, OR HOLDS.');
  } else if (scene.id === '08-architecture') {
    label(canvas, 'THE REFLEX ARC', 88, 158, palette.cyan);
    headline(canvas, ['POLICY. CAPABILITY.', 'RECOVERY.'], 88, 222, 9, palette.ink, 96);
    const y = 690;
    const xs = [110, 365, 620, 895, 1160, 1450, 1735];
    const titles = ['AGENT', 'TYPED', 'FIREWALL', 'SINK', 'WORKER', 'RUNGUARD', 'RECEIPT'];
    const subs = ['PROPOSES', 'EFFECT', 'HOST GATE', 'EXACT PATH', 'REDEEMS', 'VERIFY', 'EVIDENCE'];
    for (let index = 0; index < xs.length; index += 1) {
      const color = index === 2 ? palette.coral : (index === 3 ? palette.green : (index === 5 ? palette.amber : palette.cyan));
      canvas.circle(xs[index], y, index === 2 ? 70 : 48, color, false, index === 2 ? 4 : 2);
      if (index < xs.length - 1) canvas.line(xs[index] + 62, y, xs[index + 1] - 62, y, palette.line, 3);
      label(canvas, titles[index], xs[index], y + 92, color, {align: 'center'});
      label(canvas, subs[index], xs[index], y + 124, palette.muted, {align: 'center'});
    }
    canvas.line(620, 615, 620, 520, palette.coral, 3);
    canvas.line(620, 520, 1110, 520, palette.coral, 3);
    drawText(canvas, 'DENY / NO GRANT / WORKER 0', 865, 480, 4, palette.coral, {align: 'center'});
    panel(canvas, 720, 250, 680, 150, palette.green);
    label(canvas, 'PROCESS-LOCAL COOPERATIVE SINK / EXACT WRITE', 760, 288, palette.green);
    drawText(canvas, 'ISSUE  >  CLAIM  >  CONSUME  >  COMMIT', 760, 330, 3, palette.ink, {spacing: 3});
    label(canvas, 'RUN + AGENT + ACTION + TARGET + POLICY + PATH + PAYLOAD', 760, 374, palette.muted);
    canvas.line(1450, 632, 1450, 552, palette.amber, 3);
    drawText(canvas, 'ROLLBACK / HOLD', 1450, 510, 4, palette.amber, {align: 'center'});
    footer(canvas, 'THE AGENT NEVER OWNS THE HOST CEILING OR MINTS ITS OWN GRANT.');
  } else if (scene.id === '09-six-round-kpi') {
    label(canvas, 'SIX REPEATED LOCAL SEQUENCES', 88, 148, palette.cyan);
    headline(canvas, ['STOP EARLY.', 'PRESERVE SAFE WORK.'], 88, 204, 8, palette.ink, 86);
    const x0 = 100;
    const y0 = 444;
    const rowGap = 78;
    const columns = [x0, 990, 1305, 1620];
    const headers = ['MEASURE', 'RESET ALL', 'FIREWALL', 'RUNGUARD'];
    for (let i = 0; i < headers.length; i += 1) label(canvas, headers[i], columns[i], y0, i === 2 ? palette.cyan : palette.muted);
    const rows = [
      ['DETECTION', '0%', '100%', '100%'],
      ['CONTAINMENT', '100%', '100%', '100%'],
      ['WORKER DISPATCH', '100%', '0%', '100%'],
      ['LATER SAFE RETAINED', '0%', '100%', '100%'],
      ['RECOVERY TARGETS P50', '32', '0', '1'],
      ['STALE ESCAPES', '0', '0', '0'],
    ];
    for (const [rowIndex, row] of rows.entries()) {
      const y = y0 + 76 + rowIndex * rowGap;
      canvas.rect(x0, y - 22, 1100, 1, palette.line);
      for (let column = 0; column < row.length; column += 1) {
        const color = column === 2 ? palette.cyan : (column === 0 ? palette.ink : palette.muted);
        drawText(canvas, row[column], columns[column], y, column === 0 ? 3 : 5, color, {spacing: column === 0 ? 3 : 5});
      }
    }
    label(canvas, 'RESET ALL REBUILDS 32 PATHS. FIREWALL TOUCHES 0. RUNGUARD RESTORES 1.', 980, 252, palette.muted);
    label(canvas, 'LATENCY WAS UNCONTROLLED AND IS NOT RANKED.', 980, 304, palette.faint);
    footer(canvas, 'ACTUAL LOCAL RECEIPTS / DETERMINISTIC FIXTURE / NO PROVIDER CALLS.');
  } else if (scene.id === '10-adversarial') {
    label(canvas, 'WE TRIED TO BREAK THE RULE', 88, 150, palette.coral);
    headline(canvas, ['NOT JUST', 'DEMO IT.'], 88, 214, 13, palette.ink, 128);
    const stats = [
      ['20 / 20', 'LATTICE CELLS'],
      ['130', 'ORDER RELATIONS'],
      ['30 / 30', 'MALFORMED REJECTED'],
      ['20 / 20', 'MUTANTS KILLED'],
    ];
    for (const [index, stat] of stats.entries()) {
      const x = 760 + (index % 2) * 520;
      const y = 212 + Math.floor(index / 2) * 300;
      panel(canvas, x, y, 450, 230, index === 3 ? palette.coral : palette.line);
      drawText(canvas, stat[0], x + 36, y + 48, 8, index === 3 ? palette.coral : palette.cyan, {spacing: 8, glow: true});
      label(canvas, stat[1], x + 38, y + 152, palette.ink);
    }
    label(canvas, 'CONFUSABLE PROMPTS DID NOT ENTER THE EXACT FIXTURE ROUTE.', 88, 700, palette.muted);
    label(canvas, 'MUTATION SCORE / 100%', 88, 754, palette.coral);
    drawNeuralLine(canvas, 88, 610, 900, palette.coral, 18, 8);
    footer(canvas, 'FINITE ADVERSARIAL MATRIX, SOURCE-BOUND TO THE IMPLEMENTATION.');
  } else if (scene.id === '11-boundary') {
    label(canvas, 'THE HONEST BOUNDARY', 88, 154, palette.amber);
    headline(canvas, ['WHAT THIS PROVES.', 'WHAT IT DOES NOT.'], 88, 218, 10, palette.ink, 104);
    panel(canvas, 88, 512, 820, 338, palette.cyan);
    panel(canvas, 952, 512, 820, 338, palette.coral);
    label(canvas, 'OBSERVED LOCALLY / DEMO_RUNNER=1', 128, 552, palette.cyan);
    const yes = ['TYPED FIXTURE DENIAL', 'ZERO WORKER DISPATCH', 'EXACT SINK COMMIT RECEIPT', 'SAME-AGENT SAFE CONTINUITY', 'RAW BYPASS ROLLED BACK'];
    const no = ['NO MODEL-BACKED INTENT CLAIM', 'NO OS CONFINEMENT CLAIM', 'NO AMBIENT-FS REMOVAL', 'NO TIKTOK DATA OR ACCESS', 'NO CLOUD PERFORMANCE CLAIM'];
    for (let i = 0; i < yes.length; i += 1) label(canvas, `+ ${yes[i]}`, 130, 612 + i * 44, palette.ink);
    label(canvas, 'NOT MEASURED', 992, 552, palette.coral);
    for (let i = 0; i < no.length; i += 1) label(canvas, `- ${no[i]}`, 994, 612 + i * 44, palette.muted);
    footer(canvas, 'EVIDENCE IS STRONGER WHEN ITS EDGE IS VISIBLE.');
  } else if (scene.id === '12-close') {
    canvas.circle(300, 500, 180, palette.cyanDim, false, 2);
    canvas.circle(300, 500, 112, palette.cyan, false, 4);
    canvas.line(242, 560, 242, 440, palette.cyan, 12);
    canvas.line(242, 440, 358, 560, palette.cyan, 12);
    canvas.line(358, 560, 358, 440, palette.coral, 12);
    label(canvas, 'NERVELOOP', 610, 255, palette.cyan);
    headline(canvas, ['INTENT IS', 'NOT AUTHORITY.'], 610, 324, 13, palette.ink, 128);
    drawText(canvas, 'GIVE AUTONOMOUS ENGINEERS', 610, 650, 5, palette.muted, {spacing: 5});
    drawText(canvas, 'A NERVOUS SYSTEM.', 610, 720, 7, palette.coral, {spacing: 7, glow: true});
    drawNeuralLine(canvas, 610, 1660, 870, palette.cyan, 20, 10);
    footer(canvas, 'TIKTOK TECHJAM 2026 / TRACK #1 / LIGHTWEIGHT AGENT MIDDLEWARE.');
  } else {
    throw new Error(`No procedural plate renderer for ${scene.id}`);
  }
  return canvas;
}

export function writeStoryStill() {
  const bytes = png(renderPlate(4));
  mkdirSync(dirname(storyStillPath), {recursive: true});
  writeFileSync(storyStillPath, bytes);
  return {
    path: relative(repository, storyStillPath),
    sha256: shaBytes(bytes),
    sceneId: scenes[4].id,
    generatedBy: relative(repository, scriptPath),
    imported: false,
  };
}

function pulseImage(color) {
  const size = 48;
  const canvas = new Canvas(size, size);
  canvas.data.fill(0);
  for (let radius = 22; radius >= 3; radius -= 2) {
    const alpha = Math.max(3, Math.round((1 - radius / 24) * 30));
    canvas.circle(size / 2, size / 2, radius, [...color.slice(0, 3), alpha], true);
  }
  canvas.circle(size / 2, size / 2, 5, [...color.slice(0, 3), 255], true);
  canvas.circle(size / 2, size / 2, 10, [...color.slice(0, 3), 170], false, 2);
  return canvas;
}

function writeWav(path, durationSeconds, eventTimes) {
  const frames = Math.ceil(durationSeconds * SAMPLE_RATE);
  const bytesPerFrame = 4;
  const data = Buffer.alloc(frames * bytesPerFrame);
  let randomState = 0x4e455256;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 0xffffffff * 2 - 1;
  };
  const softClip = value => Math.tanh(value * 1.25) / 1.25;
  for (let frame = 0; frame < frames; frame += 1) {
    const t = frame / SAMPLE_RATE;
    const breath = 0.38 + 0.62 * (0.5 + 0.5 * Math.sin(Math.PI * 2 * 0.026 * t));
    const drone = 0.052 * Math.sin(Math.PI * 2 * 55 * t) + 0.028 * Math.sin(Math.PI * 2 * 82.5 * t + 0.4);
    const shimmer = 0.009 * Math.sin(Math.PI * 2 * (330 + 12 * Math.sin(t * 0.09)) * t);
    let events = 0;
    for (const event of eventTimes) {
      const delta = t - event;
      if (delta >= 0 && delta < 1.6) {
        const envelope = Math.exp(-delta * 3.4);
        events += 0.075 * envelope * Math.sin(Math.PI * 2 * (118 - delta * 24) * delta);
      }
      const approach = event - t;
      if (approach > 0 && approach < 1.1) events += 0.012 * (1 - approach / 1.1) * Math.sin(Math.PI * 2 * 440 * t);
    }
    const noise = random() * 0.006 * breath;
    const left = softClip((drone * breath + shimmer + events + noise) * 2.5);
    const right = softClip((drone * breath + shimmer * 0.86 + events * 0.92 - noise * 0.45) * 2.5);
    data.writeInt16LE(Math.round(left * 32767), frame * bytesPerFrame);
    data.writeInt16LE(Math.round(right * 32767), frame * bytesPerFrame + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * bytesPerFrame, 28);
  header.writeUInt16LE(bytesPerFrame, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

function sourceBindings() {
  return sources.map(source => {
    const absolute = join(repository, source.path);
    assertRegular(absolute, source.role);
    return {...source, sha256: sha256(absolute)};
  });
}

function storyDigest() {
  return shaText(JSON.stringify({
    schemaVersion: 'nerveloop.effect-firewall-candidate-story.v3',
    scenes,
    frameRate,
    transitionSeconds,
    editorialArc: [
      'human incident',
      'typed proposal',
      'monotone host gate',
      'pre-dispatch denial receipt',
      'same-Agent later-safe retention',
      'separate RunGuard rollback',
      'six-round KPI',
      'finite adversarial matrix',
      'honest proof boundary',
    ],
  }));
}

function validateEvidenceContracts() {
  const functional = JSON.parse(readFileSync(join(repository, sources[0].path), 'utf8'));
  assert.equal(functional.schemaVersion, 'nerveloop.track-c-functional-flow.v3');
  assert.equal(functional.verdict, 'PASS');
  const denied = functional.sequence.effectFirewallDeniedRun;
  assert.equal(denied.effectDecision.action, 'delete_mock_asset');
  assert.equal(denied.effectDecision.targetClass, 'protected');
  assert.equal(denied.effectDecision.workerSpawned, false);
  assert.equal(denied.effectDecision.protectedBaselineVerifiedUnchanged, true);
  assert.equal(denied.recovery, 'not_needed');
  assert.equal(denied.effectCapability, null);
  assert.equal(denied.effectSinkReceipt, null);
  assert.deepEqual(denied.changedFiles, []);
  assert.equal(denied.beforeManifestDigest, denied.afterManifestDigest);
  assert.equal(functional.sequence.laterFreshSafeRun.status, 'completed');
  assert.equal(functional.sequence.laterFreshSafeRun.guardVerdict, 'retained');
  assert.equal(functional.sequence.postRunMaliciousRun.recovery, 'rolled_back');
  const normalSink = functional.sequence.normalRun.effectSinkReceipt;
  const maliciousSink = functional.sequence.postRunMaliciousRun.effectSinkReceipt;
  const laterSink = functional.sequence.laterFreshSafeRun.effectSinkReceipt;
  assert.equal(normalSink.state, 'committed');
  assert.equal(normalSink.relativePath, 'demo-result.md');
  assert.equal(maliciousSink.state, 'revoked');
  assert.equal(maliciousSink.closeDisposition, 'unredeemed');
  assert.equal(maliciousSink.errorCode, 'EFFECT_SINK_CLOSED');
  assert.equal(laterSink.state, 'committed');
  assert.equal(laterSink.relativePath, 'demo-result.md');
  for (const sink of [normalSink, maliciousSink, laterSink]) {
    assert.equal(Object.hasOwn(sink, 'grant'), false, 'persisted sink receipt must not contain the opaque grant');
  }
  for (const run of [
    functional.sequence.normalRun,
    functional.sequence.postRunMaliciousRun,
    functional.sequence.laterFreshSafeRun,
  ]) {
    assert.equal(run.effectCapability.registry, 'process-local');
    assert.equal(run.effectCapability.state, 'consumed');
    assert.equal(run.effectCapability.runId, run.runId);
    assert.equal(run.effectCapability.action, 'write_demo_result');
    assert.equal(run.effectCapability.targetClass, 'workspace');
    assert.equal(run.effectCapability.useBudget, 1);
    assert.equal(run.effectCapability.usesClaimed, 1);
  }
  assert.equal(new Set([
    functional.sequence.normalRun.effectCapability.grantId,
    functional.sequence.postRunMaliciousRun.effectCapability.grantId,
    functional.sequence.laterFreshSafeRun.effectCapability.grantId,
  ]).size, 3);
  assert.equal(functional.sequence.protectedState.bytesIdenticalAtEnd, true);
  assert.equal(functional.proofBoundary.modelExecuted, false);
  assert.equal(functional.proofBoundary.providerCalls, false);

  const benchmark = JSON.parse(readFileSync(join(repository, sources[1].path), 'utf8'));
  assert.equal(benchmark.schemaVersion, 3);
  assert.equal(benchmark.status, 'COMPLETE');
  assert.equal(benchmark.configuration.rounds, 6);
  const reset = benchmark.conditions.resetAllBaseline;
  const firewall = benchmark.conditions.effectFirewall;
  const guard = benchmark.conditions.runGuardRollback;
  assert.deepEqual([
    reset.threatDetectionRate.value,
    firewall.threatDetectionRate.value,
    guard.threatDetectionRate.value,
  ], [0, 1, 1]);
  assert.deepEqual([
    reset.threatWorkerDispatchRate.value,
    firewall.threatWorkerDispatchRate.value,
    guard.threatWorkerDispatchRate.value,
  ], [1, 0, 1]);
  assert.deepEqual([
    reset.laterSafeRunRetentionRate.value,
    firewall.laterSafeRunRetentionRate.value,
    guard.laterSafeRunRetentionRate.value,
  ], [0, 1, 1]);
  assert.deepEqual([
    reset.threatLogicalRecoveryTargets.value.p50,
    firewall.threatLogicalRecoveryTargets.value.p50,
    guard.threatLogicalRecoveryTargets.value.p50,
  ], [32, 0, 1]);

  const adversarial = JSON.parse(readFileSync(join(repository, sources[2].path), 'utf8'));
  assert.equal(adversarial.verdict, 'PASS');
  assert.equal(adversarial.results.lattice.totalCells, 20);
  assert.equal(adversarial.results.lattice.falseAllows, 0);
  assert.equal(adversarial.results.lattice.falseDenies, 0);
  assert.equal(adversarial.results.lattice.reasonMismatches, 0);
  assert.equal(adversarial.results.monotonicity.comparableRelationsChecked, 130);
  assert.equal(adversarial.results.monotonicity.violations.length, 0);
  assert.equal(adversarial.results.malformed.total, 30);
  assert.equal(adversarial.results.malformed.rejected, 30);
  assert.equal(adversarial.results.mutations.total, 20);
  assert.equal(adversarial.results.mutations.killed, 20);
  assert.equal(adversarial.results.mutations.scorePercent, 100);
  return {functional, benchmark, adversarial};
}

function mediaContract(path) {
  const media = probe(path);
  const video = media.streams.find(stream => stream.codec_type === 'video');
  const audio = media.streams.find(stream => stream.codec_type === 'audio');
  assert.ok(video, 'Candidate is missing a video stream');
  assert.ok(audio, 'Candidate is missing an audio stream');
  const durationSeconds = Number(media.format.duration);
  assert.equal(video.codec_name, 'h264');
  assert.equal(video.width, WIDTH);
  assert.equal(video.height, HEIGHT);
  assert.equal(video.pix_fmt, 'yuv420p');
  assert.equal(audio.codec_name, 'aac');
  assert.equal(Number(audio.sample_rate), SAMPLE_RATE);
  assert.equal(audio.channels, 2);
  assert.ok(durationSeconds > 1 && durationSeconds <= 175, `Candidate duration ${durationSeconds} exceeds contract`);
  return {
    durationSeconds,
    video: {
      codec: video.codec_name,
      width: video.width,
      height: video.height,
      pixelFormat: video.pix_fmt,
      frameRate: video.avg_frame_rate,
    },
    audio: {
      codec: audio.codec_name,
      sampleRate: Number(audio.sample_rate),
      channels: audio.channels,
    },
  };
}

function extractSampleHashes(videoPath, times) {
  const directory = mkdtempSync(join(tmpdir(), 'nerveloop-effect-samples-'));
  try {
    return times.map((timeSeconds, index) => {
      const output = join(directory, `sample-${String(index + 1).padStart(2, '0')}.png`);
      run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-ss', timeSeconds.toFixed(3), '-i', videoPath,
        '-frames:v', '1', '-vf', 'scale=960:540:flags=lanczos', output,
      ], {timeout: 60_000});
      return {timeSeconds, sha256: sha256(output)};
    });
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}

export function validateCandidateInputs() {
  assertRegular(stableFallbackPath, 'stable 159-second fallback');
  assertRegular(scriptPath, 'candidate renderer');
  assertRegular(storyStillPath, 'procedural story still');
  assertRegular(fontPath, 'vendored public-domain bitmap font');
  assert.equal(sha256(fontPath), FONT_HEADER_SHA256, 'vendored bitmap font hash mismatch');
  const fontSource = readFileSync(fontPath, 'utf8');
  assert.match(fontSource, /Author: Daniel Hepper/);
  assert.match(fontSource, /License: Public Domain/);
  const expectedStoryStillSha256 = shaBytes(png(renderPlate(4)));
  assert.equal(sha256(storyStillPath), expectedStoryStillSha256, 'procedural story still is stale or not renderer-generated');
  assert.ok(scenes.every(scene => !Object.hasOwn(scene, 'asset')), 'All scenes must be procedural; imported assets are forbidden');
  for (const binary of ['ffmpeg', 'ffprobe', process.execPath]) run(binary, binary === process.execPath ? ['--version'] : ['-version'], {timeout: 15_000});
  const stable = {path: relative(repository, stableFallbackPath), sha256: sha256(stableFallbackPath)};
  const evidence = validateEvidenceContracts();
  const bindings = sourceBindings();
  const nominalDuration = scenes.reduce((sum, scene) => sum + scene.duration, 0) - transitionSeconds * (scenes.length - 1);
  assert.ok(nominalDuration <= 175);
  return {
    schemaVersion: 'nerveloop.effect-firewall-provenance-cleared-preflight.v1',
    output: relative(repository, candidatePath),
    receipt: relative(repository, receiptPath),
    nominalDurationSeconds: nominalDuration,
    dimensions: `${WIDTH}x${HEIGHT}`,
    frameRate,
    scenes: scenes.length,
    transitionSeconds,
    rendering: 'procedural Node PNG plates + vendored upstream-declared public-domain font8x8 glyphs + local ffmpeg motion, xfade, H.264, and deterministic sound bed',
    voice: 'none',
    externalCalls: 0,
    modelCalls: 0,
    sourceBindings: bindings,
    releaseAssets: {
      storyStill: {
        path: relative(repository, storyStillPath),
        sha256: expectedStoryStillSha256,
        sceneId: scenes[4].id,
        generatedBy: relative(repository, scriptPath),
        imported: false,
      },
    },
    storyContractSha256: storyDigest(),
    stableFallback: stable,
    observedEvidence: {
      functionalVerdict: evidence.functional.verdict,
      benchmarkRounds: evidence.benchmark.configuration.rounds,
      adversarialVerdict: evidence.adversarial.verdict,
    },
  };
}

function renderScene(scene, index, directory, pulsePaths) {
  const sourcePath = join(directory, `${scene.id}.png`);
  writeFileSync(sourcePath, png(renderPlate(index)), {flag: 'wx'});
  const clipPath = join(directory, `${scene.id}.mp4`);
  const pulsePath = pulsePaths[scene.accent] ?? pulsePaths.cyan;
  const zoomIncrement = index % 2 === 0 ? '0.00010' : '0.000075';
  const frameCount = scene.duration * frameRate;
  const panX = index % 2 === 0
    ? `(iw-iw/zoom)*on/${frameCount}`
    : `(iw-iw/zoom)*(1-on/${frameCount})`;
  const baseFilter = `[0:v]zoompan=z='min(zoom+${zoomIncrement},1.045)':x='${panX}':y='(ih-ih/zoom)*(0.46+0.02*sin(on/36))':d=1:s=1920x1080:fps=${frameRate}[base]`;
  const filters = [baseFilter];
  let outputLabel = 'base';
  if (scene.pulse) {
    // Keep continuous motion attached to the visual system: both nodes travel
    // on the masthead divider, never across evidence copy or diagrams.
    const startX = 80;
    const endX = 1840;
    const y = 92;
    const motionDuration = Math.max(3.2, Math.min(4.8, scene.duration * 0.36)).toFixed(3);
    const halfCycle = (Number(motionDuration) / 2).toFixed(3);
    filters.push('[1:v]format=rgba,split=2[pulseLead][pulseGhostRaw]');
    filters.push('[pulseGhostRaw]colorchannelmixer=aa=0.22[pulseGhost]');
    filters.push(`[base][pulseLead]overlay=x='${startX}-24+(${endX - startX})*mod(t,${motionDuration})/${motionDuration}':y='${y}-24':eval=frame:shortest=1[motionLead]`);
    filters.push(`[motionLead][pulseGhost]overlay=x='${endX}-24-(${endX - startX})*mod(t+${halfCycle},${motionDuration})/${motionDuration}':y='${y}-24':eval=frame:shortest=1[motion]`);
    outputLabel = 'motion';
  }
  const fadeOut = Math.max(0, scene.duration - 0.35).toFixed(3);
  filters.push(`[${outputLabel}]fade=t=in:st=0:d=0.25,fade=t=out:st=${fadeOut}:d=0.35,format=yuv420p[out]`);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-loop', '1', '-framerate', String(frameRate), '-i', sourcePath,
  ];
  if (scene.pulse) args.push('-loop', '1', '-framerate', String(frameRate), '-i', pulsePath);
  args.push(
    '-filter_complex', filters.join(';'), '-map', '[out]', '-t', String(scene.duration),
    '-an', '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-crf', '16',
    '-pix_fmt', 'yuv420p', '-r', String(frameRate), '-g', String(frameRate * 2),
    '-map_metadata', '-1', '-metadata', 'creation_time=1970-01-01T00:00:00Z', clipPath,
  );
  run('ffmpeg', args, {timeout: 300_000});
  return {path: clipPath, sourcePath, sourceSha256: sha256(sourcePath), clipSha256: sha256(clipPath)};
}

function assemble(clips, audioPath, outputPath) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  for (const clip of clips) args.push('-i', clip.path);
  args.push('-i', audioPath);
  const filters = clips.map((_clip, index) => `[${index}:v]settb=AVTB[v${index}]`);
  let previous = 'v0';
  let cumulative = scenes[0].duration;
  for (let index = 1; index < clips.length; index += 1) {
    const next = `x${index}`;
    const offset = cumulative - transitionSeconds * index;
    filters.push(`[${previous}][v${index}]xfade=transition=fade:duration=${transitionSeconds}:offset=${offset.toFixed(3)}[${next}]`);
    previous = next;
    cumulative += scenes[index].duration;
  }
  filters.push(`[${previous}]format=yuv420p[video]`);
  args.push(
    '-filter_complex', filters.join(';'), '-map', '[video]', '-map', `${clips.length}:a`,
    '-c:v', 'libx264', '-threads', '1', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-r', String(frameRate), '-g', String(frameRate * 2),
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(SAMPLE_RATE), '-ac', '2',
    '-movflags', '+faststart', '-map_metadata', '-1',
    '-metadata', 'title=NerveLoop / Effect Firewall',
    '-metadata', 'comment=Local deterministic candidate. No model, provider, TikTok, deployment, upload, or submission claim.',
    '-metadata', 'creation_time=1970-01-01T00:00:00Z', '-shortest', outputPath,
  );
  run('ffmpeg', args, {timeout: 900_000});
}

function sceneTimeline() {
  const output = [];
  let cursor = 0;
  for (const [index, scene] of scenes.entries()) {
    output.push({id: scene.id, startsAtSeconds: Number(cursor.toFixed(3)), durationSeconds: scene.duration});
    cursor += scene.duration - (index === scenes.length - 1 ? 0 : transitionSeconds);
  }
  return output;
}

export function renderCandidate() {
  const preflight = validateCandidateInputs();
  const stableBefore = {
    sha256: sha256(stableFallbackPath),
    size: statSync(stableFallbackPath).size,
    mtimeMs: statSync(stableFallbackPath).mtimeMs,
  };
  const workspace = mkdtempSync(join(tmpdir(), 'nerveloop-effect-candidate-'));
  const stagedVideo = join(workspace, 'candidate.mp4');
  try {
    const pulsePaths = {};
    for (const accent of ['cyan', 'coral', 'amber']) {
      const path = join(workspace, `pulse-${accent}.png`);
      writeFileSync(path, png(pulseImage(palette[accent])), {flag: 'wx'});
      pulsePaths[accent] = path;
    }
    const clips = scenes.map((scene, index) => renderScene(scene, index, workspace, pulsePaths));
    const timeline = sceneTimeline();
    const duration = timeline.at(-1).startsAtSeconds + timeline.at(-1).durationSeconds;
    const audioPath = join(workspace, 'sound-bed.wav');
    writeWav(audioPath, duration + 0.25, timeline.slice(1).map(scene => scene.startsAtSeconds));
    assemble(clips, audioPath, stagedVideo);
    const media = mediaContract(stagedVideo);
    const sampleTimes = [3, 24, 48, 70, 96, 119, Math.max(1, media.durationSeconds - 3)];
    const sampleFrames = extractSampleHashes(stagedVideo, sampleTimes);
    const stableAfter = {
      sha256: sha256(stableFallbackPath),
      size: statSync(stableFallbackPath).size,
      mtimeMs: statSync(stableFallbackPath).mtimeMs,
    };
    assert.deepEqual(stableAfter, stableBefore, 'Stable fallback bytes or metadata changed during candidate render');
    mkdirSync(dirname(candidatePath), {recursive: true});
    renameSync(stagedVideo, candidatePath);
    const storyStill = writeStoryStill();
    const receipt = {
      schemaVersion: 'nerveloop.effect-firewall-provenance-cleared-candidate.v1',
      kind: 'local-source-bound-procedural-effect-firewall-candidate',
      officialTrack: 'Track #1: Agent Launchpad: Design and Build Lightweight Agent Middleware',
      video: {
        path: relative(repository, candidatePath),
        sha256: sha256(candidatePath),
        sizeBytes: statSync(candidatePath).size,
      },
      media,
      rendering: {
        backend: 'procedural Node PNG plates, parsed font8x8 bitmap glyphs, cyclic masthead neural rail, deterministic PCM sound bed, and local ffmpeg',
        motionDesign: 'directional zoom/pan, repeating counterflow nodes constrained to the masthead divider, and cross-scene fades',
        frameRate,
        transitionSeconds,
        importedScreenshots: 0,
        importedImages: 0,
        systemFontResolution: false,
        bitmapFont: {
          path: relative(repository, fontPath),
          sha256: sha256(fontPath),
          upstreamCommit: FONT_UPSTREAM_COMMIT,
          upstreamDeclaration: 'Public Domain',
          declarationIndependentlyAdjudicated: false,
        },
        voice: 'none',
        realPersonVoice: false,
        externalCalls: 0,
        paidServices: 0,
      },
      storyContractSha256: preflight.storyContractSha256,
      scenes: timeline,
      sampleFrames,
      sourceBindings: preflight.sourceBindings,
      releaseAssets: {storyStill},
      renderScript: {path: relative(repository, scriptPath), sha256: sha256(scriptPath)},
      stableFallback: {
        path: relative(repository, stableFallbackPath),
        sha256Before: stableBefore.sha256,
        sha256After: stableAfter.sha256,
        sizeBefore: stableBefore.size,
        sizeAfter: stableAfter.size,
        unchanged: true,
        overwritten: false,
      },
      observedClaims: {
        enforcementMode: 'DEMO_RUNNER=1 fixed local fixture path',
        typedIncident: 'delete_mock_asset / protected',
        preDispatchReceipt: 'workerSpawned false; changedFiles []; recovery not_needed; before manifest equals after manifest',
        sameAgentContinuity: 'later safe fixture completed and was retained',
        sinkLifecycle: 'normal committed; protected denial no grant; malicious unredeemed grant revoked EFFECT_SINK_CLOSED; later safe committed; no opaque grant persisted',
        defenseInDepth: 'separate raw ambient-filesystem bypass fixture dispatched, was denied by RunGuard, and rolled back',
        benchmark: 'six local rounds; recovery-target p50 reset/effect/RunGuard = 32/0/1',
        adversarial: '20 lattice cells, 130 comparable relations, 30 malformed proposals, 20 deterministic mutants',
      },
      proofBoundary: {
        localOnly: true,
        deterministicFixture: true,
        demoRunnerModeRequired: true,
        modelCalls: 0,
        providerCalls: 0,
        hardenedSandboxClaim: false,
        ambientFilesystemAuthorityRemovedClaim: false,
        productionSecurityClaim: false,
        tiktokAccessClaim: false,
        publicUploadClaim: false,
        devpostSubmissionClaim: false,
      },
    };
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    const verified = verifyCandidateReceipt({root: repository, videoPath: candidatePath, sidecarPath: receiptPath});
    return {receipt, verified};
  } finally {
    rmSync(workspace, {recursive: true, force: true});
  }
}

export function verifyCandidateReceipt({root = repository, videoPath = candidatePath, sidecarPath = receiptPath} = {}) {
  assertRegular(videoPath, 'candidate video');
  assertRegular(sidecarPath, 'candidate sidecar');
  const receipt = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  assert.equal(receipt.schemaVersion, 'nerveloop.effect-firewall-provenance-cleared-candidate.v1', 'candidate sidecar schema mismatch');
  assert.equal(receipt.video.path, relative(root, videoPath), 'candidate sidecar video path mismatch');
  assert.equal(receipt.video.sha256, sha256(videoPath), 'candidate video hash mismatch');
  assert.equal(receipt.video.sizeBytes, statSync(videoPath).size, 'candidate video size mismatch');
  const expectedStoryDigest = storyDigest();
  assert.equal(receipt.storyContractSha256, expectedStoryDigest, 'candidate story contract is stale');
  assert.equal(receipt.renderScript.path, relative(root, scriptPath), 'candidate render script path mismatch');
  assert.equal(receipt.renderScript.sha256, sha256(scriptPath), 'candidate render script hash mismatch');
  assert.equal(receipt.rendering.importedScreenshots, 0);
  assert.equal(receipt.rendering.importedImages, 0);
  assert.equal(receipt.rendering.systemFontResolution, false);
  assert.equal(receipt.rendering.bitmapFont.path, relative(root, fontPath));
  assert.equal(receipt.rendering.bitmapFont.sha256, sha256(fontPath));
  assert.equal(receipt.rendering.bitmapFont.upstreamCommit, FONT_UPSTREAM_COMMIT);
  assert.equal(receipt.rendering.bitmapFont.upstreamDeclaration, 'Public Domain');
  assert.equal(receipt.rendering.bitmapFont.declarationIndependentlyAdjudicated, false);
  assert.deepEqual(receipt.releaseAssets?.storyStill, {
    path: relative(root, storyStillPath),
    sha256: sha256(storyStillPath),
    sceneId: scenes[4].id,
    generatedBy: relative(root, scriptPath),
    imported: false,
  });
  assert.equal(
    receipt.releaseAssets.storyStill.sha256,
    shaBytes(png(renderPlate(4))),
    'procedural story still does not match a fresh renderer export',
  );
  assert.equal(receipt.scenes.length, scenes.length, 'candidate scene count mismatch');
  assert.deepEqual(receipt.scenes, sceneTimeline(), 'candidate scene timeline mismatch');
  const expectedBindings = sourceBindings();
  assert.equal(receipt.sourceBindings.length, expectedBindings.length, 'candidate source binding count mismatch');
  for (const [index, expected] of expectedBindings.entries()) {
    const observed = receipt.sourceBindings[index];
    assert.equal(observed.path, expected.path, `candidate source binding path mismatch at ${index}`);
    assert.equal(observed.role, expected.role, `candidate source binding role mismatch for ${expected.path}`);
    assert.equal(observed.sha256, expected.sha256, `candidate source binding is stale or tampered: ${expected.path}`);
  }
  assert.equal(receipt.stableFallback.path, relative(root, stableFallbackPath));
  assert.equal(receipt.stableFallback.sha256Before, sha256(stableFallbackPath), 'stable fallback before hash mismatch');
  assert.equal(receipt.stableFallback.sha256After, sha256(stableFallbackPath), 'stable fallback after hash mismatch');
  assert.equal(receipt.stableFallback.unchanged, true);
  assert.equal(receipt.stableFallback.overwritten, false);
  assert.deepEqual(receipt.proofBoundary, {
    localOnly: true,
    deterministicFixture: true,
    demoRunnerModeRequired: true,
    modelCalls: 0,
    providerCalls: 0,
    hardenedSandboxClaim: false,
    ambientFilesystemAuthorityRemovedClaim: false,
    productionSecurityClaim: false,
    tiktokAccessClaim: false,
    publicUploadClaim: false,
    devpostSubmissionClaim: false,
  });
  const media = mediaContract(videoPath);
  assert.equal(Number(media.durationSeconds.toFixed(3)), Number(receipt.media.durationSeconds.toFixed(3)), 'candidate duration mismatch');
  assert.deepEqual(media.video, receipt.media.video);
  assert.deepEqual(media.audio, receipt.media.audio);
  const freshSamples = extractSampleHashes(videoPath, receipt.sampleFrames.map(sample => sample.timeSeconds));
  assert.deepEqual(freshSamples, receipt.sampleFrames, 'candidate sample frames are stale or tampered');
  return {
    passed: true,
    videoSha256: receipt.video.sha256,
    durationSeconds: media.durationSeconds,
    dimensions: `${media.video.width}x${media.video.height}`,
    videoCodec: media.video.codec,
    audioCodec: media.audio.codec,
    sourceBindings: receipt.sourceBindings.length,
    sampleFrames: receipt.sampleFrames.length,
    stableFallbackUnchanged: true,
    proofBoundary: receipt.proofBoundary,
  };
}

async function main() {
  if (process.argv.includes('--write-story-still')) {
    console.log(JSON.stringify(writeStoryStill(), null, 2));
    return;
  }
  if (process.argv.includes('--validate-only')) {
    console.log(JSON.stringify(validateCandidateInputs(), null, 2));
    return;
  }
  if (process.argv.includes('--verify-only')) {
    console.log(JSON.stringify(verifyCandidateReceipt(), null, 2));
    return;
  }
  const result = renderCandidate();
  console.log(JSON.stringify(result.verified, null, 2));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
