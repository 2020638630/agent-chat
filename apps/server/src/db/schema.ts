/**
 * SQLite schema + lightweight ALTER migrations (last_read_at, message source, media paths).
 * Called once from db/index.ts on process start.
 */
import type Database from 'better-sqlite3';




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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'private',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS moments (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS moment_likes (
      moment_id TEXT NOT NULL,
      user_key TEXT NOT NULL DEFAULT 'me',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (moment_id, user_key),
      FOREIGN KEY (moment_id) REFERENCES moments(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS moment_comments (
      id TEXT PRIMARY KEY,
      moment_id TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '我',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
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
    ).run(new Date().toISOString());
  }

  ensureConversationReadColumns(db);
  ensureMessageSourceColumn(db);
  ensureMessageImageColumn(db);
  ensureMediaPathColumns(db);
  ensureThemeAppearanceColumns(db);
  ensureMomentAuthorColumns(db);
  ensureProactiveColumns(db);
  ensureMemoriesTable(db);
  ensureMemoryNoticesTable(db);
  mergeDuplicatePrivateConversations(db);
}
