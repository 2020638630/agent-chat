import type { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import { db } from '../db/index.js';
import { buildSystemPrompt } from '../utils/characterCard.js';
import { chatCompletion } from '../services/llm.js';
import { saveImageBuffer, unlinkUploadPublicPath } from '../services/uploadImage.js';

const MOMENT_SELECT = `
  SELECT m.*,
    CASE
      WHEN m.author_kind = 'user' THEN COALESCE(up.name, '旅人')
      ELSE ch.name
    END AS character_name,
    CASE
      WHEN m.author_kind = 'user' THEN up.avatar_path
      ELSE ch.avatar_path
    END AS avatar_path
  FROM moments m
  LEFT JOIN characters ch ON ch.id = m.character_id AND m.author_kind = 'character'
  LEFT JOIN user_profile up ON up.id = 'me'
`;

function enrichMoment(row: any) {
  if (!row) return row;
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
  return {
    ...row,
    author_kind: row.author_kind === 'user' ? 'user' : 'character',
    character_id: row.character_id ?? null,
    image_path: row.image_path ?? null,
    liked,
    like_count,
    comments,
  };
}

function getMomentRow(id: string) {
  return db.prepare(`${MOMENT_SELECT} WHERE m.id = ?`).get(id);
}

export async function momentRoutes(app: FastifyInstance) {
  app.get('/api/moments', async () => {
    const rows = db
      .prepare(
        `${MOMENT_SELECT}
         ORDER BY m.created_at DESC
         LIMIT 100`
      )
      .all();
    return { moments: rows.map(enrichMoment) };
  });

  /** User posts one moment (text required, optional 1 image). No LLM. */
  app.post('/api/moments', async (req, reply) => {
    const ctype = String(req.headers['content-type'] || '');
    let content = '';
    let imagePath: string | null = null;

    try {
      if (ctype.includes('multipart/form-data')) {
        const parts = (req as any).parts();
        let fileBuf: Buffer | null = null;
        let fileName = '';
        let fileMime = '';
        for await (const part of parts) {
          if (part.type === 'file') {
            if (part.fieldname === 'file' || part.fieldname === 'image') {
              fileBuf = await part.toBuffer();
              fileName = part.filename || '';
              fileMime = part.mimetype || '';
            } else {
              await part.toBuffer();
            }
          } else if (part.fieldname === 'content') {
            content = String(part.value ?? '');
          }
        }
        content = content.trim();
        if (!content) {
          return reply.code(400).send({ error: '动态正文不能为空' });
        }
        if (fileBuf && fileBuf.length) {
          const ALLOWED: Record<string, string> = {
            'image/jpeg': '.jpg',
            'image/jpg': '.jpg',
            'image/png': '.png',
            'image/webp': '.webp',
          };
          let ext = ALLOWED[fileMime];
          if (!ext) {
            const lower = fileName.toLowerCase();
            if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) ext = '.jpg';
            else if (lower.endsWith('.png')) ext = '.png';
            else if (lower.endsWith('.webp')) ext = '.webp';
          }
          if (!ext) {
            return reply.code(400).send({ error: '仅支持 jpg / png / webp 图片' });
          }
          if (fileBuf.length > 5 * 1024 * 1024) {
            return reply.code(400).send({ error: '图片不能超过 5MB' });
          }
          const saved = saveImageBuffer(fileBuf, ext, 'moment');
          imagePath = saved.publicPath;
        }
      } else {
        const body = (req.body ?? {}) as { content?: string };
        content = String(body.content ?? '').trim();
        if (!content) {
          return reply.code(400).send({ error: '动态正文不能为空' });
        }
      }
    } catch (e) {
      const status = (e as any)?.statusCode || 400;
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(status).send({ error: msg });
    }

    const id = uuid();
    const created_at = new Date().toISOString();
    db.prepare(
      `INSERT INTO moments (id, character_id, author_kind, content, image_path, created_at)
       VALUES (?, NULL, 'user', ?, ?, ?)`
    ).run(id, content, imagePath, created_at);

    return { moment: enrichMoment(getMomentRow(id)) };
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
      `INSERT INTO moments (id, character_id, author_kind, content, image_path, created_at)
       VALUES (?, ?, 'character', ?, NULL, ?)`
    ).run(id, character.id, content, created_at);

    return { moment: enrichMoment(getMomentRow(id)) };
  });

  app.delete<{ Params: { id: string } }>('/api/moments/:id', async (req, reply) => {
    const moment = db.prepare('SELECT id, image_path FROM moments WHERE id = ?').get(req.params.id) as
      | { id: string; image_path: string | null }
      | undefined;
    if (!moment) return reply.code(404).send({ error: '动态不存在' });

    const delLikes = db.prepare('DELETE FROM moment_likes WHERE moment_id = ?');
    const delComments = db.prepare('DELETE FROM moment_comments WHERE moment_id = ?');
    const delMoment = db.prepare('DELETE FROM moments WHERE id = ?');
    const tx = db.transaction(() => {
      delLikes.run(moment.id);
      delComments.run(moment.id);
      delMoment.run(moment.id);
    });
    tx();
    unlinkUploadPublicPath(moment.image_path);
    return { ok: true };
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

    return { moment: enrichMoment(getMomentRow(req.params.id)) };
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

    return {
      moment: enrichMoment(getMomentRow(req.params.id)),
      comment: { id, author: '我', content, created_at },
    };
  });
}
