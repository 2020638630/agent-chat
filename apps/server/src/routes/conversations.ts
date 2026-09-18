/**
 * Conversations & messages: private/group chat, unread cursor, voice STT path,
 * TTS cache (/api/messages/:id/tts), and B-07 assistant voice-bubble sourcing.
 */
import type { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import { db } from '../db/index.js';
import { buildSystemPrompt } from '../utils/characterCard.js';
import { emojiConstraintForPrompt, hasEmojiToken, sanitizeAssistantEmoji } from '../constants/emojiWhitelist.js';
import { shouldAssistantUseVoice } from '../utils/voiceRequest.js';
import { chatCompletion } from '../services/llm.js';
import { appendMemoryBlock, memoryStickyReminder, scheduleMemoryExtractAfterTurn } from '../services/memory.js';
import { onPrivateUserMessage } from '../services/proactive.js';
import {
  isTtsCacheFileForMessage,
  resolveCharacterVoiceKind,
  synthesizeSpeech,
  ttsFilename,
  transcribeAudio,
  voiceForKind,
} from '../services/audio.js';
import { getUploadsDir } from '../db/index.js';
import { readImageFromRequest, saveImageBuffer, unlinkUploadPublicPath } from '../services/uploadImage.js';
import fs from 'node:fs';
import path from 'node:path';

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

type MessageRow = {
  id: string;
  conversation_id: string;
  role: string;
  character_id: string | null;
  content: string;
  created_at: string;
};

function pickGroupResponder(
  members: CharacterRow[],
  conversationId: string,
  mentionCharacterId?: string
): CharacterRow {
  if (mentionCharacterId) {
    const hit = members.find((m) => m.id === mentionCharacterId);
    if (hit) return hit;
  }

  const lastAssistant = db
    .prepare(
      `SELECT character_id FROM messages
       WHERE conversation_id = ? AND role = 'assistant' AND character_id IS NOT NULL
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`
    )
    .get(conversationId) as { character_id: string } | undefined;

  if (!lastAssistant?.character_id) {
    return members[0];
  }

  const idx = members.findIndex((m) => m.id === lastAssistant.character_id);
  if (idx < 0) return members[0];
  return members[(idx + 1) % members.length];
}

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
  const at = last?.created_at || new Date().toISOString();
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
    const now = new Date().toISOString();
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

    const now = new Date().toISOString();
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
    return { messages };
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
        new Date().toISOString(),
        req.params.id
      );
      return { ok: true };
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
      new Date().toISOString(),
      req.params.id
    );
    return { ok: true };
  });

  async function handleUserMessage(
    reply: import('fastify').FastifyReply,
    conversationId: string,
    content: string,
    mentionCharacterId: string | undefined,
    source: 'text' | 'voice'
  ) {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) as
      | { id: string; type: string }
      | undefined;
    if (!conv) return reply.code(404).send({ error: '会话不存在' });

    const trimmed = content.trim();
    if (!trimmed) return reply.code(400).send({ error: '消息不能为空' });

    const members = db
      .prepare(
        `SELECT ch.* FROM conversation_members cm
         JOIN characters ch ON ch.id = cm.character_id
         WHERE cm.conversation_id = ?`
      )
      .all(conversationId) as CharacterRow[];

    if (!members.length) {
      return reply.code(400).send({ error: '会话没有角色成员' });
    }

    let storedContent = trimmed;
    let mentioned: CharacterRow | undefined;
    if (conv.type === 'group' && mentionCharacterId) {
      mentioned = members.find((m) => m.id === mentionCharacterId);
      if (mentioned) {
        const tag = `@${mentioned.name}`;
        const already =
          storedContent.startsWith(`${tag} `) ||
          storedContent === tag ||
          storedContent.includes(`${tag} `) ||
          storedContent.endsWith(` ${tag}`);
        if (!already) {
          storedContent = `${tag} ${storedContent}`;
        }
      }
    }

    const now = new Date().toISOString();
    const userMsgId = uuid();
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, character_id, content, created_at, source)
       VALUES (?, ?, 'user', NULL, ?, ?, ?)`
    ).run(userMsgId, conversationId, storedContent, now, source);

    let character: CharacterRow;
    if (conv.type === 'private') {
      character = members[0];
    } else {
      character = pickGroupResponder(members, conversationId, mentionCharacterId);
    }

    if (conv.type === 'private' && character?.id && (source === 'text' || source === 'voice')) {
      onPrivateUserMessage(character.id);
    }

    const history = (
      db
        .prepare(
          `SELECT role, character_id, content FROM messages
         WHERE conversation_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 40`
        )
        .all(conversationId) as MessageRow[]
    ).reverse();

    const nameById = new Map(members.map((m) => [m.id, m.name] as const));
    const otherNames = members.filter((m) => m.id !== character.id).map((m) => m.name);

    function isNoticeBubble(c: string): boolean {
      return (
        c.startsWith('（LLM 暂时不可用') ||
        c.startsWith('(LLM 暂时不可用') ||
        c.includes('LLM 暂时不可用')
      );
    }

    let system = buildSystemPrompt(character);
    if (conv.type === 'private') {
      system = appendMemoryBlock(system, character.id);
    }

    system += `\n\n${emojiConstraintForPrompt()}`;

    if (conv.type === 'group') {
      const roster = members.map((m) => m.name).join('、');
      system += `\n\n【群聊设定】这是群聊。群成员：${roster}。发言者是用户（真人）；「你」默认指用户，不是某个角色。`;

      if (mentioned && mentioned.id === character.id) {
        system += `\n\n【被点名】你是${character.name}。用户在本条消息里 @了你。
