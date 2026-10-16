/**
 * W-03 段1: life_events advance (W-02 presence state machine → journal).
 * Pure planner + thin DB layer. No LLM, no randomness, no backfill of missed slots.
 */
import type Database from 'better-sqlite3';
import { PRESENCE_SLOTS, PRESENCE_TIMEZONE, presenceSlotForHour, resolvePresence, shanghaiHour, type PresenceSlotKey } from './presence.js';

export const LIFE_EVENTS_RETENTION_DAYS = 7;

export type LifeEventRow = {
  id: string;
  character_id: string;
  slot: PresenceSlotKey;
  place: string;
  activity: string;
  local_date: string;
  occurred_at: string;
  created_at: string;
};

/** Beijing calendar date YYYY-MM-DD for a UTC instant. */
export function shanghaiDate(now: Date): string {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: PRESENCE_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/** Pure: event that should exist for this character at `now`, or null (no config / slot empty). */
export function planLifeEvent(character: { id: string; presence?: unknown }, now: Date): LifeEventRow | null {
  const p = resolvePresence(character, now);
  if (!p) return null;
  const local_date = shanghaiDate(now);
  const at = now.toISOString();
  return {
    id: `${character.id}:${local_date}:${p.slot}`,
    character_id: character.id,
    slot: p.slot,
    place: p.place,
    activity: p.activity,
    local_date,
    occurred_at: at,
    created_at: at,
  };
}

/** Pure: planned events for a set of characters (only those with presence + filled slot). */
export function planLifeEvents(characters: Array<{ id: string; presence?: unknown }>, now: Date): LifeEventRow[] {
  return characters.map((c) => planLifeEvent(c, now)).filter((e): e is LifeEventRow => e !== null);
}

/** Cutoff ISO for retention purge. */
export function lifeEventsCutoff(now: Date, days = LIFE_EVENTS_RETENTION_DAYS): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** DB: insert (dedup by unique key) + purge rows older than retention. Returns counts. */
export function advanceLifeEvents(db: Database.Database, now: Date): { inserted: number; purged: number } {
  const chars = db
    .prepare(`SELECT id, presence FROM characters WHERE presence IS NOT NULL AND presence <> ''`)
    .all() as Array<{ id: string; presence: string }>;
  const events = planLifeEvents(chars, now);
  const ins = db.prepare(
    `INSERT OR IGNORE INTO life_events (id, character_id, slot, place, activity, local_date, occurred_at, created_at)
     VALUES (@id, @character_id, @slot, @place, @activity, @local_date, @occurred_at, @created_at)`,
  );
  let inserted = 0;
  const tx = db.transaction(() => {
    for (const e of events) inserted += ins.run(e).changes;
  });
  tx();
  const purged = db.prepare(`DELETE FROM life_events WHERE occurred_at < ?`).run(lifeEventsCutoff(now)).changes;
  return { inserted, purged };
}

export const LIFE_INJECT_MAX = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pure: pick events for the 'life' inject line — occurred within the last 24h, excluding the
 * current slot of today, newest 3, returned in chronological order.
 */
export function selectRecentLifeEvents(events: LifeEventRow[], now: Date, max = LIFE_INJECT_MAX): LifeEventRow[] {
  const today = shanghaiDate(now);
  const curSlot = presenceSlotForHour(shanghaiHour(now)).key;
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const nowIso = now.toISOString();
  return events
    .filter((e) => e.occurred_at >= since && e.occurred_at <= nowIso)
    .filter((e) => !(e.local_date === today && e.slot === curSlot))
    .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0))
    .slice(0, max)
    .reverse();
}

/** Pure: `你今天早些时候：昨天 夜里 在卧室看书；今天 早上 在厨房做早饭`, or null when empty. */
export function formatLifeLine(events: LifeEventRow[], now: Date): string | null {
  if (!events.length) return null;
  const today = shanghaiDate(now);
  const yesterday = shanghaiDate(new Date(now.getTime() - DAY_MS));
  const parts = events.map((e) => {
    const day = e.local_date === today ? '今天' : e.local_date === yesterday ? '昨天' : e.local_date.slice(5);
    const label = PRESENCE_SLOTS.find((x) => x.key === e.slot)?.label ?? e.slot;
    const what = `${e.place ? `在${e.place}` : ''}${e.activity || ''}`;
    return `${day} ${label} ${what}`.trim();
  });
  return `你今天早些时候：${parts.join('；')}`;
}

/** DB read + pure select/format. Caller wraps in try/catch. */
export function buildLifeLine(db: Database.Database, characterId: string, now: Date): string | null {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const rows = db
    .prepare(`SELECT * FROM life_events WHERE character_id = ? AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT 10`)
    .all(characterId, since) as LifeEventRow[];
  return formatLifeLine(selectRecentLifeEvents(rows, now), now);
}
