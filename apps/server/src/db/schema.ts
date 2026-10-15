/**
 * SQLite schema + lightweight ALTER migrations (last_read_at, message source, media paths).
 * Called once from db/index.ts on process start.
 */
import type Database from 'better-sqlite3';
import { isUtcIsoZ, nowIso, toUtcIso } from '../utils/time.js';




export function ensureMediaPathColumns(db: Database.Database) {
  const userCols = db.prepare(`PRAGMA table_info(user_profile)`).all() as Array<{ name: string }>;
  if (!userCols.some((c) => c.name === 'bg_path')) {
    db.exec(`ALTER TABLE user_profile ADD COLUMN bg_path TEXT`);
  }
  if (!userCols.some((c) => c.name === 'space_bg_path')) {
    db.exec(`ALTER TABLE user_profile ADD COLUMN space_bg_path TEXT`);
  }
  const charCols = db.prepare(`PRAGMA table_info(characters)`).all() as Array<{ name: string }>;
  if (!charCols.some((c) => c.name === 'bg_path')) {
    db.exec(`ALTER TABLE characters ADD COLUMN bg_path TEXT`);
  }
}



export function ensureMomentAuthorColumns(db: Database.Database) {
  const cols = db.prepare(`PRAGMA table_info(moments)`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  if (!cols.length) return;
  const names = new Set(cols.map((c) => c.name));
  const characterNotNull = cols.some((c) => c.name === 'character_id' && c.notnull === 1);
  const needsMig = !names.has('author_kind') || !names.has('image_path') || characterNotNull;
  if (!needsMig) return;

  db.exec(`
    CREATE TABLE moments__m06 (
      id TEXT PRIMARY KEY,
      character_id TEXT,
      author_kind TEXT NOT NULL DEFAULT 'character',
      content TEXT NOT NULL,
      image_path TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    );
  `);

  const rows = db
    .prepare(`SELECT id, character_id, content, created_at FROM moments`)
    .all() as Array<{ id: string; character_id: string; content: string; created_at: string }>;

  const insert = db.prepare(
    `INSERT INTO moments__m06 (id, character_id, author_kind, content, image_path, created_at)
     VALUES (?, ?, 'character', ?, NULL, ?)`,
  );
  const tx = db.transaction(() => {
    for (const r of rows) {
      insert.run(r.id, r.character_id, r.content, r.created_at);
    }
  });
  tx();

  db.exec(`DROP TABLE moments`);
  db.exec(`ALTER TABLE moments__m06 RENAME TO moments`);
}

export function ensureThemeAppearanceColumns(db: Database.Database) {
  const userCols = db.prepare(`PRAGMA table_info(user_profile)`).all() as Array<{ name: string }>;
  if (!userCols.some((c) => c.name === 'theme')) {
    db.exec(`ALTER TABLE user_profile ADD COLUMN theme TEXT`);
  }
  if (!userCols.some((c) => c.name === 'bg_opacity')) {
    db.exec(`ALTER TABLE user_profile ADD COLUMN bg_opacity REAL`);
  }
  if (!userCols.some((c) => c.name === 'space_bg_opacity')) {
    db.exec(`ALTER TABLE user_profile ADD COLUMN space_bg_opacity REAL`);
  }
}


export function defaultInitiativeTier(name: string): 'restrained' | 'calm' | 'outgoing' {
  const n = String(name || '');
  if (n.includes('夜见')) return 'restrained';
  if (n.includes('小春')) return 'outgoing';
  return 'calm';
}


export function ensureCharacterRefImagesTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS character_ref_images (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      path TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_char_ref_images_char
      ON character_ref_images(character_id, sort_order, created_at);
  `);
}

export function ensureProactiveColumns(db: Database.Database) {
  const userCols = db.prepare(`PRAGMA table_info(user_profile)`).all() as Array<{ name: string }>;
  if (!userCols.some((c) => c.name === 'proactive_enabled')) {
    db.exec(`ALTER TABLE user_profile ADD COLUMN proactive_enabled INTEGER NOT NULL DEFAULT 0`);
  }
  if (!userCols.some((c) => c.name === 'proactive_quiet_start')) {
    db.exec(`ALTER TABLE user_profile ADD COLUMN proactive_quiet_start TEXT NOT NULL DEFAULT '23:00'`);
  }
  if (!userCols.some((c) => c.name === 'proactive_quiet_end')) {
    db.exec(`ALTER TABLE user_profile ADD COLUMN proactive_quiet_end TEXT NOT NULL DEFAULT '08:00'`);
  }
  if (!userCols.some((c) => c.name === 'proactive_daily_cap')) {
    db.exec(`ALTER TABLE user_profile ADD COLUMN proactive_daily_cap INTEGER NOT NULL DEFAULT 3`);
  }
  // X-07: M-07 space intensity (separate from private daily_cap; C-06/D-04).
  if (!userCols.some((c) => c.name === 'proactive_space_like_max')) {
    db.exec(`ALTER TABLE user_profile ADD COLUMN proactive_space_like_max INTEGER NOT NULL DEFAULT 2`);
  }
  if (!userCols.some((c) => c.name === 'proactive_space_comment_max')) {
    db.exec(`ALTER TABLE user_profile ADD COLUMN proactive_space_comment_max INTEGER NOT NULL DEFAULT 1`);
  }
  // M-05b: character moment image (Kolors) cost gate — default off, daily cap 1 (0..3).
  if (!userCols.some((c) => c.name === 'proactive_moment_image_enabled')) {
    db.exec(`ALTER TABLE user_profile ADD COLUMN proactive_moment_image_enabled INTEGER NOT NULL DEFAULT 0`);
  }
  if (!userCols.some((c) => c.name === 'proactive_moment_image_daily_cap')) {
    db.exec(`ALTER TABLE user_profile ADD COLUMN proactive_moment_image_daily_cap INTEGER NOT NULL DEFAULT 1`);
  }

  const charCols = db.prepare(`PRAGMA table_info(characters)`).all() as Array<{ name: string }>;
  if (!charCols.some((c) => c.name === 'initiative_tier')) {
    db.exec(`ALTER TABLE characters ADD COLUMN initiative_tier TEXT NOT NULL DEFAULT 'calm'`);
  }

  // backfill tiers by name rule
  const chars = db.prepare(`SELECT id, name, initiative_tier FROM characters`).all() as Array<{
    id: string;
    name: string;
    initiative_tier: string;
  }>;
  const upd = db.prepare(`UPDATE characters SET initiative_tier = ? WHERE id = ?`);
  for (const c of chars) {
    const want = defaultInitiativeTier(c.name);
    // only fill if missing/invalid
    if (!['restrained', 'calm', 'outgoing'].includes(String(c.initiative_tier || ''))) {
      upd.run(want, c.id);
    } else if (!c.initiative_tier) {
      upd.run(want, c.id);
    }
  }
  // apply name-based defaults for rows still at calm that match special names
  for (const c of chars) {
    const want = defaultInitiativeTier(c.name);
    if (want !== 'calm') upd.run(want, c.id);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS proactive_state (
      character_id TEXT PRIMARY KEY,
      urge REAL NOT NULL DEFAULT 0,
      last_user_at TEXT,
      last_proactive_at TEXT,
      unanswered INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    );
  `);
}


