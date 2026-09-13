import type { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import { db } from '../db/index.js';
import { buildSystemPrompt } from '../utils/characterCard.js';
import { chatCompletion } from '../services/llm.js';

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

export async function conversationRoutes(app: FastifyInstance) {
  app.get('/api/conversations', async () => {
    const rows = db
      .prepare(
        `SELECT c.*,
          (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
         FROM conversations c
         ORDER BY c.updated_at DESC`
      )
      .all();

    const withMembers = rows.map((c: any) => {
      const members = db
        .prepare(
          `SELECT ch.id, ch.name, ch.avatar_path
           FROM conversation_members cm
           JOIN characters ch ON ch.id = cm.character_id
           WHERE cm.conversation_id = ?`
        )
        .all(c.id);
      return { ...c, members };
    });

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
      return reply.code(400).send({ error: '需要至少一个角色 characterIds' });
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

    // private: seed first_mes if present
    if (type === 'private' && chars[0].first_mes?.trim()) {
      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, character_id, content, created_at)
         VALUES (?, ?, 'assistant', ?, ?, ?)`
      ).run(uuid(), id, chars[0].id, chars[0].first_mes.trim(), now);
    }

    const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    const members = db
      .prepare(
        `SELECT ch.id, ch.name, ch.avatar_path FROM conversation_members cm
         JOIN characters ch ON ch.id = cm.character_id WHERE cm.conversation_id = ?`
      )
      .all(id);

    return { conversation: { ...conversation, members } };
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

    return { messages };
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/messages', async (req, reply) => {
    const conversationId = req.params.id;
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) as
      | { id: string; type: string }
      | undefined;
    if (!conv) return reply.code(404).send({ error: '会话不存在' });

    const body = (req.body ?? {}) as { content?: string; mentionCharacterId?: string };
    const content = body.content?.trim();
    if (!content) return reply.code(400).send({ error: '消息不能为空' });

    const now = new Date().toISOString();
    const userMsgId = uuid();
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, character_id, content, created_at)
       VALUES (?, ?, 'user', NULL, ?, ?)`
    ).run(userMsgId, conversationId, content, now);

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

    // Phase B: private chat — one character replies
    // Phase C prep: group — if @mention, only that one; else first member (MVP)
    let responders = members;
    if (conv.type === 'group' && body.mentionCharacterId) {
      const hit = members.find((m) => m.id === body.mentionCharacterId);
      if (hit) responders = [hit];
    } else if (conv.type === 'private') {
      responders = [members[0]];
    } else {
      // group without @ : only first for MVP stability
      responders = [members[0]];
    }

    const history = db
      .prepare(
        `SELECT role, character_id, content FROM messages
         WHERE conversation_id = ?
         ORDER BY created_at ASC, rowid ASC
         LIMIT 40`
      )
      .all(conversationId) as MessageRow[];

    const assistantMessages: unknown[] = [];

    for (const character of responders) {
      const system = buildSystemPrompt(character);
      const llmMessages = [
        { role: 'system' as const, content: system },
        ...history.map((m) => ({
          role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
          content: m.content,
        })),
      ];

      // history already includes the just-inserted user message
      let replyText: string;
      try {
        replyText = await chatCompletion(llmMessages);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        replyText = `（LLM 暂时不可用：${msg}。请确认 Ollama 已启动或 .env 中 DeepSeek 配置正确。）`;
      }

      const aid = uuid();
      const at = new Date().toISOString();
      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, character_id, content, created_at)
         VALUES (?, ?, 'assistant', ?, ?, ?)`
      ).run(aid, conversationId, character.id, replyText, at);

      assistantMessages.push({
        id: aid,
        conversation_id: conversationId,
        role: 'assistant',
        character_id: character.id,
        character_name: character.name,
        content: replyText,
        created_at: at,
      });
    }

    db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      conversationId
    );

    const userMessage = db.prepare('SELECT * FROM messages WHERE id = ?').get(userMsgId);

    return {
      userMessage,
      assistantMessages,
    };
  });
}
