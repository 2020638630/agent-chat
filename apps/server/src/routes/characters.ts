import type { FastifyInstance } from 'fastify';
import { unlinkUploadPublicPath } from '../services/uploadImage.js';
import { v4 as uuid } from 'uuid';
import path from 'node:path';
import fs from 'node:fs';
import { db, getUploadsDir } from '../db/index.js';
import { extractPngCharacterCard, parseCharacterJson } from '../utils/characterCard.js';

function normalizeName(name: string) {
  return (name || '').trim().toLowerCase();
}

function findCharacterByName(name: string) {
  const key = normalizeName(name);
  if (!key) return undefined;
  const rows = db
    .prepare(
      `SELECT id, name, description, personality, scenario, first_mes, avatar_path, created_at
       FROM characters
       ORDER BY created_at ASC, id ASC`
    )
    .all() as Array<{
    id: string;
    name: string;
    description: string;
    personality: string;
    scenario: string;
    first_mes: string;
    avatar_path: string | null;
    created_at: string;
  }>;
  return rows.find((r) => normalizeName(r.name) === key);
}

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

    const fields = mp.fields as Record<string, { value?: string } | undefined>;
    const overwriteField = fields?.overwrite?.value;
    const overwrite =
      overwriteField === '1' ||
      overwriteField === 'true' ||
      String((req.query as { overwrite?: string })?.overwrite || '') === '1';

    const buf = await mp.toBuffer();
    const filename = mp.filename || 'card';
    const lower = filename.toLowerCase();

    let card: ReturnType<typeof parseCharacterJson>;
    let parsedAvatar: string | null = null;
    let pngBuf: Buffer | null = null;

    try {
      if (lower.endsWith('.png')) {
        card = extractPngCharacterCard(buf);
        pngBuf = buf;
      } else if (lower.endsWith('.json') || mp.mimetype?.includes('json')) {
        const text = buf.toString('utf8');
        card = parseCharacterJson(JSON.parse(text));
      } else {
        try {
          card = parseCharacterJson(JSON.parse(buf.toString('utf8')));
        } catch {
          card = extractPngCharacterCard(buf);
          pngBuf = buf;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ error: `解析角色卡失败: ${msg}` });
    }

    const existing = findCharacterByName(card.name);
    if (existing && !overwrite) {
      return reply.code(409).send({
        error: `将覆盖「${existing.name}」的人设，聊天记录保留`,
        code: 'NAME_EXISTS',
        existing: { id: existing.id, name: existing.name },
      });
    }

    if (pngBuf) {
      const uploads = getUploadsDir();
      const avatarName = `${uuid()}.png`;
      const dest = path.join(uploads, avatarName);
      fs.writeFileSync(dest, pngBuf);
      parsedAvatar = `/uploads/${avatarName}`;
    }

    if (existing && overwrite) {
      db.prepare(
        `UPDATE characters SET
          name = ?,
          description = ?,
          personality = ?,
          scenario = ?,
          first_mes = ?,
          mes_example = ?,
          system_prompt = ?,
          post_history_instructions = ?,
          avatar_path = COALESCE(?, avatar_path),
          raw_json = ?
         WHERE id = ?`
      ).run(
        card.name.trim() || existing.name,
        card.description ?? '',
        card.personality ?? '',
        card.scenario ?? '',
        card.first_mes ?? '',
        card.mes_example ?? '',
        card.system_prompt ?? '',
        card.post_history_instructions ?? '',
        parsedAvatar,
        JSON.stringify(card.raw),
        existing.id
      );
      const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(existing.id);
      return { character: row, overwritten: true };
    }

    const id = uuid();
    db.prepare(
      `INSERT INTO characters
       (id, name, description, personality, scenario, first_mes, mes_example,
        system_prompt, post_history_instructions, avatar_path, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      card.name.trim() || card.name,
      card.description ?? '',
      card.personality ?? '',
      card.scenario ?? '',
      card.first_mes ?? '',
      card.mes_example ?? '',
      card.system_prompt ?? '',
      card.post_history_instructions ?? '',
      parsedAvatar,
      JSON.stringify(card.raw)
    );

    const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
    return { character: row, overwritten: false };
  });

  app.delete<{ Params: { id: string } }>('/api/characters/:id', async (req, reply) => {
    const character = db
      .prepare('SELECT id, name, avatar_path, bg_path FROM characters WHERE id = ?')
      .get(req.params.id) as
      | { id: string; name: string; avatar_path: string | null; bg_path: string | null }
      | undefined;
    if (!character) return reply.code(404).send({ error: '角色不存在' });

    const privateConvs = db
      .prepare(
        `SELECT c.id FROM conversations c
         WHERE c.type = 'private'
           AND (SELECT COUNT(*) FROM conversation_members cm WHERE cm.conversation_id = c.id) = 1
           AND EXISTS (
             SELECT 1 FROM conversation_members cm2
             WHERE cm2.conversation_id = c.id AND cm2.character_id = ?
           )`
      )
      .all(character.id) as Array<{ id: string }>;

    const delMessages = db.prepare('DELETE FROM messages WHERE conversation_id = ?');
    const delMembers = db.prepare('DELETE FROM conversation_members WHERE conversation_id = ?');
    const delConv = db.prepare('DELETE FROM conversations WHERE id = ?');
    const delChar = db.prepare('DELETE FROM characters WHERE id = ?');

    const tx = db.transaction(() => {
      for (const c of privateConvs) {
        delMessages.run(c.id);
        delMembers.run(c.id);
        delConv.run(c.id);
      }
      // group memberships + moments cascade from character delete
      delChar.run(character.id);
    });
    tx();

    unlinkUploadPublicPath(character.avatar_path);
    unlinkUploadPublicPath(character.bg_path);

    return { ok: true, deletedId: character.id, name: character.name };
  });

}
