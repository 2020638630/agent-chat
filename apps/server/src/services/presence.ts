/**
 * W-02: character "此刻档" presence — pure, deterministic, no LLM / timers / DB writes.
 * Five fixed Beijing-time slots, left-closed right-open:
 *   late_night 0–6 深夜 · morning 6–9 早上 · daytime 9–18 白天 · evening 18–22 傍晚 · night 22–24 夜里
 */

export const PRESENCE_TIMEZONE = 'Asia/Shanghai';

export type PresenceSlotKey = 'late_night' | 'morning' | 'daytime' | 'evening' | 'night';

export interface PresenceEntry {
  place?: string;
  activity?: string;
}

/** Stored in `characters.presence` (nullable JSON). Any slot may be omitted. */
export type PresenceConfig = Partial<Record<PresenceSlotKey, PresenceEntry>>;

export interface PresenceResult {
  slot: PresenceSlotKey;
  label: string;
  place: string;
  activity: string;
}

export const PRESENCE_SLOTS: ReadonlyArray<{ key: PresenceSlotKey; label: string; start: number; end: number }> = [
  { key: 'late_night', label: '深夜', start: 0, end: 6 },
  { key: 'morning', label: '早上', start: 6, end: 9 },
  { key: 'daytime', label: '白天', start: 9, end: 18 },
  { key: 'evening', label: '傍晚', start: 18, end: 22 },
  { key: 'night', label: '夜里', start: 22, end: 24 },
];

/** Beijing hour (0–23) for a UTC instant. */
export function shanghaiHour(now: Date | string): number {
  const d = typeof now === 'string' ? new Date(now) : now;
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone: PRESENCE_TIMEZONE, hour: '2-digit', hourCycle: 'h23',
  }).format(d);
  return Number(h) % 24;
}

export function presenceSlotForHour(hour: number) {
  return PRESENCE_SLOTS.find((s) => hour >= s.start && hour < s.end) ?? PRESENCE_SLOTS[0];
}

/** Accepts DB value (JSON string / null) or already-parsed object; bad input → null. */
export function parsePresenceConfig(raw: unknown): PresenceConfig | null {
  if (raw == null || raw === '') return null;
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { return null; }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as PresenceConfig;
}

const clean = (x: unknown) => (typeof x === 'string' ? x.trim() : '');

/**
 * Resolve the character's presence for `now` (UTC instant). Returns null when the
 * character has no config, or the current slot is not filled (needs place or activity).
 */
export function resolvePresence(
  character: { presence?: unknown } | null | undefined,
  now: Date | string,
): PresenceResult | null {
  const cfg = parsePresenceConfig(character?.presence);
  if (!cfg) return null;
  const d = typeof now === 'string' ? new Date(now) : now;
  if (Number.isNaN(d.getTime())) return null;
  const slot = presenceSlotForHour(shanghaiHour(d));
  const entry = cfg[slot.key];
  if (!entry || typeof entry !== 'object') return null;
  const place = clean(entry.place);
  const activity = clean(entry.activity);
  if (!place && !activity) return null;
  return { slot: slot.key, label: slot.label, place, activity };
}

/** One line, e.g. `你此刻：在书房，看书（傍晚）`. Not wired into inject yet (W-02 段2). */
export function formatPresenceLine(p: PresenceResult | null): string | null {
  if (!p) return null;
  const parts = [p.place ? `在${p.place}` : '', p.activity].filter(Boolean);
  return `你此刻：${parts.join('，')}（${p.label}）`;
}
