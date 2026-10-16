import { env, envInt } from '../config/env.js';
import { PRESENCE_TIMEZONE, presenceSlotForHour } from './presence.js';

/**
 * D-25: lightweight token estimate + budgeted prompt injection.
 * No tiktoken / extra deps. Callers keep existing signatures (memory contract §3/§5).
 */

/** Rough token estimate for CN/EN mixed text (CJK ≈ 1 tok/char, ASCII ≈ 4 chars/tok). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (
      (cp >= 0x2e80 && cp <= 0x9fff) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0x3000 && cp <= 0x303f) ||
      (cp >= 0xff00 && cp <= 0xffef)
    ) {
      tokens += 1;
    } else if (cp <= 0x7f) {
      tokens += 0.25;
    } else {
      tokens += 0.5;
    }
  }
  return Math.max(1, Math.ceil(tokens));
}

export type InjectKind = 'memory' | 'presence' | 'life' | 'life_event' | 'context' | 'now' | 'other';

export type InjectItem = {
  kind: InjectKind;
  /** Lower = higher priority (kept first when over budget). */
  priority: number;
  text: string;
  id?: string;
  /** W-01: pinned items are always kept and never trimmed by the budget. */
  pinned?: boolean;
};

/** Shared budget for memory (+ future presence / life_events) inject lines. Default 512. */
export function injectTokenBudget(): number {
  const n = envInt('PROMPT_INJECT_TOKEN_BUDGET', 512);
  return n > 64 ? n : 512;
}

/** History window token budget (message-count cap remains a second gate). Default 3072. */
export function historyTokenBudget(): number {
  const n = envInt('PROMPT_HISTORY_TOKEN_BUDGET', 3072);
  return n > 256 ? n : 3072;
}

/** Hard message-count cap for main chat history fetch. Default 40. */
export function historyMessageCap(): number {
  const n = envInt('PROMPT_HISTORY_MESSAGE_CAP', 40);
  return n > 0 ? n : 40;
}

/**
 * Pack items under a token budget. High priority first; skip items that do not fit.
 * Deterministic for the same inputs (budget内结果一致).
 */
export function packWithinTokenBudget(items: InjectItem[], budgetTokens: number): InjectItem[] {
  if (!items.length) return [];
  const pinned = items.filter((i) => i.pinned);
  const rest = items.filter((i) => !i.pinned);
  if (budgetTokens <= 0) return pinned;
  const sorted = [...rest].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return String(a.id ?? '').localeCompare(String(b.id ?? ''));
  });
  const out: InjectItem[] = [...pinned];
  let used = 0;
  for (const item of sorted) {
    const cost = estimateTokens(item.text);
    if (used + cost > budgetTokens) continue;
    out.push(item);
    used += cost;
  }
  return out;
}

/**
 * Keep newest messages while total content tokens ≤ budget.
 * Input chronological (oldest → newest). Under budget → same array reference contents (identical order/items).
 */
export function takeRecentWithinTokenBudget<T extends { content: string }>(
  chronological: T[],
  budgetTokens: number,
): T[] {
  if (!chronological.length) return chronological;
  if (budgetTokens <= 0) return [];
  let total = 0;
  for (const m of chronological) total += estimateTokens(m.content || '');
  if (total <= budgetTokens) return chronological;

  const kept: T[] = [];
  let used = 0;
  for (let i = chronological.length - 1; i >= 0; i--) {
    const cost = estimateTokens(chronological[i].content || '');
    if (kept.length > 0 && used + cost > budgetTokens) break;
    // Always keep at least the newest message even if it alone exceeds budget.
    kept.push(chronological[i]);
    used += cost;
  }
  return kept.reverse();
}

/** W-01: fixed timezone — W-02-r2: single source shared with presence. */
export const NOW_CONTEXT_TIMEZONE = PRESENCE_TIMEZONE;

/** W-02-r2: day period = presence 5 slots (深夜/早上/白天/傍晚/夜里); no second boundary set. */
function dayPeriod(hour: number): string {
  return presenceSlotForHour(hour).label;
}

/**
 * W-01: one-line "now" context from a UTC ISO instant (D-26 nowIso).
 * e.g. 当前时间：2026-10-16 15:04（周五 白天，北京时间）；用户所在地：上海
 * Empty location → the whole 「；用户所在地：…」 segment is omitted.
 */
export function buildNowContextLine(utcIso: string, location?: string | null): string {
  const d = new Date(utcIso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NOW_CONTEXT_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = Number(g('hour')) % 24;
  const wk: Record<string, string> = { Sun: '日', Mon: '一', Tue: '二', Wed: '三', Thu: '四', Fri: '五', Sat: '六' };
  const hh = String(hour).padStart(2, '0');
  let line = `当前时间：${g('year')}-${g('month')}-${g('day')} ${hh}:${g('minute')}（周${wk[g('weekday')] ?? ''} ${dayPeriod(hour)}，北京时间）`;
  const loc = typeof location === 'string' ? location.trim() : '';
  if (loc) line += `；用户所在地：${loc}`;
  return line;
}

/** W-02: user location fallback when user_profile.location is empty (env DEFAULT_USER_LOCATION, default 上海). */
export const DEFAULT_USER_LOCATION_FALLBACK = '上海';
export function resolveUserLocation(raw?: string | null): string {
  const loc = typeof raw === 'string' ? raw.trim() : '';
  return loc || env('DEFAULT_USER_LOCATION', DEFAULT_USER_LOCATION_FALLBACK);
}

/**
 * W-01: assemble the pinned now-context through the inject packer (highest priority, never trimmed).
 * W-02: optional presence line (kind 'presence') placed right after the now line. It is NOT pinned:
 * it must fit the inject budget left after the now line, otherwise the whole line is dropped (never cut).
 * W-03: optional life line (kind 'life') after presence, same rule (lower priority than presence).
 * Existing 3-arg callers are unchanged (memory contract §5).
 */
export function injectNowContext(
  system: string,
  utcIso: string,
  location?: string | null,
  presenceLine?: string | null,
  budgetTokens: number = injectTokenBudget(),
  lifeLine?: string | null,
): string {
  const nowLine = buildNowContextLine(utcIso, location);
  const items: InjectItem[] = [{ kind: 'now', priority: -1000, pinned: true, id: 'now', text: nowLine }];
  const pres = typeof presenceLine === 'string' ? presenceLine.trim() : '';
  if (pres) items.push({ kind: 'presence', priority: -900, id: 'presence', text: pres });
  const life = typeof lifeLine === 'string' ? lifeLine.trim() : '';
  if (life) items.push({ kind: 'life', priority: -800, id: 'life', text: life });
  const packed = packWithinTokenBudget(items, Math.max(0, budgetTokens - estimateTokens(nowLine)));
  if (!packed.length) return system;
  const order = (k: InjectKind) => (k === 'now' ? 0 : k === 'presence' ? 1 : 2);
  packed.sort((a, b) => order(a.kind) - order(b.kind));
  return `${packed.map((i) => i.text).join('\n')}\n\n${system}`;
}