export function ensureMessageReactionsTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      user_key TEXT NOT NULL DEFAULT 'me',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (message_id, emoji, user_key),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );
  `);
}

export function ensureMessageImageColumn(db: Database.Database) {
  const cols = db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'image_path')) {
    db.exec(`ALTER TABLE messages ADD COLUMN image_path TEXT`);
  }
}

export function ensureMessageSourceColumn(db: Database.Database) {
  const cols = db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'source')) {
    db.exec(`ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'text'`);
  }
}

export function ensureConversationReadColumns(db: Database.Database) {
  const cols = db.prepare(`PRAGMA table_info(conversations)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'last_read_at')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN last_read_at TEXT`);
  }
}

export function mergeDuplicatePrivateConversations(db: Database.Database) {
  const privates = db
    .prepare(`SELECT id, created_at FROM conversations WHERE type = 'private'`)
    .all() as Array<{ id: string; created_at: string }>;

  const byChar = new Map<string, Array<{ id: string; created_at: string }>>();
  const memberStmt = db.prepare(
    `SELECT character_id FROM conversation_members WHERE conversation_id = ?`
  );

  for (const c of privates) {
    const members = memberStmt.all(c.id) as Array<{ character_id: string }>;
    if (members.length !== 1) continue;
    const cid = members[0].character_id;
    const list = byChar.get(cid) ?? [];
    list.push(c);
    byChar.set(cid, list);
  }

  const moveMsg = db.prepare(`UPDATE messages SET conversation_id = ? WHERE conversation_id = ?`);
  const delMembers = db.prepare(`DELETE FROM conversation_members WHERE conversation_id = ?`);
  const delConv = db.prepare(`DELETE FROM conversations WHERE id = ?`);
  const updateTs = db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`);
  const lastMsg = db.prepare(
    `SELECT created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
  );

  const tx = db.transaction(() => {
    for (const [, list] of byChar) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      const keep = list[0];
      for (const extra of list.slice(1)) {
        moveMsg.run(keep.id, extra.id);
        delMembers.run(extra.id);
        delConv.run(extra.id);
      }
      const last = lastMsg.get(keep.id) as { created_at: string } | undefined;
      if (last?.created_at) updateTs.run(last.created_at, keep.id);
    }
  });
  tx();
}



export function ensureMemoryNoticesTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_notices (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      conversation_id TEXT,
      summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      read_at TEXT,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_memory_notices_unread
      ON memory_notices(character_id, read_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_memory_notices_conv
      ON memory_notices(conversation_id, read_at);
  `);
  const noticeCols = new Set(
    (db.prepare(`PRAGMA table_info(memory_notices)`).all() as Array<{ name: string }>).map((r) => r.name),
  );
  if (!noticeCols.has('summary')) {
    db.exec(`ALTER TABLE memory_notices ADD COLUMN summary TEXT NOT NULL DEFAULT ''`);
  }

}

