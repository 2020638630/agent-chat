import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { chatCompletion } from './llm.js';

export type MemoryType = 'fact' | 'preference' | 'promise' | 'habit';
export type MemoryStatus = 'active' | 'superseded' | 'user_hidden';

export type MemoryRow = {
  id: string;
  character_id: string;
  type: MemoryType;
  content: string;
  evidence_json: string | null;
  confidence: number;
  status: MemoryStatus;
  supersedes: string | null;
  created_at: string;
  updated_at: string;
};

const MEMORY_TYPES: MemoryType[] = ['fact', 'preference', 'promise', 'habit'];
const MAX_ACTIVE = 40;
const INJECT_MAX = 8;
const INJECT_MIN_CONF = 0.6;
const EXTRACT_HISTORY = 12;
const EXTRACT_ACTIVE_CAP = 20;

function nowIso() {
  return new Date().toISOString();
}

function isMemoryType(v: unknown): v is MemoryType {
  return typeof v === 'string' && (MEMORY_TYPES as string[]).includes(v);
}

export function listActiveMemories(
  characterId: string,
  opts?: { minConfidence?: number; limit?: number },
): MemoryRow[] {
  const min = opts?.minConfidence ?? 0;
  const limit = opts?.limit ?? MAX_ACTIVE;
  return db
    .prepare(
      `SELECT * FROM memories
       WHERE character_id = ? AND status = 'active' AND confidence >= ?
       ORDER BY CASE type WHEN 'promise' THEN 0 ELSE 1 END ASC, confidence DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(characterId, min, limit) as MemoryRow[];
}

export function listMemoriesForApi(characterId: string, status: MemoryStatus | 'all' = 'active') {
  if (status === 'all') {
    return db
      .prepare(
        `SELECT id, character_id, type, content, evidence_json, confidence, status, supersedes, created_at, updated_at
         FROM memories WHERE character_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(characterId) as MemoryRow[];
  }
  return db
    .prepare(
      `SELECT id, character_id, type, content, evidence_json, confidence, status, supersedes, created_at, updated_at
       FROM memories WHERE character_id = ? AND status = ?
       ORDER BY CASE type WHEN 'promise' THEN 0 ELSE 1 END ASC, confidence DESC, updated_at DESC`,
    )
    .all(characterId, status) as MemoryRow[];
}

/** Append memory block for private-chat system prompts. No-op when empty. */
export function appendMemoryBlock(system: string, characterId: string): string {
  const rows = listActiveMemories(characterId, {
    minConfidence: INJECT_MIN_CONF,
    limit: INJECT_MAX,
  });
  if (!rows.length) return system;
  const lines = rows.map((r) => `- (${r.type}) ${r.content}`);
  return `${system}\n\n【你记得的事】\n${lines.join('\n')}`;
}


function looksLikeDrinkPreference(content: string): boolean {
  return /喝|茶|温水|开水|咖啡|饮料/.test(content);
}

/** If a new drink preference arrives, retire other active drink preferences for this character. */
function autoSupersedeDrinkConflicts(characterId: string, newId: string, content: string, at: string) {
  if (!looksLikeDrinkPreference(content)) return;
  const others = db
    .prepare(
      `SELECT id, content FROM memories
       WHERE character_id = ? AND status = 'active' AND type = 'preference' AND id != ?`,
    )
    .all(characterId, newId) as Array<{ id: string; content: string }>;
  const mark = db.prepare(
    `UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ? AND character_id = ?`,
  );
  for (const o of others) {
    if (looksLikeDrinkPreference(o.content) && o.content.trim() !== content.trim()) {
      mark.run(at, o.id, characterId);
    }
  }
}

function enforceActiveCap(characterId: string) {
  const actives = db
    .prepare(
      `SELECT id, type, confidence, updated_at FROM memories
       WHERE character_id = ? AND status = 'active'
       ORDER BY CASE type WHEN 'promise' THEN 0 ELSE 1 END ASC, confidence ASC, updated_at ASC`,
    )
    .all(characterId) as Array<{ id: string; type: string; confidence: number; updated_at: string }>;
  if (actives.length <= MAX_ACTIVE) return;
  const dropN = actives.length - MAX_ACTIVE;
  const droppable = actives.filter((a) => a.type !== 'promise');
  const victims = (droppable.length >= dropN ? droppable : actives).slice(0, dropN);
  const stmt = db.prepare(
    `UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ? AND character_id = ?`,
  );
  const at = nowIso();
  for (const v of victims) stmt.run(at, v.id, characterId);
}

