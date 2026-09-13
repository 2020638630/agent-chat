import type { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import { db } from '../db/index.js';
import { buildSystemPrompt } from '../utils/characterCard.js';
import { chatCompletion } from '../services/llm.js';

function enrichMoment(row: any) {
  const liked = !!db
    .prepare(`SELECT 1 FROM moment_likes WHERE moment_id = ? AND user_key = 'me'`)
    .get(row.id);
  const like_count = (
    db.prepare(`SELECT COUNT(*) AS n FROM moment_likes WHERE moment_id = ?`).get(row.id) as {
      n: number;
    }
  ).n;
  const comments = db
    .prepare(
      `SELECT id, author, content, created_at FROM moment_comments
       WHERE moment_id = ? ORDER BY created_at ASC, rowid ASC`
    )
    .all(row.id);
  return { ...row, liked, like_count, comments };
}

export async function momentRoutes(app: FastifyInstance) {
  app.get('/api/moments', async () => {
    const rows = db
      .prepare(
        `SELECT m.*, ch.name AS character_name, ch.avatar_path
         FROM moments m
         JOIN characters ch ON ch.id = m.character_id
         ORDER BY m.created_at DESC
         LIMIT 100`
      )
      .all();
    return { moments: rows.map(enrichMoment) };
  });

  app.post('/api/moments/generate', async (req, reply) => {
    const body = (req.body ?? {}) as { characterId?: string };
    if (!body.characterId) {
      return reply.code(400).send({ error: '需要 characterId' });
    }
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(body.characterId) as
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
    if (!character) return reply.code(404).send({ error: '角色不存在' });

    const system = buildSystemPrompt(character);
    let content: string;
    try {
      content = await chatCompletion([
        { role: 'system', content: system },
        {
          role: 'user',
          content:
            '请用自己的人设发一条朋友圈动态，一两句话即可。只输出动态正文，不要引号或前缀。',
        },
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      content = `（今天心情一般。LLM 不可用：${msg}）`;
    }

    const id = uuid();
    const created_at = new Date().toISOString();
    db.prepare(
      `INSERT INTO moments (id, character_id, content, created_at) VALUES (?, ?, ?, ?)`
    ).run(id, character.id, content, created_at);

    return {
      moment: enrichMoment({
        id,
        character_id: character.id,
        character_name: character.name,
        content,
        created_at,
      }),
    };
  });

  app.post<{ Params: { id: string } }>('/api/moments/:id/like', async (req, reply) => {
    const moment = db.prepare('SELECT * FROM moments WHERE id = ?').get(req.params.id);
    if (!moment) return reply.code(404).send({ error: '动态不存在' });

    const existing = db
      .prepare(`SELECT 1 FROM moment_likes WHERE moment_id = ? AND user_key = 'me'`)
      .get(req.params.id);

    if (existing) {
      db.prepare(`DELETE FROM moment_likes WHERE moment_id = ? AND user_key = 'me'`).run(
        req.params.id
      );
    } else {
      db.prepare(
        `INSERT INTO moment_likes (moment_id, user_key, created_at) VALUES (?, 'me', ?)`
      ).run(req.params.id, new Date().toISOString());
    }

    const row = db
      .prepare(
        `SELECT m.*, ch.name AS character_name, ch.avatar_path
         FROM moments m JOIN characters ch ON ch.id = m.character_id
         WHERE m.id = ?`
      )
      .get(req.params.id);
    return { moment: enrichMoment(row) };
  });

  app.post<{ Params: { id: string } }>('/api/moments/:id/comments', async (req, reply) => {
    const moment = db.prepare('SELECT * FROM moments WHERE id = ?').get(req.params.id);
    if (!moment) return reply.code(404).send({ error: '动态不存在' });

    const body = (req.body ?? {}) as { content?: string };
    const content = body.content?.trim();
    if (!content) return reply.code(400).send({ error: '评论不能为空' });

    const id = uuid();
    const created_at = new Date().toISOString();
    db.prepare(
      `INSERT INTO moment_comments (id, moment_id, author, content, created_at)
       VALUES (?, ?, '我', ?, ?)`
    ).run(id, req.params.id, content, created_at);

    const row = db
      .prepare(
        `SELECT m.*, ch.name AS character_name, ch.avatar_path
         FROM moments m JOIN characters ch ON ch.id = m.character_id
         WHERE m.id = ?`
      )
      .get(req.params.id);
    return { moment: enrichMoment(row), comment: { id, author: '我', content, created_at } };
  });
}
