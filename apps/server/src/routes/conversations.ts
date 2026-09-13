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

    const withMembers = rows.map((c: any) => ({
      ...c,
      members: loadMembers(c.id),
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

    const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
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
    const updated = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id);
    return { conversation: { ...updated, members: loadMembers(conv.id) } };
  });

  app.delete<{ Params: { id: string } }>('/api/conversations/:id', async (req, reply) => {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id) as
      | { id: string; type: string }
      | undefined;
    if (!conv) return reply.code(404).send({ error: '会话不存在' });
    if (conv.type !== 'group') {
      return reply.code(400).send({ error: '仅可解散群聊' });
    }

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

    db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(req.params.id);
    db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      req.params.id
    );
    return { ok: true };
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

    // Persist visible @Name in user bubble when a mention is selected
    let storedContent = content;
    let mentioned: CharacterRow | undefined;
    if (conv.type === 'group' && body.mentionCharacterId) {
      mentioned = members.find((m) => m.id === body.mentionCharacterId);
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
      `INSERT INTO messages (id, conversation_id, role, character_id, content, created_at)
       VALUES (?, ?, 'user', NULL, ?, ?)`
    ).run(userMsgId, conversationId, storedContent, now);

    let character: CharacterRow;
    if (conv.type === 'private') {
      character = members[0];
    } else {
      character = pickGroupResponder(members, conversationId, body.mentionCharacterId);
    }

    const history = db
      .prepare(
        `SELECT role, character_id, content FROM messages
         WHERE conversation_id = ?
         ORDER BY created_at ASC, rowid ASC
         LIMIT 40`
      )
      .all(conversationId) as MessageRow[];

    const nameById = new Map(members.map((m) => [m.id, m.name] as const));
    const otherNames = members.filter((m) => m.id !== character.id).map((m) => m.name);

    function isNoticeBubble(content: string): boolean {
      return (
        content.startsWith('（LLM 暂时不可用') ||
        content.startsWith('(LLM 暂时不可用') ||
        content.includes('LLM 暂时不可用')
      );
    }

    let system = buildSystemPrompt(character);

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
      } else if (!body.mentionCharacterId) {
        system += `\n\n【轮询发言】你是${character.name}，这次轮到你简短发言。优先回应用户最后一句，而不是角色互聊；不要替别人说话。`;
      }
    }

    type LlmMsg = { role: 'system' | 'user' | 'assistant'; content: string };
    const llmMessages: LlmMsg[] = [{ role: 'system', content: system }];

    for (const m of history) {
      if (isNoticeBubble(m.content)) continue; // 系统失败提示不当剧情

      if (m.role === 'user') {
        llmMessages.push({ role: 'user', content: m.content });
        continue;
      }

      // assistant / character lines
      if (conv.type === 'private') {
        llmMessages.push({ role: 'assistant', content: m.content });
        continue;
      }

      const who = m.character_id ? nameById.get(m.character_id) : undefined;
      if (who && who === character.name) {
        llmMessages.push({ role: 'assistant', content: m.content });
      } else {
        // 其他角色的话标成旁观上下文，避免模型当成自己的上一句
        const label = who || '某人';
        llmMessages.push({
          role: 'user',
          content: `【群聊记录·${label}说】${m.content}`,
        });
      }
    }

    let replyText: string;
    try {
      replyText = await chatCompletion(llmMessages);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      replyText = `（LLM 暂时不可用：${msg}。请确认 Ollama 已启动或 .env 里 DeepSeek 配置正确。）`;
    }

    const aid = uuid();
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, character_id, content, created_at)
       VALUES (?, ?, 'assistant', ?, ?, ?)`
    ).run(aid, conversationId, character.id, replyText, at);

    db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(at, conversationId);

    const userMessage = db.prepare('SELECT * FROM messages WHERE id = ?').get(userMsgId);

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
        },
      ],
    };
  });
}
