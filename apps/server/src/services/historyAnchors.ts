/**
 * W-01-r2: L1 assembly-only time anchors for the recent window. Pure; no storage change.
 * Only session breakpoints get a label: the first user message of the window, and any user
 * message whose gap from the previous message is ≥ 2h. Format (Beijing time, presence slots):
 *   today → （今天 14:02） · yesterday → （昨天夜里 21:30） · earlier → （10-14 20:00）
 */
import { PRESENCE_TIMEZONE, presenceSlotForHour } from './presence.js';
import { toUtcIso } from '../utils/time.js';

export const HISTORY_BREAK_GAP_MS = 2 * 60 * 60 * 1000;

function bjParts(d: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PRESENCE_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = Number(g('hour')) % 24;
  return { ymd: `${g('year')}-${g('month')}-${g('day')}`, md: `${g('month')}-${g('day')}`, hour, hm: `${String(hour).padStart(2, '0')}:${g('minute')}` };
}

/** Label for one instant relative to `now` (both UTC). */
export function formatHistoryAnchor(atIso: string, nowIso: string): string {
  const at = bjParts(new Date(toUtcIso(atIso)));
  const now = new Date(nowIso);
  const today = bjParts(now).ymd;
  const yesterday = bjParts(new Date(now.getTime() - 24 * 60 * 60 * 1000)).ymd;
  if (at.ymd === today) return `（今天 ${at.hm}）`;
  if (at.ymd === yesterday) return `（昨天${presenceSlotForHour(at.hour).label} ${at.hm}）`;
  return `（${at.md} ${at.hm}）`;
}

/** Returns one label (or '') per message, same order as input (chronological). */
export function historyBreakAnchors<T extends { role: string; created_at?: string | null }>(
  chronological: T[],
  nowIso: string,
): string[] {
  const out: string[] = [];
  let prevMs: number | null = null;
  let seenUser = false;
  for (const m of chronological) {
    const ms = m.created_at ? new Date(toUtcIso(m.created_at)).getTime() : NaN;
    let label = '';
    if (m.role === 'user' && m.created_at && !Number.isNaN(ms)) {
      const isBreak = !seenUser || (prevMs != null && ms - prevMs >= HISTORY_BREAK_GAP_MS);
      if (isBreak) label = formatHistoryAnchor(m.created_at, nowIso);
    }
    if (m.role === 'user') seenUser = true;
    if (!Number.isNaN(ms)) prevMs = ms;
    out.push(label);
  }
  return out;
}
