import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ensureLifeEventsTable } from '../db/schema.js';
import { advanceLifeEvents, planLifeEvents } from './lifeEvents.js';

const bj = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 9, d, h - 8, m)); // 2026-10-d h:m 北京
const full = {
  late_night: { place: '卧室', activity: '睡觉' }, morning: { place: '厨房', activity: '做早饭' },
  daytime: { place: '工作室', activity: '画稿' }, evening: { place: '书房', activity: '看书' },
  night: { place: '阳台', activity: '听歌' },
};

function mkdb(chars: Array<{ id: string; presence: unknown }>) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE characters (id TEXT PRIMARY KEY, presence TEXT)`);
  ensureLifeEventsTable(db);
  ensureLifeEventsTable(db); // idempotent
  const ins = db.prepare(`INSERT INTO characters (id, presence) VALUES (?, ?)`);
  for (const c of chars) ins.run(c.id, c.presence == null ? null : JSON.stringify(c.presence));
  return db;
}
const rows = (db: Database.Database) =>
  db.prepare(`SELECT character_id, slot, local_date, place, activity FROM life_events ORDER BY occurred_at, character_id`).all() as any[];

test('dedup: two ticks in the same slot → 1 row', () => {
  const db = mkdb([{ id: 'yj', presence: full }]);
  assert.equal(advanceLifeEvents(db, bj(16, 19)).inserted, 1);
  assert.equal(advanceLifeEvents(db, bj(16, 21, 59)).inserted, 0);
  assert.equal(rows(db).length, 1);
  assert.deepEqual(rows(db)[0], { character_id: 'yj', slot: 'evening', local_date: '2026-10-16', place: '书房', activity: '看书' });
});

test('no presence config → zero writes', () => {
  const db = mkdb([{ id: 'a', presence: null }, { id: 'b', presence: {} }]);
  assert.equal(advanceLifeEvents(db, bj(16, 12)).inserted, 0);
  assert.equal(rows(db).length, 0);
});

test('current slot not filled → zero writes', () => {
  const db = mkdb([{ id: 'yj', presence: { evening: { place: '书房', activity: '看书' } } }]);
  assert.equal(advanceLifeEvents(db, bj(16, 12)).inserted, 0);
  assert.equal(rows(db).length, 0);
});

test('no backfill: skipped slots never appear', () => {
  const db = mkdb([{ id: 'yj', presence: full }]);
  advanceLifeEvents(db, bj(16, 7));   // morning
  advanceLifeEvents(db, bj(16, 23));  // night (daytime/evening skipped)
  assert.deepEqual(rows(db).map((r) => r.slot), ['morning', 'night']);
});

test('crossing Beijing date opens a new row for the same slot', () => {
  const db = mkdb([{ id: 'yj', presence: full }]);
  advanceLifeEvents(db, bj(16, 1));
  advanceLifeEvents(db, bj(17, 1));
  assert.deepEqual(rows(db).map((r) => `${r.local_date}/${r.slot}`), ['2026-10-16/late_night', '2026-10-17/late_night']);
});

test('7-day purge removes old rows only', () => {
  const db = mkdb([{ id: 'yj', presence: full }]);
  advanceLifeEvents(db, bj(8, 14)); // kept: 10-08 14:00 is after cutoff
  db.prepare(`INSERT INTO life_events VALUES ('old', 'yj', 'daytime', '', '', '2026-10-01', ?, ?)`).run(bj(1, 12).toISOString(), bj(1, 12).toISOString());
  const r = advanceLifeEvents(db, bj(15, 13)); // cutoff = 10-08 13:00 北京
  assert.equal(r.purged, 1);
  assert.deepEqual(rows(db).map((x) => x.local_date), ['2026-10-08', '2026-10-15']);
});

test('same input → same output (pure planner, deterministic id)', () => {
  const chars = [{ id: 'yj', presence: JSON.stringify(full) }, { id: 'x', presence: null }];
  const a = planLifeEvents(chars, bj(16, 19));
  const b = planLifeEvents(chars, bj(16, 19));
  assert.deepEqual(a, b);
  assert.equal(a.length, 1);
  assert.equal(a[0].id, 'yj:2026-10-16:evening');
});