type ExtractOp = {
  op: string;
  type: MemoryType;
  content: string;
  evidence_message_ids?: string[];
  confidence?: number;
  supersedes?: string[];
};

function parseOps(raw: string): ExtractOp[] {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  const parsed = JSON.parse(text) as { ops?: unknown };
  if (!parsed || !Array.isArray(parsed.ops)) return [];
  const out: ExtractOp[] = [];
  for (const item of parsed.ops) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (String(o.op || '') !== 'upsert') continue;
    if (!isMemoryType(o.type)) continue;
    const content = String(o.content || '').trim();
    if (!content) continue;
    let confidence = Number(o.confidence);
    if (!Number.isFinite(confidence)) confidence = 0.7;
    confidence = Math.min(1, Math.max(0, confidence));
    const supersedes = Array.isArray(o.supersedes)
      ? o.supersedes.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const evidenceSrc = Array.isArray(o.evidence_message_ids)
      ? o.evidence_message_ids
      : [];
    const evidence_message_ids = evidenceSrc.map((x) => String(x || '').trim()).filter(Boolean);
    out.push({
      op: 'upsert',
      type: o.type,
      content,
      confidence,
      supersedes,
      evidence_message_ids,
    });
  }
  return out;
}

function applyOps(characterId: string, ops: ExtractOp[]): number {
  if (!ops.length) return 0;
  const at = nowIso();
  const getActiveSame = db.prepare(
    `SELECT id FROM memories WHERE character_id = ? AND status = 'active' AND trim(content) = ? LIMIT 1`,
  );
  const getOwned = db.prepare(`SELECT id FROM memories WHERE id = ? AND character_id = ?`);
  const markSuperseded = db.prepare(
    `UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ? AND character_id = ? AND status = 'active'`,
  );
  const insert = db.prepare(
    `INSERT INTO memories (id, character_id, type, content, evidence_json, confidence, status, supersedes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  );

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const op of ops) {
      const same = getActiveSame.get(characterId, op.content) as { id: string } | undefined;
      if (same) continue;

      const validSupersedes: string[] = [];
      for (const sid of op.supersedes || []) {
        const owned = getOwned.get(sid, characterId) as { id: string } | undefined;
        if (owned) {
          markSuperseded.run(at, sid, characterId);
          validSupersedes.push(sid);
        }
      }

      const newId = randomUUID();
      insert.run(
        newId,
        characterId,
        op.type,
        op.content,
        JSON.stringify({ message_ids: op.evidence_message_ids || [] }),
        op.confidence ?? 0.7,
        validSupersedes.length ? validSupersedes.join(',') : null,
        at,
        at,
      );
      inserted += 1;
      if (op.type === 'preference') {
        autoSupersedeDrinkConflicts(characterId, newId, op.content, at);
      }
    }
    enforceActiveCap(characterId);
  });
  tx();
  return inserted;
}

export async function extractMemoriesAfterTurn(opts: {
  characterId: string;
  conversationId: string;
}): Promise<void> {
  const { characterId, conversationId } = opts;
  const history = db
    .prepare(
      `SELECT id, role, content FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(conversationId, EXTRACT_HISTORY) as Array<{ id: string; role: string; content: string }>;
  history.reverse();

  const actives = listActiveMemories(characterId, { limit: EXTRACT_ACTIVE_CAP });
  const activeBrief = actives.map((m) => ({ id: m.id, type: m.type, content: m.content }));
  const transcript = history.map((m) => `[${m.id}] ${m.role}: ${m.content}`).join('\n');

  const system = [
    '你是私聊记忆整理器。只输出一个 JSON 对象，不要解释，不要 Markdown。',
    '从对话里提炼对该角色长期有用、可替代的稳定私档：fact / preference / promise / habit。',
    '规则：一条一事；只记稳定事实/偏好/约定/习惯；若新偏好与旧 active 私档冲突（例如把晚上喝茶改成喝温水），必须在 supersedes 写入旧 id，禁止相反偏好同时 active；冲突用 supersedes 指向旧 id；没什么可记则 {"ops":[]}；不要发明；不要把人设/性格设定写进 memories。',
    '格式：{"ops":[{"op":"upsert","type":"preference","content":"…","evidence_message_ids":["消息id"],"confidence":0.86,"supersedes":["旧id或空"]}]}',
  ].join('\n');

  const user = [
    `当前角色 active 私档（最多 ${EXTRACT_ACTIVE_CAP} 条）：`,
    JSON.stringify(activeBrief),
    '',
    '近窗对话（含 message id）：',
    transcript || '（无）',
  ].join('\n');

  let raw = '';
  try {
    raw = await chatCompletion([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[memory] extract llm failed:', msg);
    return;
  }

  let ops: ExtractOp[] = [];
  try {
    ops = parseOps(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[memory] extract parse failed:', msg, raw.slice(0, 240));
    return;
  }

  try {
    const inserted = applyOps(characterId, ops);
    if (inserted > 0) enqueueMemoryNotice(characterId, conversationId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[memory] apply failed:', msg);
  }
}


/** One unread whisper notice per extract that actually wrote memories. */
export function enqueueMemoryNotice(characterId: string, conversationId: string | null) {
  const id = randomUUID();
  const at = nowIso();
  db.prepare(
    `INSERT INTO memory_notices (id, character_id, conversation_id, created_at, read_at)
     VALUES (?, ?, ?, ?, NULL)`,
  ).run(id, characterId, conversationId, at);
  return id;
}

export type MemoryNoticeRow = {
  id: string;
  character_id: string;
  conversation_id: string | null;
  created_at: string;
  read_at: string | null;
};

export function listUnreadMemoryNotices(
  characterId: string,
  conversationId?: string | null,
): MemoryNoticeRow[] {
  if (conversationId) {
    return db
      .prepare(
        `SELECT id, character_id, conversation_id, created_at, read_at
         FROM memory_notices
         WHERE character_id = ? AND conversation_id = ? AND read_at IS NULL
         ORDER BY created_at ASC`,
      )
      .all(characterId, conversationId) as MemoryNoticeRow[];
  }
  return db
    .prepare(
      `SELECT id, character_id, conversation_id, created_at, read_at
       FROM memory_notices
       WHERE character_id = ? AND read_at IS NULL
       ORDER BY created_at ASC`,
    )
    .all(characterId) as MemoryNoticeRow[];
}

export function markMemoryNoticesRead(ids: string[]): number {
  const uniq = [...new Set(ids.map((x) => String(x || '').trim()).filter(Boolean))];
  if (!uniq.length) return 0;
  const at = nowIso();
  const stmt = db.prepare(
    `UPDATE memory_notices SET read_at = ? WHERE id = ? AND read_at IS NULL`,
  );
  const tx = db.transaction(() => {
    let n = 0;
    for (const id of uniq) n += stmt.run(at, id).changes;
    return n;
  });
  return tx();
}

export function markAllMemoryNoticesRead(characterId: string, conversationId?: string | null): number {
  const at = nowIso();
  if (conversationId) {
    return db
      .prepare(
        `UPDATE memory_notices SET read_at = ?
         WHERE character_id = ? AND conversation_id = ? AND read_at IS NULL`,
      )
      .run(at, characterId, conversationId).changes;
  }
  return db
    .prepare(
      `UPDATE memory_notices SET read_at = ?
       WHERE character_id = ? AND read_at IS NULL`,
    )
    .run(at, characterId).changes;
}

/** Fire-and-forget after private assistant reply is persisted. */
export function scheduleMemoryExtractAfterTurn(characterId: string, conversationId: string) {
  setImmediate(() => {
    void extractMemoriesAfterTurn({ characterId, conversationId }).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[memory] after_turn error:', msg);
    });
  });
}
