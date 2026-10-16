import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePresence, formatPresenceLine } from './presence.js';

const cfg = {
  late_night: { place: '卧室', activity: '睡觉' },
  morning: { place: '厨房', activity: '做早饭' },
  daytime: { place: '工作室', activity: '画稿' },
  evening: { place: '书房', activity: '看书' },
  night: { place: '阳台', activity: '听歌' },
};
const ch = { presence: JSON.stringify(cfg) };
// Beijing = UTC+8
const bj = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 16, h - 8, m, 0));

test('boundary 06:00 → 早上, 05:59 → 深夜', () => {
  assert.equal(resolvePresence(ch, bj(6))?.slot, 'morning');
  assert.equal(resolvePresence(ch, bj(5, 59))?.slot, 'late_night');
});
test('boundary 18:00 → 傍晚, 17:59 → 白天', () => {
  assert.equal(resolvePresence(ch, bj(18))?.slot, 'evening');
  assert.equal(resolvePresence(ch, bj(17, 59))?.slot, 'daytime');
});
test('boundary 00:00 → 深夜, 23:59 → 夜里', () => {
  assert.equal(resolvePresence(ch, new Date('2026-10-16T16:00:00.000Z'))?.slot, 'late_night');
  assert.equal(resolvePresence(ch, new Date('2026-10-16T15:59:00.000Z'))?.slot, 'night');
});
test('09:00 → 白天, 22:00 → 夜里', () => {
  assert.equal(resolvePresence(ch, bj(9))?.slot, 'daytime');
  assert.equal(resolvePresence(ch, bj(22))?.slot, 'night');
});
test('empty / invalid config → null', () => {
  for (const p of [undefined, null, '', '{bad', '[]', '{}']) {
    assert.equal(resolvePresence({ presence: p }, bj(12)), null);
  }
  assert.equal(resolvePresence(null, bj(12)), null);
});
test('slot not filled → null', () => {
  const c = { presence: { evening: { place: '书房', activity: '看书' }, daytime: { place: ' ', activity: '' } } };
  assert.equal(resolvePresence(c, bj(8)), null);
  assert.equal(resolvePresence(c, bj(12)), null);
  assert.ok(resolvePresence(c, bj(19)));
});
test('same input → same output; accepts ISO string', () => {
  const a = resolvePresence(ch, bj(19, 30));
  const b = resolvePresence(ch, bj(19, 30).toISOString());
  assert.deepEqual(a, b);
  assert.deepEqual(a, { slot: 'evening', label: '傍晚', place: '书房', activity: '看书' });
});
test('formatPresenceLine', () => {
  assert.equal(formatPresenceLine(resolvePresence(ch, bj(19))), '你此刻：在书房，看书（傍晚）');
  assert.equal(formatPresenceLine(resolvePresence({ presence: { evening: { activity: '看书' } } }, bj(19))), '你此刻：看书（傍晚）');
  assert.equal(formatPresenceLine(null), null);
});
