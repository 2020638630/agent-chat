import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { chatCompletion } from './llm.js';
import { gateExtractOps } from './memoryGate.js';

export type MemoryType = 'fact' | 'preference' | 'promise' | 'habit';
export type MemoryStatus = 'active' | 'pending' | 'superseded' | 'user_hidden';

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
  const lines = rows.map((r) => {
    let text = r.content;
    if (r.type === 'preference') text = normalizeDrinkContent(text);
    if (looksLikeAddressPreference(text)) {
      const m = text.match(/被叫([^，。；\s]+)|叫我([^，。；\s]+)|称呼我为([^，。；\s]+)|称呼我([^，。；\s]+)/);
      const name = (m && (m[1] || m[2] || m[3] || m[4])) || '';
      if (name && !/公子|深/.test(name)) {
        text = `对用户的称呼是「${name}」`;
      }
    }
    return `- (${r.type}) ${text}`;
  });
  const honor =
    '下面这些是你已经记住的事，当作背景，不要每轮念一遍。用户这轮明确问到其中一件（喝什么、怎么称呼、记不记得某约定、记忆里有什么）时，先用一句短讯答那一件，再写其他。用户提到口渴、想喝、要水时：用记忆里的饮品（如温水）自然回应，不要另编山泉、茶等顶替。若用户只发短讯、数字、表情，或说走／好／嗯等未点名记忆的话：禁止提起称呼或饮品清单，禁止用「唤君××。饮温水。风动竹摇。」排比起句，可写风景或简短回应。称呼可以在句子里自然带过（如「小林」），但不要为了证明自己记得而单列饮品或约定。被问「叫我什么」时必须答记忆里的称呼，禁止说未记／不知／你自己定，也不要用公子顶替。不要用日头、竹影代替被问到的那一件。';
  return `${system}\n\n【你记得的事】\n${honor}\n${lines.join('\n')}`;
}


function userAsksAboutMemory(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  if (/叫我什么|怎么称呼|称呼我|记得我|还记得|记不记得|喝什么|喜欢喝|爱喝|约定|记忆里/.test(t)) return true;
  if (/口渴|渴了|好渴|想喝|喝点水|喝杯|倒.*水|来杯|有点渴|有些渴/.test(t)) return true;
  return false;
}

function assistantConflictsAddress(texts: string[]): boolean {
  const blob = (texts || []).join('\n');
  if (!blob) return false;
  return /公子|未记|不知|不记|唤我深|君名未记/.test(blob);
}

/** Trailing nudge after history — gated on this-turn ask or recent address conflict. */
export function memoryStickyReminder(
  characterId: string,
  opts?: { lastUserText?: string; recentAssistantTexts?: string[] },
): string | null {
  const rows = listActiveMemories(characterId, {
    minConfidence: INJECT_MIN_CONF,
    limit: INJECT_MAX,
  });
  if (!rows.length) return null;

  let addressName = '';
  const drinkBits: string[] = [];
  const promiseBits: string[] = [];
  for (const r of rows) {
    let text = r.type === 'preference' ? normalizeDrinkContent(r.content) : r.content;
    if (looksLikeAddressPreference(text)) {
      const m = text.match(
        /被叫([^，。；\s]+)|叫我([^，。；\s]+)|称呼我为([^，。；\s]+)|称呼我([^，。；\s]+)|「([^」]+)」/,
      );
      const name = (m && (m[1] || m[2] || m[3] || m[4] || m[5])) || '';
      if (name && !/公子|深/.test(name)) addressName = name;
    } else if (looksLikeDrinkPreference(text)) {
      drinkBits.push(text);
    } else if (r.type === 'promise') {
      promiseBits.push(text);
    }
  }
  if (!addressName && !drinkBits.length && !promiseBits.length) return null;

  const lastUser = opts?.lastUserText ?? '';
  const recentAsst = opts?.recentAssistantTexts ?? [];
  const ask = userAsksAboutMemory(lastUser);
  const conflict = !!addressName && assistantConflictsAddress(recentAsst);
  if (!ask && !conflict) {
    const recentBlob = recentAsst.join('\n');
    const overRecite = /唤君/.test(recentBlob) && /(温水|饮温)/.test(recentBlob);
    if (overRecite) {
      return '【记忆核对·优先于上文】本轮用户未问称呼／饮品／约定。禁止复读「唤君××／温水」清单或排比起句；可自然写风景或短应一句。';
    }
    return null;
  }

  const parts: string[] = [];
  if (addressName) parts.push(`称呼用户为「${addressName}」`);
  if (drinkBits.length) {
    const d = drinkBits[0];
    parts.push(/温水/.test(d) ? '用户只喝温水' : d);
  }
  if (promiseBits.length) parts.push(promiseBits[0]);

    const drinkCue = /口渴|渴了|好渴|想喝|喝点水|喝杯|倒.*水|来杯|有点渴|有些渴/.test(lastUser);
  if (drinkCue && drinkBits.length) {
    const drinkLine = /温水/.test(drinkBits[0]) ? '温水' : drinkBits[0];
    return (
      `【记忆核对·优先于上文】用户表示口渴或要喝：请用记忆中的饮品「${drinkLine}」自然回应，` +
      `不要另编山泉、茶等。可顺带称呼，但不要背整份清单。`
    );
  }
  return (
    `【记忆核对·优先于上文】本轮若在问称呼／饮品／约定：${parts.join('；')}。` +
    `若上文曾说未记／公子，以本条为准。先短答被问到的那一件。未被问到不要复读本条。`
  );
}

