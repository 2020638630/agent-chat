import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ensureLifeEventsTable } from '../db/schema.js';
import { advanceLifeEvents, buildLifeLine, formatLifeLine, selectRecentLifeEvents, type LifeEventRow } from './lifeEvents.js';
import { buildNowContextLine, estimateTokens, injectNowContext } from './promptInject.js';

const bj = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 9, d, h - 8, m));
const full = {
  late_night: { place: '卧室', activity: '睡觉' }, morning: { place: '厨房', activity: '做早饭' },
  daytime: { place: '工作室', activity: '画稿' }, evening: { place: '书房', activity: '看书' },
  night: { place: '卧室', activity: '看书' },
};
function mkdb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE characters (id TEXT PRIMARY KEY, presence TEXT)`);
  ensureLifeEventsTable(db);
  db.prepare(`INSERT INTO characters VALUES ('yj', ?)`).run(JSON.stringify(full));
  return db;
}

test('events present → line listed; no events → null', () => {
  const db = mkdb();
  assert.equal(buildLifeLine(db, 'yj', bj(16, 8)), null);
  advanceLifeEvents(db, bj(16, 7));
  assert.equal(buildLifeLine(db, 'yj', bj(16, 12)), '你今天早些时候：今天 早上 在厨房做早饭');
});

test('current slot of today is excluded', () => {
  const db = mkdb();
  advanceLifeEvents(db, bj(16, 7));
  assert.equal(buildLifeLine(db, 'yj', bj(16, 8)), null);
});

test('at most 3, newest kept, chronological in line', () => {
  const db = mkdb();
  for (const [d, h] of [[15, 7], [15, 12], [15, 19], [15, 23], [16, 1], [16, 7]] as const) advanceLifeEvents(db, bj(d, h));
  assert.equal(buildLifeLine(db, 'yj', bj(16, 12)), '你今天早些时候：昨天 夜里 在卧室看书；今天 深夜 在卧室睡觉；今天 早上 在厨房做早饭');
});

test('cross-midnight: yesterday night listed this morning as 昨天 夜里', () => {
  const db = mkdb();
  advanceLifeEvents(db, bj(15, 23));
  assert.equal(buildLifeLine(db, 'yj', bj(16, 7)), '你今天早些时候：昨天 夜里 在卧室看书');
});

test('older than 24h not listed', () => {
  const db = mkdb();
  advanceLifeEvents(db, bj(15, 7));
  assert.equal(buildLifeLine(db, 'yj', bj(16, 7, 1)), null);
  const e: LifeEventRow = { id: 'x', character_id: 'yj', slot: 'morning', place: '', activity: 'a', local_date: '2026-10-15', occurred_at: bj(15, 7).toISOString(), created_at: '' };
  assert.equal(selectRecentLifeEvents([e], bj(16, 7, 1)).length, 0);
  assert.equal(formatLifeLine([], bj(16, 7)), null);
});

test('inject order now → presence → life; tight budget drops whole life line only', () => {
  const at = bj(16, 12).toISOString();
  const nowLine = buildNowContextLine(at, '上海');
  const pres = '你此刻：在工作室，画稿（白天）';
  const life = '你今天早些时候：今天 早上 在厨房做早饭';
  const out = injectNowContext('SYS', at, '上海', pres, undefined, life).split('\n');
  assert.deepEqual(out.slice(0, 5), [nowLine, pres, life, '', 'SYS']);
  const tight = estimateTokens(nowLine) + estimateTokens(pres) + estimateTokens(life) - 1;
  assert.equal(injectNowContext('SYS', at, '上海', pres, tight, life), `${nowLine}\n${pres}\n\nSYS`);
  assert.equal(injectNowContext('SYS', at, '上海', pres, undefined, null), `${nowLine}\n${pres}\n\nSYS`);
});