export function ensureMemoriesTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      evidence_json TEXT,
      confidence REAL NOT NULL DEFAULT 0.7,
      status TEXT NOT NULL DEFAULT 'active',
      supersedes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_memories_character_status
      ON memories(character_id, status);
  `);
}


/** SQLite DEFAULT that matches JS `toISOString()` (UTC, millis, Z). */
const UTC_ISO_DEFAULT_SQL = `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

function tableSqlHasDatetimeNow(db: Database.Database, table: string): boolean {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as
    | { sql: string | null }
    | undefined;
  return Boolean(row?.sql && row.sql.includes("datetime('now')"));
}

function columnHasNonIso(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) return false;
  const rows = db.prepare(`SELECT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`).all() as Array<{
    v: string;
  }>;
  return rows.some((r) => !isUtcIsoZ(r.v));
}

/**
 * D-26: normalize all timestamp columns to UTC ISO and rebuild tables still on
 * DEFAULT datetime('now') (moments__m06 style: temp table → backfill → DROP → RENAME).
 */
export function ensureUtcIsoTimestamps(db: Database.Database) {
  const rebuildTargets: Array<{
    name: string;
    createSql: string;
    copySql: string;
    tsCols: string[];
  }> = [
    {
      name: 'characters',
      tsCols: ['created_at'],
      createSql: `
    CREATE TABLE characters__d26 (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      personality TEXT DEFAULT '',
      scenario TEXT DEFAULT '',
      first_mes TEXT DEFAULT '',
      mes_example TEXT DEFAULT '',
      system_prompt TEXT DEFAULT '',
      post_history_instructions TEXT DEFAULT '',
      avatar_path TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL DEFAULT ${UTC_ISO_DEFAULT_SQL},
      bg_path TEXT,
      initiative_tier TEXT NOT NULL DEFAULT 'calm'
    );`,
      copySql: `SELECT id, name, description, personality, scenario, first_mes, mes_example,
        system_prompt, post_history_instructions, avatar_path, raw_json, created_at,
        bg_path, COALESCE(initiative_tier, 'calm') FROM characters`,
    },
    {
      name: 'conversations',
      tsCols: ['created_at', 'updated_at', 'last_read_at'],
      createSql: `
    CREATE TABLE conversations__d26 (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'private',
      created_at TEXT NOT NULL DEFAULT ${UTC_ISO_DEFAULT_SQL},
      updated_at TEXT NOT NULL DEFAULT ${UTC_ISO_DEFAULT_SQL},
      last_read_at TEXT
    );`,
      copySql: `SELECT id, title, type, created_at, updated_at, last_read_at FROM conversations`,
    },
    {
      name: 'messages',
      tsCols: ['created_at'],
      createSql: `
    CREATE TABLE messages__d26 (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      character_id TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${UTC_ISO_DEFAULT_SQL},
      source TEXT NOT NULL DEFAULT 'text',
      image_path TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );`,
      copySql: `SELECT id, conversation_id, role, character_id, content, created_at,
        COALESCE(source, 'text'), image_path FROM messages`,
    },
    {
      name: 'moments',
      tsCols: ['created_at'],
      createSql: `
    CREATE TABLE moments__d26 (
      id TEXT PRIMARY KEY,
      character_id TEXT,
      author_kind TEXT NOT NULL DEFAULT 'character',
      content TEXT NOT NULL,
      image_path TEXT,
      created_at TEXT NOT NULL DEFAULT ${UTC_ISO_DEFAULT_SQL},
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    );`,
      copySql: `SELECT id, character_id, COALESCE(author_kind, 'character'), content, image_path, created_at FROM moments`,
    },
    {
      name: 'moment_likes',
      tsCols: ['created_at'],
      createSql: `
    CREATE TABLE moment_likes__d26 (
      moment_id TEXT NOT NULL,
      user_key TEXT NOT NULL DEFAULT 'me',
      created_at TEXT NOT NULL DEFAULT ${UTC_ISO_DEFAULT_SQL},
      PRIMARY KEY (moment_id, user_key),
      FOREIGN KEY (moment_id) REFERENCES moments(id) ON DELETE CASCADE
    );`,
      copySql: `SELECT moment_id, user_key, created_at FROM moment_likes`,
    },
    {
      name: 'moment_comments',
      tsCols: ['created_at'],
      createSql: `
    CREATE TABLE moment_comments__d26 (
      id TEXT PRIMARY KEY,
      moment_id TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '我',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${UTC_ISO_DEFAULT_SQL},
      FOREIGN KEY (moment_id) REFERENCES moments(id) ON DELETE CASCADE
    );`,
      copySql: `SELECT id, moment_id, author, content, created_at FROM moment_comments`,
    },
    {
      name: 'message_reactions',
      tsCols: ['created_at'],
      createSql: `
    CREATE TABLE message_reactions__d26 (
      message_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      user_key TEXT NOT NULL DEFAULT 'me',
      created_at TEXT NOT NULL DEFAULT ${UTC_ISO_DEFAULT_SQL},
      PRIMARY KEY (message_id, emoji, user_key),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );`,
      copySql: `SELECT message_id, emoji, user_key, created_at FROM message_reactions`,
    },
    {
      name: 'character_ref_images',
      tsCols: ['created_at'],
      createSql: `
    CREATE TABLE character_ref_images__d26 (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      path TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT ${UTC_ISO_DEFAULT_SQL},
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    );`,
      copySql: `SELECT id, character_id, path, sort_order, created_at FROM character_ref_images`,
    },
  ];

  const inPlaceTables: Array<{ name: string; cols: string[] }> = [
    { name: 'user_profile', cols: ['updated_at'] },
    { name: 'proactive_state', cols: ['last_user_at', 'last_proactive_at', 'updated_at'] },
    { name: 'memories', cols: ['created_at', 'updated_at'] },
    { name: 'memory_notices', cols: ['created_at', 'read_at'] },
  ];

  const needsRebuild = rebuildTargets.some(
    (t) =>
      tableSqlHasDatetimeNow(db, t.name) ||
      t.tsCols.some((c) => columnHasNonIso(db, t.name, c)),
  );
  const needsInPlace = inPlaceTables.some((t) => t.cols.some((c) => columnHasNonIso(db, t.name, c)));
  if (!needsRebuild && !needsInPlace) return;

  db.pragma('foreign_keys = OFF');
  const run = db.transaction(() => {
    for (const t of rebuildTargets) {
      const exists = db
        .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(t.name) as { ok: number } | undefined;
      if (!exists) continue;
      const must =
        tableSqlHasDatetimeNow(db, t.name) || t.tsCols.some((c) => columnHasNonIso(db, t.name, c));
      if (!must) continue;

      db.exec(`DROP TABLE IF EXISTS ${t.name}__d26`);
      db.exec(t.createSql);

      const newCols = (
        db.prepare(`PRAGMA table_info(${t.name}__d26)`).all() as Array<{ name: string }>
      ).map((c) => c.name);
      const placeholders = newCols.map(() => '?').join(', ');
      const insert = db.prepare(
        `INSERT INTO ${t.name}__d26 (${newCols.join(', ')}) VALUES (${placeholders})`,
      );
      const selectCols = newCols.join(', ');
      const rows = db.prepare(`SELECT ${selectCols} FROM ${t.name}`).all() as Array<
        Record<string, unknown>
      >;
      const tsSet = new Set(t.tsCols);
      for (const row of rows) {
        const vals = newCols.map((col) => {
          let v = row[col];
          if (col === 'initiative_tier' && (v == null || v === '')) v = 'calm';
          if (col === 'source' && (v == null || v === '')) v = 'text';
          if (col === 'author_kind' && (v == null || v === '')) v = 'character';
          if (!tsSet.has(col)) return v;
          if (v == null || v === '') {
            if (col === 'last_read_at' || col === 'read_at') return null;
            return toUtcIso(null);
          }
          return toUtcIso(String(v));
        });
        insert.run(...vals);
      }

      db.exec(`DROP TABLE ${t.name}`);
      db.exec(`ALTER TABLE ${t.name}__d26 RENAME TO ${t.name}`);
    }

    for (const t of inPlaceTables) {
      const exists = db
        .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(t.name) as { ok: number } | undefined;
      if (!exists) continue;
      for (const col of t.cols) {
        const cols = db.prepare(`PRAGMA table_info(${t.name})`).all() as Array<{ name: string }>;
        if (!cols.some((c) => c.name === col)) continue;
        const rows = db.prepare(`SELECT rowid AS rid, ${col} AS v FROM ${t.name} WHERE ${col} IS NOT NULL`).all() as Array<{
          rid: number;
          v: string;
        }>;
        const upd = db.prepare(`UPDATE ${t.name} SET ${col} = ? WHERE rowid = ?`);
        for (const r of rows) {
          if (isUtcIsoZ(r.v)) {
            // still canonicalize millis via Date
            const canon = toUtcIso(r.v);
            if (canon !== r.v) upd.run(canon, r.rid);
            continue;
          }
          upd.run(toUtcIso(r.v), r.rid);
        }
      }
    }

    // recreate indexes dropped with tables
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_char_ref_images_char
        ON character_ref_images(character_id, sort_order, created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_character_status
        ON memories(character_id, status);
      CREATE INDEX IF NOT EXISTS idx_memory_notices_unread
        ON memory_notices(character_id, read_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_notices_conv
        ON memory_notices(conversation_id, read_at);
    `);
  });
  run();
  db.pragma('foreign_keys = ON');
}

export function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      personality TEXT DEFAULT '',
      scenario TEXT DEFAULT '',
      first_mes TEXT DEFAULT '',
      mes_example TEXT DEFAULT '',
      system_prompt TEXT DEFAULT '',
      post_history_instructions TEXT DEFAULT '',
      avatar_path TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'private',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      PRIMARY KEY (conversation_id, character_id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      character_id TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS moments (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS moment_likes (
      moment_id TEXT NOT NULL,
      user_key TEXT NOT NULL DEFAULT 'me',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (moment_id, user_key),
      FOREIGN KEY (moment_id) REFERENCES moments(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS moment_comments (
      id TEXT PRIMARY KEY,
      moment_id TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '我',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (moment_id) REFERENCES moments(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_profile (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '旅人',
      mood TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      avatar_path TEXT,
      updated_at TEXT NOT NULL
    );
  `);

  
  const me = db.prepare(`SELECT id FROM user_profile WHERE id = 'me'`).get();
  if (!me) {
    db.prepare(
      `INSERT INTO user_profile (id, name, mood, bio, avatar_path, updated_at)
       VALUES ('me', '旅人', '', '', NULL, ?)`
    ).run(nowIso());
  }

  ensureConversationReadColumns(db);
  ensureMessageSourceColumn(db);
  ensureMessageImageColumn(db);
  ensureMediaPathColumns(db);
  ensureThemeAppearanceColumns(db);
  ensureMomentAuthorColumns(db);
  ensureProactiveColumns(db);
  ensureCharacterRefImagesTable(db);
  ensureMemoriesTable(db);
  ensureMemoryNoticesTable(db);
  ensureMessageReactionsTable(db);
  mergeDuplicatePrivateConversations(db);
  ensureUtcIsoTimestamps(db);
}