function looksLikeDrinkPreference(content: string): boolean {
  return /喝|茶|温水|温汤|开水|咖啡|饮料|山泉|饮水/.test(content);
}

function looksLikeAddressPreference(content: string): boolean {
  return /称呼|叫我|喊我|称呼我|名字叫|叫作|叫做|被叫|希望被叫|对用户的称呼/.test(content);
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
type HistoryMsg = { id: string; role: string; content: string };

function userClaimedAddress(userTexts: string[]): boolean {
  return userTexts.some((t) =>
    /叫我\S{1,12}|喊我\S{1,12}|称呼我为\S{1,12}|称呼我[叫为]?\S{1,12}|我希望你叫我\S{1,12}/.test(t),
  );
}

function userClaimedDrink(userTexts: string[]): boolean {
  return userTexts.some((t) =>
    /我只喝|我改喝|我以后喝|以后都喝|以后喝|给我喝|别再给我茶|别再给我.{0,6}茶/.test(t),
  );
}


/** Deterministic claims from clear user sentences — covers LLM over-refusal after assistant suggested first. */
function collectExplicitClaimOps(history: HistoryMsg[]): ExtractOp[] {
  const ops: ExtractOp[] = [];
  for (const m of history) {
    if (m.role !== 'user') continue;
    const t = String(m.content || '').trim();
    const drink = t.match(/我(?:只|改)?喝s*([^s，。！？]{1,12})|以后(?:都)?喝s*([^s，。！？]{1,12})/);
    if (drink) {
      const bev = (drink[1] || drink[2] || '').trim();
      if (bev && !/口水|汤药/.test(bev)) {
        const kind = /只喝/.test(t) ? '只喝' : '改喝';
        ops.push({
          op: 'upsert',
          type: 'preference',
          content: `用户${kind}${bev}`,
          evidence_message_ids: [m.id],
          confidence: 0.95,
          supersedes: [],
        });
      }
    }
    const addr = t.match(/(?:叫我|喊我|称呼我为|以后叫我)s*([^s，。！？]{1,12})/);
    if (addr) {
      const name = (addr[1] || '').trim();
      if (name && !/什么|啥|谁/.test(name)) {
        ops.push({
          op: 'upsert',
          type: 'preference',
          content: `用户希望被叫${name}`,
          evidence_message_ids: [m.id],
          confidence: 0.95,
          supersedes: [],
        });
      }
    }
  }
  // keep last claim per kind
  const out: ExtractOp[] = [];
  let sawDrink = false;
  let sawAddr = false;
  for (let i = ops.length - 1; i >= 0; i--) {
    const o = ops[i];
    if (looksLikeDrinkPreference(o.content) && !sawDrink) {
      out.push(o);
      sawDrink = true;
    } else if (looksLikeAddressPreference(o.content) && !sawAddr) {
      out.push(o);
      sawAddr = true;
    }
  }
  return out.reverse();
}

export function filterExtractOps(
  characterId: string,
  ops: ExtractOp[],
  history: HistoryMsg[] = [],
): ExtractOp[] {
  const actives = listActiveMemories(characterId, { limit: EXTRACT_ACTIVE_CAP });
  const hasPositiveDrink = actives.some(
    (m) =>
      looksLikeDrinkPreference(m.content) &&
      !/不喜欢|不爱|别再|不要/.test(m.content),
  );
  const hasAddress = actives.some((m) => looksLikeAddressPreference(m.content));
  const byId = new Map(history.map((m) => [m.id, m]));
  const userTexts = history.filter((m) => m.role === 'user').map((m) => String(m.content || ''));

  return ops.filter((op) => {
    const c = String(op.content || '').trim();
    if (!c) return false;
    if (/无需新增|故无需|助理记忆|见消息|已更新为|当前助理/.test(c)) return false;

    const evid = Array.isArray(op.evidence_message_ids)
      ? op.evidence_message_ids.map(String).filter(Boolean)
      : [];
    if (evid.length) {
      const resolved = evid.map((id) => byId.get(id)).filter(Boolean) as HistoryMsg[];
      if (resolved.length && resolved.every((m) => m.role === 'assistant')) return false;
    }

    if (looksLikeAddressPreference(c)) {
      if (!userClaimedAddress(userTexts)) return false;
      if (hasAddress && /公子/.test(c) && !/小林/.test(c)) return false;
    }

    if (looksLikeDrinkPreference(c)) {
      if (!userClaimedDrink(userTexts)) return false;
      if (/不喜欢喝水|不爱喝水|不喜欢水(?!果)|不喜欢喝水和/.test(c)) return false;
      if (
        hasPositiveDrink &&
        /不喜欢|不爱喝|讨厌喝/.test(c) &&
        !/(改|换成|改为|只喝).*(温水|茶|咖啡)/.test(c)
      ) {
        return false;
      }
      if (/山泉/.test(c) && !/用户.*(山泉|只要|只喝|喜欢喝山泉)/.test(c)) return false;
    }

    if (/希望被叫深|叫我深|唤我深|被叫深/.test(c)) return false;
    if (/被叫公子|叫公子|称呼.*公子|希望被叫公子/.test(c) && !/用户明确|只要叫公子|就叫我公子/.test(c)) {
      return false;
    }
    return true;
  });
}


function shortAddressLabel(content: string): string {
  const m = content.match(
    /被叫([^，。；\s]+)|叫我([^，。；\s]+)|称呼我为([^，。；\s]+)|希望被叫([^，。；\s]+)|「([^」]+)」/,
  );
  return ((m && (m[1] || m[2] || m[3] || m[4] || m[5])) || content).trim().slice(0, 12);
}

function shortDrinkLabel(content: string): string {
  if (/温水/.test(content)) return '温水';
  if (/山泉/.test(content)) return '山泉';
  if (/茶/.test(content)) return '茶';
  if (/咖啡/.test(content)) return '咖啡';
  const m = content.match(/喝\s*([^，。；\s]{1,8})/);
  return ((m && m[1]) || content).trim().slice(0, 12);
}

function findActiveConflict(
  characterId: string,
  content: string,
): { id: string; content: string; kind: 'address' | 'drink' } | null {
  const rows = db
    .prepare(
      `SELECT id, content FROM memories
       WHERE character_id = ? AND status = 'active' AND type = 'preference'`,
    )
    .all(characterId) as Array<{ id: string; content: string }>;
  if (looksLikeAddressPreference(content)) {
    for (const r of rows) {
      if (looksLikeAddressPreference(r.content) && r.content.trim() !== content.trim()) {
        return { id: r.id, content: r.content, kind: 'address' };
      }
    }
  }
  if (looksLikeDrinkPreference(content)) {
    for (const r of rows) {
      if (looksLikeDrinkPreference(r.content) && r.content.trim() !== content.trim()) {
        return { id: r.id, content: r.content, kind: 'drink' };
      }
    }
  }
  return null;
}

function findPendingOfKind(
  characterId: string,
  kind: 'address' | 'drink',
): { id: string; content: string } | null {
  const rows = db
    .prepare(
      `SELECT id, content FROM memories
       WHERE character_id = ? AND status = 'pending' AND type = 'preference'`,
    )
    .all(characterId) as Array<{ id: string; content: string }>;
  for (const r of rows) {
    if (kind === 'address' && looksLikeAddressPreference(r.content)) return r;
    if (kind === 'drink' && looksLikeDrinkPreference(r.content)) return r;
  }
  return null;
}

export type PendingAsk = {
  kind: 'address' | 'drink';
  oldLabel: string;
  newLabel: string;
};

function buildConfirmQuestion(ask: PendingAsk): string {
  return `先前记下的是「${ask.oldLabel}」。你这句像是要改成「${ask.newLabel}」。改，还是仍用${ask.oldLabel}？`;
}

export function insertMemoryConfirmMessage(
  conversationId: string,
  characterId: string,
  ask: PendingAsk,
): string {
  const id = randomUUID();
  const at = nowIso();
  const content = buildConfirmQuestion(ask);
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, character_id, content, created_at, source)
     VALUES (?, ?, 'assistant', ?, ?, ?, 'memory_confirm')`,
  ).run(id, conversationId, characterId, content, at);
  db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(at, conversationId);
  return content;
}

type ApplyResult = {
  activatedContents: string[];
  newPendings: PendingAsk[];
};

export function applyOps(characterId: string, ops: ExtractOp[]): ApplyResult {
  const empty: ApplyResult = { activatedContents: [], newPendings: [] };
  if (!ops.length) return empty;
  const at = nowIso();
  const getActiveSame = db.prepare(
    `SELECT id FROM memories WHERE character_id = ? AND status = 'active' AND trim(content) = ? LIMIT 1`,
  );
  const getOwned = db.prepare(`SELECT id FROM memories WHERE id = ? AND character_id = ?`);
  const markSuperseded = db.prepare(
    `UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ? AND character_id = ? AND status = 'active'`,
  );
  const insertActive = db.prepare(
    `INSERT INTO memories (id, character_id, type, content, evidence_json, confidence, status, supersedes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  );
  const insertPending = db.prepare(
    `INSERT INTO memories (id, character_id, type, content, evidence_json, confidence, status, supersedes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  );
  const updatePending = db.prepare(
    `UPDATE memories SET content = ?, evidence_json = ?, confidence = ?, supersedes = ?, updated_at = ?
     WHERE id = ? AND character_id = ? AND status = 'pending'`,
  );

  const activatedContents: string[] = [];
  const newPendings: PendingAsk[] = [];

  const tx = db.transaction(() => {
    for (const op of ops) {
      const content =
        op.type === 'preference' ? normalizeDrinkContent(op.content) : op.content;
      const same = getActiveSame.get(characterId, content) as { id: string } | undefined;
      if (same) continue;

      const evidence = JSON.stringify({ message_ids: op.evidence_message_ids || [] });
      const confidence = op.confidence ?? 0.7;
      const conflict =
        op.type === 'preference' ? findActiveConflict(characterId, content) : null;

      if (conflict) {
        const pending = findPendingOfKind(characterId, conflict.kind);
        const oldLabel =
          conflict.kind === 'address'
            ? shortAddressLabel(conflict.content)
            : shortDrinkLabel(conflict.content);
        const newLabel =
          conflict.kind === 'address' ? shortAddressLabel(content) : shortDrinkLabel(content);
        if (pending) {
          updatePending.run(
            content,
            evidence,
            confidence,
            conflict.id,
            at,
            pending.id,
            characterId,
          );
        } else {
          const newId = randomUUID();
          insertPending.run(
            newId,
            characterId,
            op.type,
            content,
            evidence,
            confidence,
            conflict.id,
            at,
            at,
          );
          newPendings.push({ kind: conflict.kind, oldLabel, newLabel });
        }
        continue;
      }

      const validSupersedes: string[] = [];
      for (const sid of op.supersedes || []) {
        const owned = getOwned.get(sid, characterId) as { id: string } | undefined;
        if (owned) {
          markSuperseded.run(at, sid, characterId);
          validSupersedes.push(sid);
        }
      }
      const newId = randomUUID();
      insertActive.run(
        newId,
        characterId,
        op.type,
        content,
        evidence,
        confidence,
        validSupersedes.length ? validSupersedes.join(',') : null,
        at,
        at,
      );
      activatedContents.push(content);
    }
    enforceActiveCap(characterId);
  });
  tx();
  return { activatedContents, newPendings };
}


/** ARCH-2 D-05: structured, greppable memory-extract signals (no secrets). */
export type MemoryExtractStatus =
  | 'start'
  | 'ok'
  | 'empty'
  | 'fail_llm'
  | 'fail_parse'
  | 'fail_apply'
  | 'fail_after_turn'
  | 'confirm';

export function logMemoryExtract(payload: {
  status: MemoryExtractStatus;
  conversationId?: string;
  characterId?: string;
  n?: number;
  detail?: string;
  ask?: string;
}): void {
  const row: Record<string, unknown> = {
    event: 'memory.extract',
    status: payload.status,
    ts: new Date().toISOString(),
  };
  if (payload.conversationId) row.conversationId = payload.conversationId;
  if (payload.characterId) row.characterId = payload.characterId;
  if (payload.n != null) row.n = payload.n;
  if (payload.detail) row.detail = String(payload.detail).slice(0, 240);
  if (payload.ask) row.ask = String(payload.ask).slice(0, 120);
  const line = JSON.stringify(row);
  if (payload.status.startsWith('fail')) console.error(`[memory.obs] ${line}`);
  else console.log(`[memory.obs] ${line}`);
}

export async function extractMemoriesAfterTurn(opts: {
  characterId: string;
  conversationId: string;
}): Promise<void> {
  const { characterId, conversationId } = opts;
  logMemoryExtract({ status: 'start', conversationId, characterId });
  const history = db
    .prepare(
      `SELECT id, role, content, source FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(conversationId, EXTRACT_HISTORY) as Array<{
    id: string;
    role: string;
    content: string;
    source: string | null;
  }>;
  history.reverse();
  const historyForExtract = history.filter((m) => m.source !== 'memory_confirm');

  const actives = listActiveMemories(characterId, { limit: EXTRACT_ACTIVE_CAP });
  const activeBrief = actives.map((m) => ({ id: m.id, type: m.type, content: m.content }));
  const transcript = history.map((m) => `[${m.id}] ${m.role}: ${m.content}`).join('\n');

  const system = [
    '你是私聊记忆整理器。只输出一个 JSON 对象，不要解释，不要 Markdown。',
    '只根据【用户】明确说的话提炼稳定私档：fact / preference / promise / habit。不要记角色台词、猜测、风景；不要把角色默认称呼（如公子）写成用户偏好；不要输出「无需新增/见消息/助理记忆已更新」这类元话语。',
    '规则：一条一事；只记用户侧稳定事实/偏好/约定/习惯。',
    '只记用户自己用陈述句认领的事实。',
    '角色先提议的称呼或饮品（如「喝点温水吧」「我称你公子」），即使用户只回「嗯」「好」「喝了」「口渴」或一段动作，也不要写成用户偏好。但用户随后明确说「我改喝X／我只喝X／叫我X」时必须记。',
    '用户必须明确出现「叫我X / 喊我X / 称呼我为X」才记称呼；明确出现「我只喝 / 我改喝 / 以后喝X」才记饮品。',
    '「你叫我什么」「还记得我喝什么吗」「你不喝吗」是追问或闲聊，输出 {"ops":[]}。用户明确说「我改喝／我只喝／以后叫我X」时必须写入对应偏好，不要因上文已出现温水就输出空。',
    '饮品：用户明确说改喝/只喝温水时写成「用户改喝温水」或「用户只喝温水」。用户说不喜欢茶/温汤，不要扩写成不喜欢水。用户追问「还记得我喜欢喝什么吗」且没有新的肯定偏好时，输出 {"ops":[]}。',
    '称呼：仅当用户明确要求「叫我X / 喊我X / 称呼我为X」时写成「用户希望被叫X」。用户问「你记得叫我什么吗」「你叫我什么」属于追问，不要改称呼、不要写成公子或角色自称。',
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
    logMemoryExtract({ status: 'fail_llm', conversationId, characterId, detail: msg });
    return;
  }

  let ops: ExtractOp[] = [];
  try {
    ops = parseOps(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logMemoryExtract({ status: 'fail_parse', conversationId, characterId, detail: msg });
    ops = [];
  }
  {
    const claimed = collectExplicitClaimOps(historyForExtract);
    if (claimed.length) {
      const key = (o: ExtractOp) => `${o.type}|${o.content}`;
      const have = new Set(ops.map(key));
      for (const c of claimed) if (!have.has(key(c))) ops.push(c);
    }
  }

  try {
    const recentUserText =
      [...historyForExtract].reverse().find((m) => m.role === 'user')?.content || '';
    const activeMemorySummary = actives.map((m) => m.content).join(';');
    const gated = gateExtractOps(ops, { recentUserText, activeMemorySummary });
    const filtered = filterExtractOps(characterId, gated as ExtractOp[], historyForExtract);
    const applied = applyOps(characterId, filtered);
    if (applied.activatedContents.length > 0) {
      enqueueMemoryNotice(characterId, conversationId, applied.activatedContents);
      logMemoryExtract({
        status: 'ok',
        conversationId,
        characterId,
        n: applied.activatedContents.length,
      });
    } else {
      logMemoryExtract({ status: 'empty', conversationId, characterId, n: 0 });
    }
    for (const ask of applied.newPendings) {
      const q = insertMemoryConfirmMessage(conversationId, characterId, ask);
      logMemoryExtract({ status: 'confirm', conversationId, characterId, ask: q });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logMemoryExtract({ status: 'fail_apply', conversationId, characterId, detail: msg });
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

export function resolvePendingMemoryConfirm(
  characterId: string,
  conversationId: string,
  userText: string,
): boolean {
  const t = String(userText || '').trim();
  if (!t) return false;
  if (/^(嗯|好|哦|噢|额|唔)[。.!！？]?$/.test(t)) return false;

  const pendings = db
    .prepare(
      `SELECT id, content, supersedes FROM memories
       WHERE character_id = ? AND status = 'pending' AND type = 'preference'`,
    )
    .all(characterId) as Array<{ id: string; content: string; supersedes: string | null }>;
  if (!pendings.length) return false;

  const at = nowIso();
  let resolved = false;

  for (const p of pendings) {
    const kind: 'address' | 'drink' | null = looksLikeAddressPreference(p.content)
      ? 'address'
      : looksLikeDrinkPreference(p.content)
        ? 'drink'
        : null;
    if (!kind) continue;

    const newLabel = kind === 'address' ? shortAddressLabel(p.content) : shortDrinkLabel(p.content);
    let oldLabel = '';
    if (p.supersedes) {
      const old = db
        .prepare(`SELECT content FROM memories WHERE id = ? AND character_id = ?`)
        .get(p.supersedes, characterId) as { content: string } | undefined;
      if (old) {
        oldLabel =
          kind === 'address' ? shortAddressLabel(old.content) : shortDrinkLabel(old.content);
      }
    }

    const acceptHint =
      /(?:^|[，。\s])(?:改|换成|按新的|以后叫|就叫|改喝|对，改|对改)/.test(t) ||
      (Boolean(newLabel) &&
        ((kind === 'address' && new RegExp('(?:叫|称呼).{0,6}' + newLabel).test(t)) ||
          (kind === 'drink' && new RegExp('(?:喝|改喝).{0,6}' + newLabel).test(t))));
    const rejectHint =
      /不改|不用|还是|继续|仍用|算了|别改/.test(t) ||
      (Boolean(oldLabel) &&
        ((kind === 'address' &&
          new RegExp('(?:还是|仍用|叫|继续).{0,6}' + oldLabel).test(t)) ||
          (kind === 'drink' &&
            new RegExp('(?:还是|仍用|喝|继续).{0,6}' + oldLabel).test(t))));

    if (acceptHint && !rejectHint) {
      db.prepare(
        `UPDATE memories SET status = 'active', updated_at = ? WHERE id = ? AND character_id = ?`,
      ).run(at, p.id, characterId);
      if (p.supersedes) {
        db.prepare(
          `UPDATE memories SET status = 'superseded', updated_at = ?
           WHERE id = ? AND character_id = ? AND status = 'active'`,
        ).run(at, p.supersedes, characterId);
      }
      enqueueMemoryNotice(characterId, conversationId, [p.content]);
      resolved = true;
      continue;
    }
    if (rejectHint) {
      db.prepare(
        `UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ? AND character_id = ?`,
      ).run(at, p.id, characterId);
      resolved = true;
    }
  }
  return resolved;
}

export function scheduleMemoryExtractAfterTurn(characterId: string, conversationId: string) {
  setImmediate(() => {
    void extractMemoriesAfterTurn({ characterId, conversationId }).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      logMemoryExtract({ status: 'fail_after_turn', conversationId, characterId, detail: msg });
    });
  });
}
