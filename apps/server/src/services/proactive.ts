import { db } from '../db/index.js';
import { chatCompletion } from './llm.js';
import { buildSystemPrompt } from '../utils/characterCard.js';
import { defaultInitiativeTier } from '../db/schema.js';
import { randomUUID } from 'node:crypto';

export type InitiativeTier = 'restrained' | 'calm' | 'outgoing';

type TierCfg = { threshold: number; perMinute: number; cooldownMin: number };

const TIER: Record<InitiativeTier, TierCfg> = {
  restrained: { threshold: 0.85, perMinute: 0.08, cooldownMin: 180 },
  calm: { threshold: 0.65, perMinute: 0.12, cooldownMin: 90 },
  outgoing: { threshold: 0.45, perMinute: 0.18, cooldownMin: 45 },
};

const URGE_IDLE_MS = 15 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function parseHm(s: string): { h: number; m: number } {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { h: 0, m: 0 };
  return { h: Math.min(23, Number(m[1])), m: Math.min(59, Number(m[2])) };
}

/** Quiet window may span midnight (e.g. 23:00-08:00). */
export function inQuietHours(now = new Date(), start = '23:00', end = '08:00'): boolean {
  const a = parseHm(start);
  const b = parseHm(end);
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = a.h * 60 + a.m;
  const e = b.h * 60 + b.m;
  if (s === e) return false;
  if (s < e) return cur >= s && cur < e;
  return cur >= s || cur < e;
}

function normalizeTier(v: unknown, name = ''): InitiativeTier {
  const s = String(v || '');
  if (s === 'restrained' || s === 'calm' || s === 'outgoing') return s;
  return defaultInitiativeTier(name);
}

function countProactiveToday(): number {
  const rows = db
    .prepare(`SELECT created_at FROM messages WHERE source = 'proactive'`)
    .all() as Array<{ created_at: string }>;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return rows.filter((r) => {
    const t = new Date(r.created_at).getTime();
    return t >= start.getTime() && t <= end.getTime();
  }).length;
}

export type ProactiveSettings = {
  enabled: boolean;
  quiet_start: string;
  quiet_end: string;
  daily_cap: number;
  sent_today: number;
};

export function getProactiveSettings(): ProactiveSettings {
  const row = db.prepare(`SELECT * FROM user_profile WHERE id = 'me'`).get() as
    | {
        proactive_enabled?: number;
        proactive_quiet_start?: string;
        proactive_quiet_end?: string;
        proactive_daily_cap?: number;
      }
    | undefined;
  const cap = Number(row?.proactive_daily_cap ?? 3);
  return {
    enabled: Number(row?.proactive_enabled ?? 0) === 1,
    quiet_start: row?.proactive_quiet_start || '23:00',
    quiet_end: row?.proactive_quiet_end || '08:00',
    daily_cap: Math.min(8, Math.max(1, Number.isFinite(cap) ? cap : 3)),
    sent_today: countProactiveToday(),
  };
}

export function patchProactiveSettings(body: {
  enabled?: boolean;
  quiet_start?: string;
  quiet_end?: string;
  daily_cap?: number;
}): ProactiveSettings {
  const cur = getProactiveSettings();
  const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : cur.enabled ? 1 : 0;
  const quiet_start =
    body.quiet_start !== undefined ? String(body.quiet_start).trim() || '23:00' : cur.quiet_start;
  const quiet_end =
    body.quiet_end !== undefined ? String(body.quiet_end).trim() || '08:00' : cur.quiet_end;
  let daily_cap = cur.daily_cap;
  if (body.daily_cap !== undefined) {
    daily_cap = Math.min(8, Math.max(1, Math.round(Number(body.daily_cap))));
  }
  db.prepare(
    `UPDATE user_profile SET
      proactive_enabled = ?,
      proactive_quiet_start = ?,
      proactive_quiet_end = ?,
      proactive_daily_cap = ?,
      updated_at = ?
     WHERE id = 'me'`
  ).run(enabled, quiet_start, quiet_end, daily_cap, nowIso());
  return getProactiveSettings();
}

function ensureState(characterId: string) {
  const row = db.prepare(`SELECT * FROM proactive_state WHERE character_id = ?`).get(characterId);
  if (!row) {
    db.prepare(
      `INSERT INTO proactive_state (character_id, urge, last_user_at, last_proactive_at, unanswered, updated_at)
       VALUES (?, 0, NULL, NULL, 0, ?)`
    ).run(characterId, nowIso());
  }
}

/** Call after user successfully sends text/voice in a private chat. */
export function onPrivateUserMessage(characterId: string) {
  if (!characterId) return;
  ensureState(characterId);
  db.prepare(
    `UPDATE proactive_state SET
      urge = 0,
      unanswered = 0,
      last_user_at = ?,
      updated_at = ?
     WHERE character_id = ?`
  ).run(nowIso(), nowIso(), characterId);
}

type Candidate = {
  character_id: string;
  conversation_id: string;
  name: string;
  initiative_tier: InitiativeTier;
  urge: number;
  last_user_at: string | null;
  last_proactive_at: string | null;
  unanswered: number;
};

