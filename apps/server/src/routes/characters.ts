import type { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import path from 'node:path';
import fs from 'node:fs';
import { db, getUploadsDir } from '../db/index.js';
import { extractPngCharacterCard, parseCharacterJson } from '../utils/characterCard.js';

export async function characterRoutes(app: FastifyInstance) {
  app.get('/api/characters', async () => {
    const rows = db
      .prepare(
        `SELECT id, name, description, personality, scenario, first_mes, avatar_path, created_at
         FROM characters ORDER BY created_at DESC`
      )
      .all();
    return { characters: rows };
  });

  app.post('/api/characters/import', async (req, reply) => {
    const mp = await req.file();
    if (!mp) {
      return reply.code(400).send({ error: '请上传角色卡文件（JSON 或 PNG）' });
    }

    const buf = await mp.toBuffer();
    const filename = mp.filename || 'card';
    const lower = filename.toLowerCase();

    let card;
    let avatarPath: string | null = null;

    try {
      if (lower.endsWith('.png')) {
        card = extractPngCharacterCard(buf);
        const uploads = getUploadsDir();
        const avatarName = `${uuid()}.png`;
        const dest = path.join(uploads, avatarName);
        fs.writeFileSync(dest, buf);
        avatarPath = `/uploads/${avatarName}`;
      } else if (lower.endsWith('.json') || mp.mimetype?.includes('json')) {
        const text = buf.toString('utf8');
        card = parseCharacterJson(JSON.parse(text));
      } else {
        // try JSON first, then PNG
        try {
          card = parseCharacterJson(JSON.parse(buf.toString('utf8')));
        } catch {
          card = extractPngCharacterCard(buf);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ error: `解析角色卡失败: ${msg}` });
    }

    const id = uuid();
    db.prepare(
      `INSERT INTO characters
       (id, name, description, personality, scenario, first_mes, mes_example,
        system_prompt, post_history_instructions, avatar_path, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      card.name,
      card.description ?? '',
      card.personality ?? '',
      card.scenario ?? '',
      card.first_mes ?? '',
      card.mes_example ?? '',
      card.system_prompt ?? '',
      card.post_history_instructions ?? '',
      avatarPath,
      JSON.stringify(card.raw)
    );

    const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
    return { character: row };
  });
}