要求：
1. 只回答用户刚刚对你说的那句话（可看气泡里的 @${character.name} 正文）；
2. 直接回用户，不要当成旁白，不要跟其他角色打招呼或续他们的戏；
3. 不要替其他角色说话，不要去叫其他角色的名字演戏；
4. 可以知道群里还有谁（${otherNames.join('、') || '无'}），但默认把「你」理解成用户；
5. 不必复读 @。`;
      } else if (!mentionCharacterId) {
        system += `\n\n【轮询发言】你是${character.name}，这次轮到你简短发言。优先回应用户最后一句，而不是角色互聊；不要替别人说话。`;
      }
    }

    type LlmMsg = { role: 'system' | 'user' | 'assistant'; content: string };
    const llmMessages: LlmMsg[] = [{ role: 'system', content: system }];

    for (const m of history) {
      if (isNoticeBubble(m.content)) continue;

      if (m.role === 'user') {
        llmMessages.push({ role: 'user', content: m.content });
        continue;
      }

      if (conv.type === 'private') {
        llmMessages.push({ role: 'assistant', content: m.content });
        continue;
      }

      const who = m.character_id ? nameById.get(m.character_id) : undefined;
      if (who && who === character.name) {
        llmMessages.push({ role: 'assistant', content: m.content });
      } else {
        const label = who || '某人';
        llmMessages.push({
          role: 'user',
          content: `【群聊记录·${label}说】${m.content}`,
        });
      }
    }

    if (conv.type === 'private' && character?.id) {
      const lastUserText = [...history].reverse().find((m) => m.role === 'user')?.content ?? '';
      const recentAssistantTexts = history
        .filter((m) => m.role === 'assistant')
        .slice(-8)
        .map((m) => m.content);
      const sticky = memoryStickyReminder(character.id, { lastUserText, recentAssistantTexts });
      if (sticky) {
        llmMessages.push({ role: 'system', content: sticky });
      }
    }

    let replyText: string;
    const chatStarted = Date.now();
    try {
      replyText = await chatCompletion(llmMessages);
      console.log(
        `[chat] conv=${conversationId} char=${character.id} history=${history.length} ms=${Date.now() - chatStarted}`,
      );
    } catch (e) {
      console.log(
        `[chat] conv=${conversationId} char=${character.id} history=${history.length} ms=${Date.now() - chatStarted}`,
      );
      const msg = e instanceof Error ? e.message : String(e);
      replyText = `（LLM 暂时不可用：${msg}。请确认 Ollama 已启动或 .env 里 DeepSeek 配置正确。）`;
    }

    const aid = uuid();
    const at = new Date().toISOString();
    // B-07: voice bubble when user spoke, or text asks to sing/speak aloud
    const llmFailed =
      replyText.includes('LLM 暂时不可用') || replyText.startsWith('（LLM');
    const assistantSource: 'text' | 'voice' =
      !llmFailed && shouldAssistantUseVoice(source, trimmed) ? 'voice' : 'text';

    const recentAssistants = db
      .prepare(
        `SELECT content FROM messages
         WHERE conversation_id = ? AND role = 'assistant'
         ORDER BY created_at DESC, rowid DESC
         LIMIT 2`,
      )
      .all(conversationId) as Array<{ content: string }>;
    const recentAssistantHadEmoji = recentAssistants.some((m) => hasEmojiToken(m.content || ''));
    replyText = sanitizeAssistantEmoji(replyText, { recentAssistantHadEmoji });

    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, character_id, content, created_at, source)
       VALUES (?, ?, 'assistant', ?, ?, ?, ?)`
    ).run(aid, conversationId, character.id, replyText, at, assistantSource);

    db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(at, conversationId);

    if (conv.type === 'private' && character?.id && !llmFailed) {
      scheduleMemoryExtractAfterTurn(character.id, conversationId);
    }

    const userMessage = db.prepare('SELECT * FROM messages WHERE id = ?').get(userMsgId);

    markConversationRead(conversationId);
    return {
      userMessage,
      assistantMessages: [
        {
          id: aid,
          conversation_id: conversationId,
          role: 'assistant',
          character_id: character.id,
          character_name: character.name,
          content: replyText,
          created_at: at,
          source: assistantSource,
        },
      ],
      transcript: source === 'voice' ? trimmed : undefined,
    };
  }

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

    let text: string;
    try {
      text = await transcribeAudio(audioBuf, filename, mime);
    } catch (e) {
      // STT failure must NOT enter LLM history
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(502).send({ error: msg });
    }

    return handleUserMessage(reply, conversationId, text, mentionCharacterId, 'voice');
  });

  
  // B-04 image: user sends one image; no LLM / VLM turn
  app.post<{ Params: { id: string } }>('/api/conversations/:id/messages/image', async (req, reply) => {
    const conversationId = req.params.id;
    const convRow = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    if (!convRow) return reply.code(404).send({ error: '会话不存在' });

    let saved;
    try {
      const { buffer, ext } = await readImageFromRequest(req);
      saved = saveImageBuffer(buffer, ext, 'chat-img');
    } catch (e) {
      const status = (e as any)?.statusCode || 500;
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(status >= 400 && status < 600 ? status : 500).send({ error: msg });
    }

    const now = new Date().toISOString();
    const userMsgId = uuid();
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, character_id, content, created_at, source, image_path)
       VALUES (?, ?, 'user', NULL, ?, ?, 'image', ?)`
    ).run(userMsgId, conversationId, '[图片]', now, saved.publicPath);

    db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(now, conversationId);
    markConversationRead(conversationId);

    const userMessage = db.prepare('SELECT * FROM messages WHERE id = ?').get(userMsgId);
    return { userMessage, assistantMessages: [] as unknown[] };
  });

app.get<{ Params: { id: string } }>('/api/messages/:id/tts', async (req, reply) => {
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id) as
      | { id: string; content: string; role: string; character_id: string | null }
      | undefined;
    if (!msg) return reply.code(404).send({ error: '消息不存在' });

    let voice: string;
    if (msg.role === 'user') {
      voice = voiceForKind('user');
    } else if (msg.character_id) {
      const ch = db
        .prepare('SELECT name, raw_json FROM characters WHERE id = ?')
        .get(msg.character_id) as { name: string; raw_json: string | null } | undefined;
      const kind = resolveCharacterVoiceKind(ch?.name || '', ch?.raw_json);
      voice = voiceForKind(kind);
    } else {
      voice = voiceForKind('female');
    }

    const uploads = getUploadsDir();
    const name = ttsFilename(msg.id, voice);
    const filePath = path.join(uploads, name);

    if (!fs.existsSync(filePath)) {
      try {
        const audio = await synthesizeSpeech(msg.content, voice);
        fs.writeFileSync(filePath, audio);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        return reply.code(502).send({ error: errMsg });
      }
    }

    reply.header('Content-Type', 'audio/mpeg');
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(fs.createReadStream(filePath));
  });

}
