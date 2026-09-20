import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { chatCompletion } from './llm.js';
import { getProactiveSettings, inQuietHours } from './proactive.js';
import { buildSystemPrompt } from '../utils/characterCard.js';

const DELAY_MS = 45_000;
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function nowIso() {
  return new Date().toISOString();
}

function charLikeKey(characterId: string) {
  return `char:${characterId}`;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function listCharacters(): Array<{ id: string; name: string }> {
  return db.prepare(`SELECT id, name FROM characters ORDER BY name ASC`).all() as Array<{
    id: string;
    name: string;
  }>;
}

/** Skip space settle if C-05 just fired, to avoid whole-app spam. */
function recentProactiveFired(withinMs = 120_000): boolean {
  const rows = db
    .prepare(
      `SELECT created_at FROM messages WHERE source = 'proactive' ORDER BY created_at DESC LIMIT 5`,
    )
    .all() as Array<{ created_at: string }>;
  const now = Date.now();
  return rows.some((r) => now - new Date(r.created_at).getTime() < withinMs);
}

function alreadyLiked(momentId: string, characterId: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM moment_likes WHERE moment_id = ? AND user_key = ?`)
    .get(momentId, charLikeKey(characterId));
}

function alreadyCommented(momentId: string, characterName: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM moment_comments WHERE moment_id = ? AND author = ?`)
    .get(momentId, characterName);
}

function insertLike(momentId: string, characterId: string): boolean {
  if (alreadyLiked(momentId, characterId)) return false;
  db.prepare(`INSERT INTO moment_likes (moment_id, user_key, created_at) VALUES (?, ?, ?)`).run(
    momentId,
    charLikeKey(characterId),
    nowIso(),
  );
  return true;
}

function insertComment(momentId: string, author: string, content: string): boolean {
  if (alreadyCommented(momentId, author)) return false;
  db.prepare(
    `INSERT INTO moment_comments (id, moment_id, author, content, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(randomUUID(), momentId, author, content, nowIso());
  return true;
}

async function writeCharacterComment(
  momentId: string,
  momentContent: string,
  character: { id: string; name: string },
): Promise<boolean> {
  if (alreadyCommented(momentId, character.name)) return false;
  const full = db.prepare(`SELECT * FROM characters WHERE id = ?`).get(character.id) as
    | {
        id: string;
        name: string;
        description: string;
        personality: string;
        scenario: string;
        system_prompt: string;
        post_history_instructions: string;
        mes_example: string;
      }
    | undefined;
  if (!full) return false;

  let text = '';
  try {
    const system = buildSystemPrompt(full);
    text = await chatCompletion([
      { role: 'system', content: system },
      {
        role: 'user',
        content:
          `用户刚发了一条朋友圈：「${momentContent.slice(0, 200)}」\n` +
          '请用你的口吻写一句很短的评论（不超过 30 字）。只输出评论正文，不要引号、不要列表、不要解释。',
      },
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[moment-react] comment llm fail:', msg);
    return false;
  }
  text = String(text || '')
    .trim()
    .replace(/^["「『]|["」』]$/g, '')
    .split(/\n/)[0]
    .trim()
    .slice(0, 40);
  if (!text) return false;
  return insertComment(momentId, character.name, text);
}

export type MomentReactResult = {
  skipped?: string;
  likes: string[];
  comment: { author: string; content: string } | null;
};

export async function settleMomentReactions(momentId: string): Promise<MomentReactResult> {
  const moment = db
    .prepare(`SELECT id, author_kind, content FROM moments WHERE id = ?`)
    .get(momentId) as { id: string; author_kind: string; content: string } | undefined;
  if (!moment || moment.author_kind !== 'user') {
    return { skipped: 'not_user_moment', likes: [], comment: null };
  }

  const settings = getProactiveSettings();
  if (!settings.enabled) return { skipped: 'disabled', likes: [], comment: null };
  if (inQuietHours(new Date(), settings.quiet_start, settings.quiet_end)) {
    return { skipped: 'quiet_hours', likes: [], comment: null };
  }
  if (settings.sent_today >= settings.daily_cap) {
    return { skipped: 'daily_cap', likes: [], comment: null };
  }
  if (recentProactiveFired()) {
    return { skipped: 'c05_recent', likes: [], comment: null };
  }

  const chars = listCharacters();
  if (!chars.length) return { skipped: 'no_characters', likes: [], comment: null };

  const pool = shuffle(chars);
  const likeCount = Math.floor(Math.random() * 3); // 0..2
  const likes: string[] = [];
  for (const c of pool.slice(0, likeCount)) {
    if (insertLike(momentId, c.id)) likes.push(c.name);
  }

  let comment: { author: string; content: string } | null = null;
  for (const c of shuffle(chars)) {
    const ok = await writeCharacterComment(momentId, moment.content, c);
    if (ok) {
      comment = db
        .prepare(
          `SELECT author, content FROM moment_comments WHERE moment_id = ? AND author = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(momentId, c.name) as { author: string; content: string };
      break;
    }
  }

  console.log(
    `[moment-react] moment=${momentId} likes=${likes.length} comment=${comment ? comment.author : 'none'}`,
  );
  return { likes, comment };
}

/** Schedule delayed settlement after user posts a moment. Fixed ~45s. */
export function scheduleMomentReactions(momentId: string) {
  const prev = pendingTimers.get(momentId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    pendingTimers.delete(momentId);
    void settleMomentReactions(momentId).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[moment-react] settle error:', msg);
    });
  }, DELAY_MS);
  pendingTimers.set(momentId, t);
  console.log(`[moment-react] scheduled moment=${momentId} in ${DELAY_MS}ms`);
}