function listPrivateCandidates(): Candidate[] {
  const rows = db
    .prepare(
      `SELECT c.id AS conversation_id, ch.id AS character_id, ch.name, ch.initiative_tier,
              ps.urge, ps.last_user_at, ps.last_proactive_at, ps.unanswered
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id
       JOIN characters ch ON ch.id = cm.character_id
       LEFT JOIN proactive_state ps ON ps.character_id = ch.id
       WHERE c.type = 'private'`
    )
    .all() as Array<{
    conversation_id: string;
    character_id: string;
    name: string;
    initiative_tier: string;
    urge: number | null;
    last_user_at: string | null;
    last_proactive_at: string | null;
    unanswered: number | null;
  }>;

  return rows.map((r) => {
    ensureState(r.character_id);
    const st = db.prepare(`SELECT * FROM proactive_state WHERE character_id = ?`).get(r.character_id) as {
      urge: number;
      last_user_at: string | null;
      last_proactive_at: string | null;
      unanswered: number;
    };
    return {
      character_id: r.character_id,
      conversation_id: r.conversation_id,
      name: r.name,
      initiative_tier: normalizeTier(r.initiative_tier, r.name),
      urge: Number(st.urge || 0),
      last_user_at: st.last_user_at,
      last_proactive_at: st.last_proactive_at,
      unanswered: Number(st.unanswered || 0),
    };
  });
}

function bumpUrge(c: Candidate, elapsedMin: number): number {
  const cfg = TIER[c.initiative_tier];
  return Math.min(1.5, c.urge + cfg.perMinute * elapsedMin);
}

export type TickResult = {
  ran: boolean;
  sent: boolean;
  reason?: string;
  character_id?: string;
  conversation_id?: string;
  message_id?: string;
  content?: string;
};

export async function runProactiveTick(): Promise<TickResult> {
  const settings = getProactiveSettings();
  if (!settings.enabled) return { ran: true, sent: false, reason: 'disabled' };
  if (inQuietHours(new Date(), settings.quiet_start, settings.quiet_end)) {
    return { ran: true, sent: false, reason: 'quiet_hours' };
  }
  if (settings.sent_today >= settings.daily_cap) {
    return { ran: true, sent: false, reason: 'daily_cap' };
  }

  const now = Date.now();
  const candidates = listPrivateCandidates();
  const eligible: Candidate[] = [];

  for (const c of candidates) {
    if (!c.last_user_at) continue;
    if (c.unanswered >= 1) continue;
    const cfg = TIER[c.initiative_tier];
    if (c.last_proactive_at) {
      const coolMs = cfg.cooldownMin * 60 * 1000;
      if (now - new Date(c.last_proactive_at).getTime() < coolMs) continue;
    }
    const idleMs = now - new Date(c.last_user_at).getTime();
    if (idleMs < URGE_IDLE_MS) continue;

    const grown = bumpUrge(c, 1);
    db.prepare(
      `UPDATE proactive_state SET urge = ?, updated_at = ? WHERE character_id = ?`
    ).run(grown, nowIso(), c.character_id);
    c.urge = grown;
    if (c.urge >= cfg.threshold) eligible.push(c);
  }

  if (!eligible.length) return { ran: true, sent: false, reason: 'no_candidate' };

  eligible.sort((a, b) => b.urge - a.urge);
  const pick = eligible[0];

  const character = db.prepare(`SELECT * FROM characters WHERE id = ?`).get(pick.character_id) as {
    id: string;
    name: string;
    description: string;
    personality: string;
    scenario: string;
    system_prompt: string;
    post_history_instructions: string;
    mes_example: string;
  };

  const history = db
    .prepare(
      `SELECT role, content FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 8`
    )
    .all(pick.conversation_id) as Array<{ role: string; content: string }>;
  history.reverse();

  let system = buildSystemPrompt(character);
  system +=
    '\n\n【主动开口】这是你主动找用户的一条短讯，不是回复上一句。像熟人发消息，1～2 句。不要道歉，不要问「在吗」，不要舞台旁白，不要角色名前缀。若此时开口会显得突兀，只输出 SILENCE。';

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: system },
  ];
  for (const m of history) {
    if (m.role === 'user' || m.role === 'assistant') {
      messages.push({ role: m.role, content: m.content });
    }
  }
  messages.push({
    role: 'user',
    content: '（系统）现在可以主动发一条短讯，或输出 SILENCE。',
  });

  let reply = '';
  try {
    reply = (await chatCompletion(messages)).trim();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ran: true, sent: false, reason: `llm_error:${msg.slice(0, 120)}` };
  }

  const normalized = reply.replace(/^["「]|["」]$/g, '').trim();
  if (
    !normalized ||
    /^SILENCE$/i.test(normalized) ||
    normalized === '…' ||
    normalized === '...'
  ) {
    db.prepare(
      `UPDATE proactive_state SET urge = urge * 0.5, updated_at = ? WHERE character_id = ?`
    ).run(nowIso(), pick.character_id);
    return { ran: true, sent: false, reason: 'silence', character_id: pick.character_id };
  }

  const content = normalized.slice(0, 500);
  const mid = randomUUID();
  const at = nowIso();
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, character_id, content, created_at, source)
     VALUES (?, ?, 'assistant', ?, ?, ?, 'proactive')`
  ).run(mid, pick.conversation_id, pick.character_id, content, at);
  db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(at, pick.conversation_id);
  db.prepare(
    `UPDATE proactive_state SET
      urge = 0,
      unanswered = 1,
      last_proactive_at = ?,
      updated_at = ?
     WHERE character_id = ?`
  ).run(at, at, pick.character_id);

  return {
    ran: true,
    sent: true,
    character_id: pick.character_id,
    conversation_id: pick.conversation_id,
    message_id: mid,
    content,
  };
}
