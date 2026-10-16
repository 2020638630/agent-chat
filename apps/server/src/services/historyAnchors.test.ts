import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatHistoryAnchor, historyBreakAnchors } from './historyAnchors.js';
import { estimateTokens, historyTokenBudget } from './promptInject.js';

const now = '2026-10-16T07:00:00.000Z'; // 10-16 15:00 北京

test('anchor formats: today / yesterday+slot / earlier', () => {
  assert.equal(formatHistoryAnchor('2026-10-16T06:02:00.000Z', now), '（今天 14:02）');
  assert.equal(formatHistoryAnchor('2026-10-15T14:30:00.000Z', now), '（昨天夜里 22:30）');
  assert.equal(formatHistoryAnchor('2026-10-15T13:30:00.000Z', now), '（昨天傍晚 21:30）');
  assert.equal(formatHistoryAnchor('2026-10-14T12:00:00.000Z', now), '（10-14 20:00）');
  assert.equal(formatHistoryAnchor('2026-10-15 13:30:00', now), '（昨天傍晚 21:30）'); // sqlite UTC form
});

test('only breakpoints labeled (first user + gap ≥ 2h), not every line', () => {
  const h = [
    { role: 'user', created_at: '2026-10-15T13:30:00.000Z', content: 'a' },
    { role: 'assistant', created_at: '2026-10-15T13:31:00.000Z', content: 'b' },
    { role: 'user', created_at: '2026-10-15T13:35:00.000Z', content: 'c' },
    { role: 'assistant', created_at: '2026-10-15T13:36:00.000Z', content: 'd' },
    { role: 'user', created_at: now, content: 'e' },
  ];
  assert.deepEqual(historyBreakAnchors(h, now), ['（昨天傍晚 21:30）', '', '', '', '（今天 15:00）']);
});

test('gap just under 2h → no label; assistant never labeled', () => {
  const h = [
    { role: 'assistant', created_at: '2026-10-16T03:00:00.000Z', content: 'x' },
    { role: 'user', created_at: '2026-10-16T04:59:00.000Z', content: 'y' },
    { role: 'user', created_at: '2026-10-16T06:58:59.000Z', content: 'z' },
  ];
  assert.deepEqual(historyBreakAnchors(h, now), ['', '（今天 12:59）', '']);
});

test('fixture stays under the 3072 history gate', () => {
  const labels = ['（昨天傍晚 21:30）', '（今天 15:00）'];
  const added = labels.reduce((s, l) => s + estimateTokens(l), 0);
  assert.ok(added < 20 && added < historyTokenBudget());
});
