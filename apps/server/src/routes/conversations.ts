/**
 * Conversations & messages: private/group chat, unread cursor, voice STT path,
 * TTS cache (/api/messages/:id/tts), and B-07 assistant voice-bubble sourcing.
 * Chat turn orchestration lives in services/chatTurn.ts (D-03-a).
 */
import type { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import { db } from '../db/index.js';
import { EMOJI_WHITELIST_SET } from '../constants/emojiWhitelist.js';
import {
  isTtsCacheFileForMessage,
} from '../services/audio.js';
import { getUploadsDir } from '../db/index.js';
import { readImageFromRequest, saveImageBuffer, unlinkUploadPublicPath } from '../services/uploadImage.js';
import { handleUserMessage } from '../services/chatTurn.js';
import { handleImageMessage } from '../services/chatVisionTurn.js';
import { handleVoiceMessage } from '../services/voiceTurn.js';
import { ensureTtsCacheFile } from '../services/ttsCache.js';
import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from '../utils/time.js';

type CharacterRow = {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  system_prompt: string;
  post_history_instructions: string;
};


function loadMembers(conversationId: string) {
  return db
    .prepare(
      `SELECT ch.id, ch.name, ch.avatar_path FROM conversation_members cm
       JOIN characters ch ON ch.id = cm.character_id WHERE cm.conversation_id = ?`
    )
    .all(conversationId);
}


function isLlmFailureNotice(content: string) {
  return (content || '').includes('LLM 暂时不可用');
}


function deleteTtsForMessageIds(ids: string[]) {
  const uploads = getUploadsDir();
  let files: string[] = [];
  try {
    files = fs.readdirSync(uploads);
  } catch {
    return;
  }
  for (const id of ids) {
    for (const name of files) {
      if (!isTtsCacheFileForMessage(name, id)) continue;
      try {
        fs.unlinkSync(path.join(uploads, name));
      } catch {
        /* ignore */
      }
    }
  }
}

/** Collect image_path before rows are deleted, then wipe TTS caches + image files. */
function deleteMediaForMessages(ids: string[]) {
  if (!ids.length) return;
  const getImg = db.prepare(`SELECT image_path FROM messages WHERE id = ?`);
  const imagePaths: Array<string | null> = [];
  for (const id of ids) {
    const row = getImg.get(id) as { image_path: string | null } | undefined;
    if (row?.image_path) imagePaths.push(row.image_path);
  }
  deleteTtsForMessageIds(ids);
  for (const p of imagePaths) unlinkUploadPublicPath(p);
}

function markConversationRead(conversationId: string) {
  const last = db
    .prepare(
      `SELECT created_at FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`
    )
    .get(conversationId) as { created_at: string } | undefined;
  const at = last?.created_at || nowIso();
  db.prepare(`UPDATE conversations SET last_read_at = ? WHERE id = ?`).run(at, conversationId);
}

function unreadCountFor(conversationId: string, lastReadAt: string | null | undefined) {
  const cursor = lastReadAt || '';
  const rows = db
    .prepare(
      `SELECT content FROM messages
       WHERE conversation_id = ?
         AND role = 'assistant'
         AND created_at > ?
       ORDER BY created_at ASC, rowid ASC`
    )
    .all(conversationId, cursor) as Array<{ content: string }>;
  return rows.filter((r) => !isLlmFailureNotice(r.content)).length;
}


type MessageReactionAgg = { emoji: string; count: number; me: boolean };

function reactionsForMessages(messageIds: string[]): Map<string, MessageReactionAgg[]> {
  const out = new Map<string, MessageReactionAgg[]>();
  if (!messageIds.length) return out;
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT message_id, emoji, user_key FROM message_reactions
       WHERE message_id IN (${placeholders})
       ORDER BY created_at ASC, rowid ASC`
    )
    .all(...messageIds) as Array<{ message_id: string; emoji: string; user_key: string }>;
  const bucket = new Map<string, Map<string, { count: number; me: boolean }>>();
  for (const r of rows) {
    let byEmoji = bucket.get(r.message_id);
    if (!byEmoji) {
      byEmoji = new Map();
      bucket.set(r.message_id, byEmoji);
    }
    const cur = byEmoji.get(r.emoji) ?? { count: 0, me: false };
    cur.count += 1;
    if (r.user_key === 'me') cur.me = true;
    byEmoji.set(r.emoji, cur);
  }
  for (const [mid, byEmoji] of bucket) {
    out.set(
      mid,
      [...byEmoji.entries()].map(([emoji, v]) => ({ emoji, count: v.count, me: v.me }))
    );
  }
  return out;
}

function attachReactions<T extends { id: string }>(messages: T[]): Array<T & { reactions: MessageReactionAgg[] }> {
  const map = reactionsForMessages(messages.map((m) => m.id));
  return messages.map((m) => ({ ...m, reactions: map.get(m.id) ?? [] }));
}


export async function conversationRoutes(app: FastifyInstance) {
  app.get('/api/conversations', async () => {
    const rows = db
      .prepare(
        `SELECT c.*,
          (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_message
         FROM conversations c
         ORDER BY COALESCE(
           (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1),
           c.updated_at
         ) DESC`
      )
      .all();

    const withMembers = rows.map((c: any) => ({
      ...c,
      members: loadMembers(c.id),
      unread_count: unreadCountFor(c.id, c.last_read_at),
    }));

    return { conversations: withMembers };
  });

  app.post('/api/conversations', async (req, reply) => {
    const body = (req.body ?? {}) as {
      characterIds?: string[];
      title?: string;
      type?: 'private' | 'group';
    };
    const characterIds = body.characterIds ?? [];
    if (!characterIds.length) {
      return reply.code(400).send({ error: '至少需要一个角色 characterIds' });
    }

    const chars = characterIds
      .map((id) => db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as CharacterRow | undefined)
      .filter(Boolean) as CharacterRow[];

    if (chars.length !== characterIds.length) {
      return reply.code(400).send({ error: '部分角色不存在' });
    }

    const type = body.type ?? (chars.length > 1 ? 'group' : 'private');
    const title =
      body.title?.trim() ||
      (type === 'private' ? chars[0].name : chars.map((c) => c.name).join('、'));

    if (type === 'private' && chars.length === 1) {
      const existing = db
        .prepare(
          `SELECT c.id FROM conversations c
           WHERE c.type = 'private'
             AND (SELECT COUNT(*) FROM conversation_members cm WHERE cm.conversation_id = c.id) = 1
             AND EXISTS (
               SELECT 1 FROM conversation_members cm2
               WHERE cm2.conversation_id = c.id AND cm2.character_id = ?
             )
           ORDER BY c.created_at ASC, c.id ASC
           LIMIT 1`
        )
        .get(chars[0].id) as { id: string } | undefined;
      if (existing) {
        const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(existing.id) as Record<string, unknown>;
        return { conversation: { ...conversation, members: loadMembers(existing.id) } };
      }
    }

    const id = uuid();
    const now = nowIso();
    db.prepare(
      `INSERT INTO conversations (id, title, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run(id, title, type, now, now);

    const insertMember = db.prepare(
      `INSERT INTO conversation_members (conversation_id, character_id) VALUES (?, ?)`
    );
    for (const cid of characterIds) {
      insertMember.run(id, cid);
    }

    if (type === 'private' && chars[0].first_mes?.trim()) {
      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, character_id, content, created_at)
         VALUES (?, ?, 'assistant', ?, ?, ?)`
      ).run(uuid(), id, chars[0].id, chars[0].first_mes.trim(), now);
    }

    const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, unknown>;
    return { conversation: { ...conversation, members: loadMembers(id) } };
  });

  app.patch<{ Params: { id: string } }>('/api/conversations/:id', async (req, reply) => {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id) as
      | { id: string; type: string; title: string }
      | undefined;
    if (!conv) return reply.code(404).send({ error: '会话不存在' });

    const body = (req.body ?? {}) as { title?: string };
    const title = body.title?.trim();
    if (!title) return reply.code(400).send({ error: '群名称不能为空' });
    if (conv.type !== 'group') {
      return reply.code(400).send({ error: '仅群聊可改名' });
    }

    const now = nowIso();
    db.prepare(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`).run(
      title,
      now,
      conv.id
    );
    const updated = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id) as Record<string, unknown>;
    return { conversation: { ...updated, members: loadMembers(conv.id) } };
  });

  app.delete<{ Params: { id: string } }>('/api/conversations/:id', async (req, reply) => {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id) as
      | { id: string; type: string }
      | undefined;
    if (!conv) return reply.code(404).send({ error: '会话不存在' });

    const msgIds = (
      db.prepare(`SELECT id FROM messages WHERE conversation_id = ?`).all(conv.id) as Array<{ id: string }>
    ).map((r) => r.id);
    deleteMediaForMessages(msgIds);
    const delMessages = db.prepare(`DELETE FROM messages WHERE conversation_id = ?`);
    const delMembers = db.prepare(`DELETE FROM conversation_members WHERE conversation_id = ?`);
    const delConv = db.prepare(`DELETE FROM conversations WHERE id = ?`);
    const tx = db.transaction(() => {
      delMessages.run(conv.id);
      delMembers.run(conv.id);
      delConv.run(conv.id);
    });
    tx();
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id/messages', async (req, reply) => {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
    if (!conv) return reply.code(404).send({ error: '会话不存在' });

    const messages = db
      .prepare(
        `SELECT m.*, ch.name AS character_name
         FROM messages m
         LEFT JOIN characters ch ON ch.id = m.character_id
         WHERE m.conversation_id = ?
         ORDER BY m.created_at ASC, m.rowid ASC`
      )
      .all(req.params.id);

    markConversationRead(req.params.id);
    return { messages: attachReactions(messages as Array<{ id: string }>) };
  });

  app.delete<{ Params: { id: string; messageId: string } }>(
    '/api/conversations/:id/messages/:messageId',
    async (req, reply) => {
      const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
      if (!conv) return reply.code(404).send({ error: '会话不存在' });

      const msg = db
        .prepare(`SELECT * FROM messages WHERE id = ? AND conversation_id = ?`)
        .get(req.params.messageId, req.params.id);
      if (!msg) return reply.code(404).send({ error: '消息不存在' });

      deleteMediaForMessages([req.params.messageId]);
      db.prepare(`DELETE FROM messages WHERE id = ?`).run(req.params.messageId);
      db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(
        nowIso(),
        req.params.id
      );
      return { ok: true };
    }
  );

  app.post<{ Params: { id: string; messageId: string } }>(
    '/api/conversations/:id/messages/:messageId/reactions',
    async (req, reply) => {
      const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
      if (!conv) return reply.code(404).send({ error: '会话不存在' });

      const msg = db
        .prepare(`SELECT * FROM messages WHERE id = ? AND conversation_id = ?`)
        .get(req.params.messageId, req.params.id);
      if (!msg) return reply.code(404).send({ error: '消息不存在' });

      const body = (req.body ?? {}) as { emoji?: string };
      const emoji = typeof body.emoji === 'string' ? body.emoji.trim() : '';
      if (!emoji || !EMOJI_WHITELIST_SET.has(emoji)) {
        return reply.code(400).send({ error: '表情不在白名单' });
      }

      const existing = db
        .prepare(
          `SELECT 1 FROM message_reactions WHERE message_id = ? AND emoji = ? AND user_key = 'me'`
        )
        .get(req.params.messageId, emoji);

      if (existing) {
        db.prepare(
          `DELETE FROM message_reactions WHERE message_id = ? AND emoji = ? AND user_key = 'me'`
        ).run(req.params.messageId, emoji);
      } else {
        db.prepare(
          `INSERT INTO message_reactions (message_id, emoji, user_key, created_at) VALUES (?, ?, 'me', ?)`
        ).run(req.params.messageId, emoji, nowIso());
      }

      const reactions = reactionsForMessages([req.params.messageId]).get(req.params.messageId) ?? [];
      return { ok: true, message_id: req.params.messageId, reactions };
    }
  );


  app.delete<{ Params: { id: string } }>('/api/conversations/:id/messages', async (req, reply) => {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
    if (!conv) return reply.code(404).send({ error: '会话不存在' });

    const msgIds = (
      db.prepare(`SELECT id FROM messages WHERE conversation_id = ?`).all(req.params.id) as Array<{
        id: string;
      }>
    ).map((r) => r.id);
    deleteMediaForMessages(msgIds);
    db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(req.params.id);
    db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(
      nowIso(),
      req.params.id
    );
    return { ok: true };
  });


  app.post<{ Params: { id: string } }>('/api/conversations/:id/messages', async (req, reply) => {
    const body = (req.body ?? {}) as { content?: string; mentionCharacterId?: string };
    return handleUserMessage(
      reply,
      req.params.id,
      body.content || '',
      body.mentionCharacterId,
      'text'
    );
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/messages/voice', async (req, reply) => {
    const conversationId = req.params.id;
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    if (!conv) return reply.code(404).send({ error: '会话不存在' });

    let audioBuf: Buffer | null = null;
    let filename = 'audio.wav';
    let mime = 'audio/wav';
    let mentionCharacterId: string | undefined;

    try {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'file' && (part.fieldname === 'file' || part.fieldname === 'audio')) {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          audioBuf = Buffer.concat(chunks);
          filename = part.filename || filename;
          mime = part.mimetype || mime;
        } else if (part.type === 'field' && part.fieldname === 'mentionCharacterId') {
          const v = String(part.value || '').trim();
          if (v) mentionCharacterId = v;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ error: `读取录音失败：${msg}` });
    }

    if (!audioBuf || audioBuf.length < 64) {
      return reply.code(400).send({ error: '录音为空，请按住说话后再试' });
    }

    return handleVoiceMessage(reply, conversationId, audioBuf, filename, mime, mentionCharacterId);
  });

  
  // B-04A: private chat image + vision reply (group: store only)
  app.post<{ Params: { id: string } }>('/api/conversations/:id/messages/image', async (req, reply) => {
    const conversationId = req.params.id;
    const convRow = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) as
      | { id: string; type: string }
      | undefined;
    if (!convRow) return reply.code(404).send({ error: '会话不存在' });

    let saved: { publicPath: string; filename: string; absPath: string };
    let mime = 'image/jpeg';
    try {
      const got = await readImageFromRequest(req);
      mime = got.mime || mime;
      saved = saveImageBuffer(got.buffer, got.ext, 'chat-img');
    } catch (e) {
      const status = (e as any)?.statusCode || 500;
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(status >= 400 && status < 600 ? status : 500).send({ error: msg });
    }

    return handleImageMessage(conversationId, convRow, saved, mime, markConversationRead);
  });


app.get<{ Params: { id: string } }>('/api/messages/:id/tts', async (req, reply) => {
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id) as
      | { id: string; content: string; role: string; character_id: string | null }
      | undefined;
    if (!msg) return reply.code(404).send({ error: '消息不存在' });

    const ch =
      msg.role !== 'user' && msg.character_id
        ? (db
            .prepare('SELECT name, raw_json FROM characters WHERE id = ?')
            .get(msg.character_id) as { name: string; raw_json: string | null } | undefined)
        : undefined;
    const tts = await ensureTtsCacheFile(msg, ch);
    if ('error' in tts) return reply.code(502).send({ error: tts.error });
    const filePath = tts.filePath;

    reply.header('Content-Type', 'audio/mpeg');
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(fs.createReadStream(filePath));
  });

}
