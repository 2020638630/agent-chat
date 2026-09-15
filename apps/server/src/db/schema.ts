import type Database from 'better-sqlite3';


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
  mergeDuplicatePrivateConversations(db);
}
