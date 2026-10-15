import { envInt } from '../config/env.js';

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

export type InjectKind = 'memory' | 'presence' | 'life_event' | 'context' | 'other';

export type InjectItem = {
  kind: InjectKind;
  /** Lower = higher priority (kept first when over budget). */
  priority: number;
  text: string;
  id?: string;
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
  if (budgetTokens <= 0 || !items.length) return [];
  const sorted = [...items].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return String(a.id ?? '').localeCompare(String(b.id ?? ''));
  });
  const out: InjectItem[] = [];
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
