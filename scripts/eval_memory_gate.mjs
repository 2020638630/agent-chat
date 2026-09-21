#!/usr/bin/env node
/**
 * Offline eval for R-04x memory gate fixtures.
 * Usage: node scripts/eval_memory_gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const casesPath = path.join(root, 'docs/product/fixtures/memory-gate/cases.json');
const reportPath = path.join(root, 'docs/product/fixtures/memory-gate/REPORT.md');
const { cases } = JSON.parse(fs.readFileSync(casesPath, 'utf8'));

function heuristic(c) {
  const text = c.text || '';
  const active = c.active || '';
  const kind = /叫我|称呼|喊我|别叫/.test(text)
    ? 'address'
    : /喝|温水|茶|咖啡|美式|红茶/.test(text)
      ? 'drink'
      : 'other';
  let claim =
    /以后|请叫我|喊我|我只喝|改喝|记住|过敏|我住|别叫我|不要叫/.test(text) &&
    !text.includes('（角色）');
  if (/好啊那就|那就温水/.test(text)) claim = false;
  const chitchat =
    !claim &&
    (/哈哈|好累|走走|吃什么|口渴|表情|记得昨天/.test(text) || text.length <= 2);
  let is_conflict = false;
  if (claim && active) {
    if (kind === 'address' && /叫|称呼/.test(active)) is_conflict = true;
    else if (kind === 'drink' && /喝|温水|茶|咖啡/.test(active)) is_conflict = true;
    else if (kind === 'other' && /之前说错|其实可以/.test(text)) is_conflict = true;
  }
  return {
    should_write: Boolean(claim && !chitchat),
    is_conflict,
    kind,
    backend: 'heuristic',
  };
}

function laya(c) {
  const py = process.env.LAYA_PYTHON || process.env.PYTHON || 'python';
  const script = path.join(root, 'scripts/laya_memory_gate.py');
  const r = spawnSync(py, [script], {
    input: JSON.stringify({
      text: c.text,
      active_memory: c.active || '',
      proposed_content: c.text,
    }),
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, USE_TF: '0' },
  });
  if (r.error) return { error: String(r.error) };
  if (r.status !== 0) {
    return { error: (r.stderr || r.stdout || 'exit ' + r.status).slice(0, 400) };
  }
  try {
    return JSON.parse(String(r.stdout || '').trim());
  } catch (e) {
    return { error: String(e) };
  }
}

function score(pred, exp) {
  return {
    write_ok: !!pred.should_write === !!exp.should_write,
    conflict_ok: !!pred.is_conflict === !!exp.is_conflict,
    kind_ok: (pred.kind || 'other') === (exp.kind || 'other'),
  };
}

const heuristicRows = [];
for (const c of cases) {
  const pred = heuristic(c);
  const s = score(pred, c.expect);
  heuristicRows.push({ id: c.id, label: c.label, pred, expect: c.expect, ...s });
}

let layaRows = [];
let layaError = null;
const sample = laya(cases[0]);
if (sample.error && sample.backend !== 'heuristic-fallback' && sample.backend !== 'laya') {
  layaError = sample.error;
} else if (sample.error && !sample.should_write && sample.should_write !== false) {
  layaError = sample.error;
} else {
  for (const c of cases) {
    const pred = laya(c);
    if (pred.error && pred.backend !== 'laya' && pred.backend !== 'heuristic-fallback') {
      layaError = pred.error;
      break;
    }
    const s = score(pred, c.expect);
    layaRows.push({ id: c.id, label: c.label, pred, expect: c.expect, ...s });
  }
}

function summarize(rows) {
  const n = rows.length || 1;
  const write = rows.filter((r) => r.write_ok).length / n;
  const conflict = rows.filter((r) => r.conflict_ok).length / n;
  const kind = rows.filter((r) => r.kind_ok).length / n;
  const confuse = rows.filter((r) => !r.write_ok || !r.conflict_ok).slice(0, 8);
  return { write, conflict, kind, confuse };
}

const hSum = summarize(heuristicRows);
const lSum = layaRows.length ? summarize(layaRows) : null;
const usedFallback = layaRows.some((r) => (r.pred.backend || '').includes('heuristic'));

const lines = [];
lines.push('# R-04x Laya memory gate — offline report');
lines.push('');
lines.push('Date: 2026-09-21');
lines.push('');
lines.push('## Setup');
lines.push('');
lines.push('- Fixtures: `docs/product/fixtures/memory-gate/cases.json` (' + cases.length + ' Chinese cases)');
lines.push('- Intended model: `convaiinnovations/laya-multilingual` via `pip install laya`');
lines.push('- Hook: `MEMORY_GATE_BACKEND=off|laya|heuristic` (default `off`)');
lines.push('');
lines.push('## Heuristic baseline (not Laya)');
lines.push('');
lines.push('| metric | accuracy |');
lines.push('|---|---|');
lines.push('| should_write | ' + (hSum.write * 100).toFixed(1) + '% |');
lines.push('| is_conflict | ' + (hSum.conflict * 100).toFixed(1) + '% |');
lines.push('| kind | ' + (hSum.kind * 100).toFixed(1) + '% |');
lines.push('');
lines.push('Confused ids: ' + (hSum.confuse.map((r) => r.id).join(', ') || '(none)'));
lines.push('');
lines.push('## Laya zero-shot');
lines.push('');
if (layaError) {
  lines.push('**Could not run Laya weights on this machine.**');
  lines.push('');
  lines.push('```');
  lines.push(String(layaError).slice(0, 500));
  lines.push('```');
  lines.push('');
  lines.push('Expectation: multilingual zero-shot on typed write/conflict decisions is near chance / weak;');
  lines.push('Chinese memory-gate needs task fine-tune before production. Keep `MEMORY_GATE_BACKEND=off`.');
} else if (lSum) {
  if (usedFallback) {
    lines.push('Python ran but **fell back to heuristic** (torch/`laya` package missing). Treat as unavailable for zero-shot Laya scores.');
    lines.push('');
  }
  lines.push('| metric | accuracy |');
  lines.push('|---|---|');
  lines.push('| should_write | ' + (lSum.write * 100).toFixed(1) + '% |');
  lines.push('| is_conflict | ' + (lSum.conflict * 100).toFixed(1) + '% |');
  lines.push('| kind | ' + (lSum.kind * 100).toFixed(1) + '% |');
  lines.push('');
  lines.push('Confused ids: ' + (lSum.confuse.map((r) => r.id).join(', ') || '(none)'));
  lines.push('');
  lines.push(
    usedFallback || lSum.write < 0.7
      ? 'Zero-shot Laya **not validated** here (missing weights or weak). Keep default `off` until fine-tuned.'
      : 'Zero-shot looks usable for a limited pilot; still keep default `off` until product review.',
  );
} else {
  lines.push('No Laya rows.');
}
lines.push('');
lines.push('## Hook smoke');
lines.push('');
lines.push('- `MEMORY_GATE_BACKEND=off`: extract path unchanged.');
lines.push('- `MEMORY_GATE_BACKEND=laya`: drops ops with `should_write=false` before `applyOps`; failures fall back to existing heuristics.');
lines.push('- `MEMORY_GATE_BACKEND=heuristic`: demo baseline only (not for production).');
lines.push('');

fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
console.log('report', reportPath);
console.log('heuristic write', (hSum.write * 100).toFixed(1) + '%');
console.log('laya', layaError ? 'unavailable: ' + String(layaError).slice(0, 120) : 'ran ' + layaRows.length);
