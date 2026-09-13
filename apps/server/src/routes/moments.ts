import type { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import { db } from '../db/index.js';
import { buildSystemPrompt } from '../utils/characterCard.js';
import { chatCompletion } from '../services/llm.js';

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
    return { moments: rows };
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
            '请以你自己的身份发一条朋友圈动态（一两句话即可），只输出动态正文，不要加引号或前缀。',
        },
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      content = `今天心情不错。（LLM 不可用：${msg}）`;
    }

    const id = uuid();
    const created_at = new Date().toISOString();
    db.prepare(
      `INSERT INTO moments (id, character_id, content, created_at) VALUES (?, ?, ?, ?)`
    ).run(id, character.id, content, created_at);

    return {
      moment: {
        id,
        character_id: character.id,
        character_name: character.name,
        content,
        created_at,
      },
    };
  });
}
