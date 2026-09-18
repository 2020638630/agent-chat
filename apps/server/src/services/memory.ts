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
  const lines = rows.map((r) => `- (${r.type}) ${r.type === 'preference' ? normalizeDrinkContent(r.content) : r.content}`);
  const honor =
    '下面这些是你已经记住的事。用户问到其中任何一件（喝什么、怎么称呼、约定），必须先用一句短讯答这一件，再写风景或其他。不要用日头、竹影、出门、留步来代替回答。不要把互相冲突的旧偏好并成一句。';
  return `${system}\n\n【你记得的事】\n${honor}\n${lines.join('\n')}`;
}

function looksLikeDrinkPreference(content: string): boolean {
  return /喝|茶|温水|温汤|开水|咖啡|饮料|山泉|饮水/.test(content);
}

function looksLikeAddressPreference(content: string): boolean {
  return /称呼|叫我|喊我|称呼我|名字叫|叫作|叫做/.test(content);
}

function normalizeDrinkContent(content: string): string {
  const t = content.trim();
  if (/温水|温开水/.test(t) && /茶|咖啡/.test(t) && /(改|换成|改为|只要|只喝)/.test(t)) {
    if (/只喝/.test(t)) return '用户只喝温水';
    return '用户改喝温水';
  }
  return content;
}

function autoSupersedeAddressConflicts(
  characterId: string,
  newId: string,
  content: string,
  at: string,
) {
  if (!looksLikeAddressPreference(content)) return;
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
    if (looksLikeAddressPreference(o.content) && o.content.trim() !== content.trim()) {
      mark.run(at, o.id, characterId);
    }
  }
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


/** Drop quiz/negation noise that would erase a stable drink preference. */
function filterExtractOps(characterId: string, ops: ExtractOp[]): ExtractOp[] {
  const actives = listActiveMemories(characterId, { limit: EXTRACT_ACTIVE_CAP });
  const hasPositiveDrink = actives.some(
    (m) =>
      m.status === 'active' &&
      looksLikeDrinkPreference(m.content) &&
      !/不喜欢|不爱|别再|不要/.test(m.content),
  );
  return ops.filter((op) => {
    const c = String(op.content || '').trim();
    if (!c) return false;
    // Rhetorical / quiz turns must not invent dislikes.
    if (/不喜欢喝水|不爱喝水|不喜欢水(?!果)|不喜欢喝水和/.test(c)) return false;
    if (hasPositiveDrink && looksLikeDrinkPreference(c) && /不喜欢|不爱喝|讨厌喝/.test(c) && !/(改|换成|改为|只喝).*(温水|茶|咖啡)/.test(c)) {
      return false;
    }
    // Assistant-flavored spring-water guesses without clear user claim.
    if (/山泉/.test(c) && !/用户.*(山泉|只要|只喝|喜欢喝山泉)/.test(c)) return false;
    return true;
  });
}

function applyOps(characterId: string, ops: ExtractOp[]): string[] {
  if (!ops.length) return [];
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

  const insertedContents: string[] = [];
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
      const content =
        op.type === 'preference' ? normalizeDrinkContent(op.content) : op.content;
      insert.run(
        newId,
        characterId,
        op.type,
        content,
        JSON.stringify({ message_ids: op.evidence_message_ids || [] }),
        op.confidence ?? 0.7,
        validSupersedes.length ? validSupersedes.join(',') : null,
        at,
        at,
      );
      insertedContents.push(content);
      if (op.type === 'preference') {
        autoSupersedeDrinkConflicts(characterId, newId, content, at);
        autoSupersedeAddressConflicts(characterId, newId, content, at);
      }
    }
    enforceActiveCap(characterId);
  });
  tx();
  return insertedContents;
}

export async function extractMemoriesAfterTurn(opts: {
  characterId: string;
  conversationId: string;
}): Promise<void> {
  const { characterId, conversationId } = opts;
  console.log(`[memory] extract start conv=${conversationId} char=${characterId}`);
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
    '只根据【用户】明确说的话提炼稳定私档：fact / preference / promise / habit。不要记角色台词、猜测、风景，也不要把角色提议当成用户偏好。',
    '规则：一条一事；只记用户侧稳定事实/偏好/约定/习惯。',
    '饮品：用户明确说改喝/只喝温水时写成「用户改喝温水」或「用户只喝温水」。用户说不喜欢茶/温汤，不要扩写成不喜欢水。用户在追问「还记得我喜欢喝什么吗」「我喜欢什么水」时，若没有新的肯定偏好，输出 {"ops":[]}，不要发明厌恶或新口味。',
    '称呼：写成「用户希望被叫…」。',
    '冲突：新偏好与旧 active 冲突（喝什么、怎么称呼）必须在 supersedes 写旧 id。没什么可记则 {"ops":[]}；不要发明。',
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
    console.error('[memory] extract fail llm:', msg);
    return;
  }

  let ops: ExtractOp[] = [];
  try {
    ops = parseOps(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[memory] extract fail parse:', msg);
    return;
  }

  try {
    const insertedContents = applyOps(characterId, filterExtractOps(characterId, ops));
    if (insertedContents.length > 0) {
      enqueueMemoryNotice(characterId, conversationId, insertedContents);
      console.log(`[memory] extract ok conv=${conversationId} char=${characterId} n=${insertedContents.length}`);
    } else {
      console.log(`[memory] extract empty conv=${conversationId} char=${characterId}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[memory] extract fail apply:', msg);
  }
}


/** One unread whisper notice per extract that actually wrote memories. */
export function enqueueMemoryNotice(
  characterId: string,
  conversationId: string | null,
  contents: string[],
) {
  const id = randomUUID();
  const at = nowIso();
  const summary = contents
    .map((c) => String(c || '').trim())
    .filter(Boolean)
    .slice(0, 3)
    .join('；')
    .slice(0, 160);
  db.prepare(
    `INSERT INTO memory_notices (id, character_id, conversation_id, summary, created_at, read_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(id, characterId, conversationId, summary || '新的记忆', at);
  return id;
}

export type MemoryNoticeRow = {
  id: string;
  character_id: string;
  conversation_id: string | null;
  summary: string;
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
        `SELECT id, character_id, conversation_id, summary, created_at, read_at
         FROM memory_notices
         WHERE character_id = ? AND conversation_id = ? AND read_at IS NULL
         ORDER BY created_at ASC`,
      )
      .all(characterId, conversationId) as MemoryNoticeRow[];
  }
  return db
    .prepare(
      `SELECT id, character_id, conversation_id, summary, created_at, read_at
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
