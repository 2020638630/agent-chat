/**
 * User & character profiles, homepage/space backgrounds, and avatar uploads (U-05).
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import {
  readImageFromRequest,
  saveImageBuffer,
  unlinkUploadPublicPath,
} from '../services/uploadImage.js';

type UserProfileRow = {
  id: string;
  name: string;
  mood: string;
  bio: string;
  avatar_path: string | null;
  bg_path: string | null;
  space_bg_path: string | null;
  theme?: string | null;
  bg_opacity?: number | null;
  space_bg_opacity?: number | null;
  updated_at: string;
};

type CharacterRow = {
  id: string;
  name: string;
  description: string | null;
  personality: string | null;
  first_mes: string | null;
  avatar_path: string | null;
  bg_path: string | null;
};

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

function ensureMeProfile(): UserProfileRow {
  let row = db.prepare(`SELECT * FROM user_profile WHERE id = 'me'`).get() as
    | UserProfileRow
    | undefined;
  if (!row) {
    const updated_at = new Date().toISOString();
    db.prepare(
      `INSERT INTO user_profile (id, name, mood, bio, avatar_path, updated_at)
       VALUES ('me', '旅人', '', '', NULL, ?)`
    ).run(updated_at);
    row = db.prepare(`SELECT * FROM user_profile WHERE id = 'me'`).get() as UserProfileRow;
  }
  return row;
}

function assembleBio(description?: string | null, personality?: string | null, maxLen = 280) {
  const parts = [description, personality]
    .map((s) => (s || '').trim())
    .filter(Boolean);
  const joined = parts.join(' · ');
  if (joined.length <= maxLen) return joined;
  return joined.slice(0, maxLen - 1) + '…';
}

function assembleMood(first_mes?: string | null, personality?: string | null, maxLen = 48) {
  const sources = [first_mes, personality]
    .map((s) => (s || '').trim())
    .filter(Boolean);
  if (!sources.length) return '';
  const raw = sources[0];
  const sentence = raw.split(/[。！？\n.!?\r]/).map((s) => s.trim()).find(Boolean) || raw;
  const line = sentence.replace(/\s+/g, ' ').trim();
  if (!line) return '';
  if (line.length <= maxLen) return line;
  return line.slice(0, maxLen - 1) + '…';
}

function momentsForCharacter(characterId: string) {
  const rows = db
    .prepare(
      `SELECT m.*, ch.name AS character_name, ch.avatar_path
       FROM moments m
       JOIN characters ch ON ch.id = m.character_id
       WHERE m.character_id = ?
       ORDER BY m.created_at DESC
       LIMIT 100`
    )
    .all(characterId);
  return rows.map(enrichMoment);
}

const THEME_PRESETS = new Set(['mist', 'paper', 'lake', 'dusk']);

function normalizeTheme(v: unknown): 'mist' | 'paper' | 'lake' | 'dusk' {
  const s = String(v ?? 'mist').trim().toLowerCase();
  return (THEME_PRESETS.has(s) ? s : 'mist') as 'mist' | 'paper' | 'lake' | 'dusk';
}

function normalizeOpacity(v: unknown, fallback = 0.5): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0.2, Math.round(n * 100) / 100));
}

function userProfileDto(row: UserProfileRow) {
  return {
    id: 'me' as const,
    kind: 'user' as const,
    name: row.name,
    mood: row.mood ?? '',
    bio: row.bio ?? '',
    avatar_path: row.avatar_path ?? null,
    bg_path: row.bg_path ?? null,
    space_bg_path: row.space_bg_path ?? null,
    theme: normalizeTheme(row.theme),
    bg_opacity: normalizeOpacity(row.bg_opacity, 0.5),
    space_bg_opacity: normalizeOpacity(row.space_bg_opacity, 0.5),
  };
}

function characterProfileDto(character: CharacterRow) {
  return {
    id: character.id,
    kind: 'character' as const,
    name: character.name,
    mood: assembleMood(character.first_mes, character.personality),
    bio: assembleBio(character.description, character.personality),
    avatar_path: character.avatar_path ?? null,
    bg_path: character.bg_path ?? null,
  };
}

function httpError(e: unknown, reply: any) {
  const status = (e as any)?.statusCode || 500;
  const msg = e instanceof Error ? e.message : String(e);
  return reply.code(status >= 400 && status < 600 ? status : 500).send({ error: msg });
}

export async function profileRoutes(app: FastifyInstance) {
  app.get('/api/profiles/me', async () => {
    const row = ensureMeProfile();
    return {
      profile: userProfileDto(row),
      moments: [] as unknown[],
    };
  });

  app.patch('/api/profiles/me', async (req) => {
    const body = (req.body ?? {}) as {
      name?: string;
      mood?: string;
      bio?: string;
      theme?: string;
      bg_opacity?: number;
      space_bg_opacity?: number;
    };
    const current = ensureMeProfile();
    const name =
      body.name !== undefined ? String(body.name).trim() || current.name : current.name;
    const mood = body.mood !== undefined ? String(body.mood) : current.mood;
    const bio = body.bio !== undefined ? String(body.bio) : current.bio;
    const theme =
      body.theme !== undefined ? normalizeTheme(body.theme) : normalizeTheme(current.theme);
    const bg_opacity =
      body.bg_opacity !== undefined
        ? normalizeOpacity(body.bg_opacity, 0.5)
        : normalizeOpacity(current.bg_opacity, 0.5);
    const space_bg_opacity =
      body.space_bg_opacity !== undefined
        ? normalizeOpacity(body.space_bg_opacity, 0.5)
        : normalizeOpacity(current.space_bg_opacity, 0.5);
    const updated_at = new Date().toISOString();
    db.prepare(
      `UPDATE user_profile SET name = ?, mood = ?, bio = ?, theme = ?, bg_opacity = ?, space_bg_opacity = ?, updated_at = ? WHERE id = 'me'`
    ).run(name, mood, bio, theme, bg_opacity, space_bg_opacity, updated_at);
    return { profile: userProfileDto(ensureMeProfile()) };
  });

  app.get<{ Params: { id: string } }>('/api/profiles/characters/:id', async (req, reply) => {
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id) as
      | CharacterRow
      | undefined;
    if (!character) return reply.code(404).send({ error: '角色不存在' });
    return {
      profile: characterProfileDto(character),
      moments: momentsForCharacter(character.id),
    };
  });

  // —— user avatar ——
  app.post('/api/profiles/me/avatar', async (req, reply) => {
    try {
      const { buffer, ext } = await readImageFromRequest(req);
      const me = ensureMeProfile();
      const saved = saveImageBuffer(buffer, ext, 'avatar-me');
      unlinkUploadPublicPath(me.avatar_path);
      db.prepare(
        `UPDATE user_profile SET avatar_path = ?, updated_at = ? WHERE id = 'me'`
      ).run(saved.publicPath, new Date().toISOString());
      return { profile: userProfileDto(ensureMeProfile()) };
    } catch (e) {
      return httpError(e, reply);
    }
  });

  app.delete('/api/profiles/me/avatar', async () => {
    const me = ensureMeProfile();
    unlinkUploadPublicPath(me.avatar_path);
    db.prepare(
      `UPDATE user_profile SET avatar_path = NULL, updated_at = ? WHERE id = 'me'`
    ).run(new Date().toISOString());
    return { profile: userProfileDto(ensureMeProfile()) };
  });

  // —— user homepage bg ——
  app.post('/api/profiles/me/bg', async (req, reply) => {
    try {
      const { buffer, ext } = await readImageFromRequest(req);
      const me = ensureMeProfile();
      const saved = saveImageBuffer(buffer, ext, 'bg-me');
      unlinkUploadPublicPath(me.bg_path);
      db.prepare(
        `UPDATE user_profile SET bg_path = ?, updated_at = ? WHERE id = 'me'`
      ).run(saved.publicPath, new Date().toISOString());
      return { profile: userProfileDto(ensureMeProfile()) };
    } catch (e) {
      return httpError(e, reply);
    }
  });

  app.delete('/api/profiles/me/bg', async () => {
    const me = ensureMeProfile();
    unlinkUploadPublicPath(me.bg_path);
    db.prepare(
      `UPDATE user_profile SET bg_path = NULL, updated_at = ? WHERE id = 'me'`
    ).run(new Date().toISOString());
    return { profile: userProfileDto(ensureMeProfile()) };
  });

  // —— space / moments cover ——
  app.post('/api/space/bg', async (req, reply) => {
    try {
      const { buffer, ext } = await readImageFromRequest(req);
      const me = ensureMeProfile();
      const saved = saveImageBuffer(buffer, ext, 'bg-space');
      unlinkUploadPublicPath(me.space_bg_path);
      db.prepare(
        `UPDATE user_profile SET space_bg_path = ?, updated_at = ? WHERE id = 'me'`
      ).run(saved.publicPath, new Date().toISOString());
      return { profile: userProfileDto(ensureMeProfile()) };
    } catch (e) {
      return httpError(e, reply);
    }
  });

  app.delete('/api/space/bg', async () => {
    const me = ensureMeProfile();
    unlinkUploadPublicPath(me.space_bg_path);
    db.prepare(
      `UPDATE user_profile SET space_bg_path = NULL, updated_at = ? WHERE id = 'me'`
    ).run(new Date().toISOString());
    return { profile: userProfileDto(ensureMeProfile()) };
  });

  // —— character avatar ——
  app.post<{ Params: { id: string } }>('/api/profiles/characters/:id/avatar', async (req, reply) => {
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id) as
      | CharacterRow
      | undefined;
    if (!character) return reply.code(404).send({ error: '角色不存在' });
    try {
      const { buffer, ext } = await readImageFromRequest(req);
      const saved = saveImageBuffer(buffer, ext, `avatar-ch-${character.id.slice(0, 8)}`);
      unlinkUploadPublicPath(character.avatar_path);
      db.prepare(`UPDATE characters SET avatar_path = ? WHERE id = ?`).run(
        saved.publicPath,
        character.id
      );
      const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(character.id) as CharacterRow;
      return { profile: characterProfileDto(updated) };
    } catch (e) {
      return httpError(e, reply);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/profiles/characters/:id/avatar', async (req, reply) => {
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id) as
      | CharacterRow
      | undefined;
    if (!character) return reply.code(404).send({ error: '角色不存在' });
    unlinkUploadPublicPath(character.avatar_path);
    db.prepare(`UPDATE characters SET avatar_path = NULL WHERE id = ?`).run(character.id);
    const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(character.id) as CharacterRow;
    return { profile: characterProfileDto(updated) };
  });

  // —— character homepage bg ——
  app.post<{ Params: { id: string } }>('/api/profiles/characters/:id/bg', async (req, reply) => {
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id) as
      | CharacterRow
      | undefined;
    if (!character) return reply.code(404).send({ error: '角色不存在' });
    try {
      const { buffer, ext } = await readImageFromRequest(req);
      const saved = saveImageBuffer(buffer, ext, `bg-ch-${character.id.slice(0, 8)}`);
      unlinkUploadPublicPath(character.bg_path);
      db.prepare(`UPDATE characters SET bg_path = ? WHERE id = ?`).run(saved.publicPath, character.id);
      const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(character.id) as CharacterRow;
      return { profile: characterProfileDto(updated) };
    } catch (e) {
      return httpError(e, reply);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/profiles/characters/:id/bg', async (req, reply) => {
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id) as
      | CharacterRow
      | undefined;
    if (!character) return reply.code(404).send({ error: '角色不存在' });
    unlinkUploadPublicPath(character.bg_path);
    db.prepare(`UPDATE characters SET bg_path = NULL WHERE id = ?`).run(character.id);
    const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(character.id) as CharacterRow;
    return { profile: characterProfileDto(updated) };
  });
}
