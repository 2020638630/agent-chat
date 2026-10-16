import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, buildNowContextLine, injectNowContext, resolveUserLocation } from './promptInject.js';
import { formatPresenceLine, resolvePresence } from './presence.js';

const at = '2026-10-16T11:00:00.000Z'; // 19:00 北京 → 傍晚
const ch = { presence: JSON.stringify({ evening: { place: '书房', activity: '看书' } }) };

test('presence line injected right after now line', () => {
  const line = formatPresenceLine(resolvePresence(ch, at));
  const out = injectNowContext('SYS', at, '上海', line);
  const lines = out.split('\n');
  assert.equal(lines[0], buildNowContextLine(at, '上海'));
  assert.equal(lines[1], '你此刻：在书房，看书（傍晚）');
  assert.equal(lines[2], '');
  assert.equal(lines[3], 'SYS');
});

test('no presence config / empty slot → identical to W-01 output', () => {
  const w01 = injectNowContext('SYS', at, '上海');
  assert.equal(injectNowContext('SYS', at, '上海', formatPresenceLine(resolvePresence({ presence: null }, at))), w01);
  assert.equal(injectNowContext('SYS', at, '上海', formatPresenceLine(resolvePresence({ presence: { night: { place: '阳台' } } }, at))), w01);
  assert.ok(!w01.includes('你此刻'));
});

test('budget too small → whole presence line dropped, now line kept', () => {
  const nowLine = buildNowContextLine(at, '上海');
  const line = '你此刻：在书房，看书（傍晚）';
  const tight = estimateTokens(nowLine) + estimateTokens(line) - 1;
  const out = injectNowContext('SYS', at, '上海', line, tight);
  assert.equal(out, `${nowLine}\n\nSYS`);
  const fits = injectNowContext('SYS', at, '上海', line, tight + 1);
  assert.ok(fits.includes(line));
});

test('default location fallback 上海, env override, explicit wins', () => {
  const prev = process.env.DEFAULT_USER_LOCATION;
  delete process.env.DEFAULT_USER_LOCATION;
  assert.equal(resolveUserLocation(null), '上海');
  assert.equal(resolveUserLocation('  '), '上海');
  assert.equal(resolveUserLocation('杭州'), '杭州');
  process.env.DEFAULT_USER_LOCATION = '北京';
  assert.equal(resolveUserLocation(''), '北京');
  if (prev === undefined) delete process.env.DEFAULT_USER_LOCATION; else process.env.DEFAULT_USER_LOCATION = prev;
});
