/**
 * Chat turn orchestration (D-03-a): prompt / history / LLM / persist /
 * memory schedule / proactive hooks. Routes keep validation + I/O only.
 * Image-upload / TTS / STT multipart stay in conversations.ts (D-03-b/c/d).
 */
import type { FastifyReply } from 'fastify';
import { v4 as uuid } from 'uuid';
import { db } from '../db/index.js';
import { buildSystemPrompt } from '../utils/characterCard.js';
import { emojiConstraintForPrompt, hasEmojiToken, sanitizeAssistantEmoji } from '../constants/emojiWhitelist.js';
import { shouldAssistantUseVoice } from '../utils/voiceRequest.js';
import { chatCompletion } from '../services/llm.js';
import { wantsImageGeneration, buildImagePrompt, generateChatImage, formatImageGenUserError } from '../services/imageGen.js';
import { appendMemoryBlock, memoryStickyReminder, resolvePendingMemoryConfirm, scheduleMemoryExtractAfterTurn } from '../services/memory.js';
import {
  historyMessageCap,
  historyTokenBudget,
  injectNowContext,
  resolveUserLocation,
  takeRecentWithinTokenBudget,
} from './promptInject.js';
import { onPrivateUserMessage } from '../services/proactive.js';
import { nowIso } from '../utils/time.js';
import { formatPresenceLine, resolvePresence } from './presence.js';

/** W-01: log the assembled system prompt once per process (or every turn with PROMPT_DEBUG=1). */
let w01PromptLogged = false;

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

/** X-04: without @, speak at most once every N user messages since last assistant. */
const GROUP_UNMENTIONED_EVERY = 3;

function resolveGroupMention(
  members: CharacterRow[],
  text: string,
  mentionCharacterId?: string
): CharacterRow | undefined {
  if (mentionCharacterId) {
    const hit = members.find((m) => m.id === mentionCharacterId);
    if (hit) return hit;
  }
  const sorted = [...members].sort((a, b) => b.name.length - a.name.length);
  for (const m of sorted) {
    const tag = `@${m.name}`;
    if (
      text === tag ||
      text.startsWith(`${tag} `) ||
      text.includes(` ${tag} `) ||
      text.endsWith(` ${tag}`) ||
      text.includes(`${tag} `)
    ) {
      return m;
    }
  }
  return undefined;
}

function nextGroupRoundRobin(members: CharacterRow[], conversationId: string): CharacterRow {
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

/**
 * X-04 group turn pick:
 * - @ / mention -> that character always speaks
 * - else -> speak only every GROUP_UNMENTIONED_EVERY user msgs since last assistant;
 *   who speaks uses stable membership round-robin (no same-turn scramble)
 * Returns null to skip assistant reply (user bubble still stored).
 */
function pickGroupResponder(
  members: CharacterRow[],
  conversationId: string,
  mentionCharacterId?: string,
  userText?: string
): CharacterRow | null {
  const mentioned = resolveGroupMention(members, userText ?? "", mentionCharacterId);
  if (mentioned) return mentioned;

  const lastAssistant = db
    .prepare(
      `SELECT rowid AS rid FROM messages
       WHERE conversation_id = ? AND role = 'assistant' AND character_id IS NOT NULL
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`
    )
    .get(conversationId) as { rid: number } | undefined;

  const sinceRow = (
    lastAssistant
      ? db
          .prepare(
            `SELECT COUNT(*) AS n FROM messages
             WHERE conversation_id = ? AND role = 'user' AND rowid > ?`
          )
          .get(conversationId, lastAssistant.rid)
      : db
          .prepare(
            `SELECT COUNT(*) AS n FROM messages
             WHERE conversation_id = ? AND role = 'user'`
          )
          .get(conversationId)
  ) as { n: number };

  const userSince = Number(sinceRow?.n || 0);
  // Speak on the Nth, 2N-th, ... unmentioned user message since last assistant.
  if (userSince < GROUP_UNMENTIONED_EVERY || userSince % GROUP_UNMENTIONED_EVERY !== 0) {
    return null;
  }

  return nextGroupRoundRobin(members, conversationId);
}

function markConversationRead(conversationId: string) {
  const last = db
    .prepare(
      `SELECT created_at FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`
    )
    .get(conversationId) as { created_at: string } | undefined;
  const at = last?.created_at || nowIso();
  db.prepare(`UPDATE conversations SET last_read_at = ? WHERE id = ?`).run(at, conversationId);
}

export async function handleUserMessage(
  reply: FastifyReply,
  conversationId: string,
  content: string,
  mentionCharacterId: string | undefined,
  source: 'text' | 'voice'
) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) as
    | { id: string; type: string }
    | undefined;
  if (!conv) return reply.code(404).send({ error: '会话不存在' });

  const trimmed = content.trim();
  if (!trimmed) return reply.code(400).send({ error: '消息不能为空' });

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

  let storedContent = trimmed;
  let mentioned: CharacterRow | undefined;
  if (conv.type === 'group') {
    mentioned = resolveGroupMention(members, trimmed, mentionCharacterId);
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

  const now = nowIso();
  const userMsgId = uuid();
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, character_id, content, created_at, source)
     VALUES (?, ?, 'user', NULL, ?, ?, ?)`
  ).run(userMsgId, conversationId, storedContent, now, source);

  let character: CharacterRow | null;
  if (conv.type === 'private') {
    character = members[0];
  } else {
    character = pickGroupResponder(
      members,
      conversationId,
      mentioned?.id ?? mentionCharacterId,
      trimmed
    );
  }

  // X-04: unmentioned group turns may skip assistant reply (user bubble kept).
  if (conv.type === 'group' && !character) {
    db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(now, conversationId);
    markConversationRead(conversationId);
    const userMessage = db.prepare('SELECT * FROM messages WHERE id = ?').get(userMsgId);
    return {
      userMessage,
      assistantMessages: [] as unknown[],
      transcript: source === 'voice' ? trimmed : undefined,
    };
  }

  if (!character) {
    return reply.code(400).send({ error: '会话没有角色成员' });
  }

  let pendingResolved = false;
  if (conv.type === 'private' && character?.id && (source === 'text' || source === 'voice')) {
    pendingResolved = resolvePendingMemoryConfirm(character.id, conversationId, trimmed);
    onPrivateUserMessage(character.id);

  // B-04B: private chat explicit image request -> one generated image bubble
  if (conv.type === 'private' && character?.id && source === 'text' && wantsImageGeneration(trimmed)) {
    const aid = uuid();
    const at = nowIso();
    let replyText = '';
    let imagePath: string | null = null;
    const prompt = buildImagePrompt(trimmed, character.name);
    try {
      const gen = await generateChatImage(prompt);
      imagePath = gen.publicPath;
      replyText = '画好了，给你看看。';
      console.log(`[image-gen] conv=${conversationId} char=${character.id} model=${gen.model}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[image-gen] conv=${conversationId} fail ${msg}`);
      const hint = formatImageGenUserError(e);
      replyText = `（这张图没画成：${hint}。文字还能继续聊。）`;
    }

    const recentAssistants = db
      .prepare(
        `SELECT content FROM messages
         WHERE conversation_id = ? AND role = 'assistant'
         ORDER BY created_at DESC, rowid DESC
         LIMIT 2`,
      )
      .all(conversationId) as Array<{ content: string }>;
    const recentAssistantHadEmoji = recentAssistants.some((row) => hasEmojiToken(row.content || ''));
    replyText = sanitizeAssistantEmoji(replyText, { recentAssistantHadEmoji });

    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, character_id, content, created_at, source, image_path)
       VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)`,
    ).run(aid, conversationId, character.id, replyText, at, 'text', imagePath);

    db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(at, conversationId);
    markConversationRead(conversationId);

    const userMessage = db.prepare('SELECT * FROM messages WHERE id = ?').get(userMsgId);
    const assistantMessage = db.prepare('SELECT * FROM messages WHERE id = ?').get(aid);
    return { userMessage, assistantMessages: [assistantMessage] };
  }
  }

  const historyRaw = (
    db
      .prepare(
        `SELECT role, character_id, content FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`
      )
      .all(conversationId, historyMessageCap()) as MessageRow[]
  ).reverse();
  // D-25: count cap (default 40) + token budget (default 3072); under budget → identical window
  const history = takeRecentWithinTokenBudget(historyRaw, historyTokenBudget());

  const nameById = new Map(members.map((m) => [m.id, m.name] as const));
  const otherNames = members.filter((m) => m.id !== character.id).map((m) => m.name);

  function isNoticeBubble(c: string): boolean {
    return (
      c.startsWith('（LLM 暂时不可用') ||
      c.startsWith('(LLM 暂时不可用') ||
      c.includes('LLM 暂时不可用')
    );
  }

  let system = buildSystemPrompt(character);
  if (conv.type === 'private') {
    system = appendMemoryBlock(system, character.id);
  }

  system += `\n\n${emojiConstraintForPrompt()}`;

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
    } else if (!mentioned) {
      system += `\n\n【轮询发言】你是${character.name}，这次轮到你简短发言。优先回应用户最后一句，而不是角色互聊；不要替别人说话。`;
    }
  }

  // W-01: now-context line (UTC ISO → Asia/Shanghai) + optional user location; pinned, not trimmed.
  {
    // W-01 hotfix: never 500 on a DB missing the column — fall back to empty location.
    let location: string | null = null;
    try {
      const prof = db.prepare(`SELECT location FROM user_profile WHERE id = 'me'`).get() as
        | { location: string | null }
        | undefined;
      location = prof?.location ?? null;
    } catch (err) {
      console.warn('[W-01] read user_profile.location failed, using empty location:', (err as Error)?.message);
    }
    // W-02: character presence line (pure, slot-based). Read failure / no config → not injected.
    const at = nowIso();
    let presenceLine: string | null = null;
    try {
      const row = db.prepare(`SELECT presence FROM characters WHERE id = ?`).get(character.id) as
        | { presence: string | null }
        | undefined;
      presenceLine = formatPresenceLine(resolvePresence(row, at));
    } catch (err) {
      console.warn('[W-02] read characters.presence failed, skip presence:', (err as Error)?.message);
    }
    system = injectNowContext(system, at, resolveUserLocation(location), presenceLine);
    if (!w01PromptLogged || process.env.PROMPT_DEBUG === '1') {
      w01PromptLogged = true;
      console.log(`[W-01] assembled system prompt (conv=${conv.type}):\n${system}`);
    }
  }

  type LlmMsg = { role: 'system' | 'user' | 'assistant'; content: string };
  const llmMessages: LlmMsg[] = [{ role: 'system', content: system }];

  for (const m of history) {
    if (isNoticeBubble(m.content)) continue;

    if (m.role === 'user') {
      llmMessages.push({ role: 'user', content: m.content });
      continue;
    }

    if (conv.type === 'private') {
      llmMessages.push({ role: 'assistant', content: m.content });
      continue;
    }

    const who = m.character_id ? nameById.get(m.character_id) : undefined;
    if (who && who === character.name) {
      llmMessages.push({ role: 'assistant', content: m.content });
    } else {
      const label = who || '某人';
      llmMessages.push({
        role: 'user',
        content: `【群聊记录·${label}说】${m.content}`,
      });
    }
  }

  if (conv.type === 'private' && character?.id) {
    const lastUserText = [...history].reverse().find((m) => m.role === 'user')?.content ?? '';
    const recentAssistantTexts = history
      .filter((m) => m.role === 'assistant')
      .slice(-8)
      .map((m) => m.content);
    const sticky = memoryStickyReminder(character.id, { lastUserText, recentAssistantTexts });
    if (sticky) {
      llmMessages.push({ role: 'system', content: sticky });
    }
  }

  let replyText: string;
  const chatStarted = Date.now();
  try {
    replyText = await chatCompletion(llmMessages);
    console.log(
      `[chat] conv=${conversationId} char=${character.id} history=${history.length} ms=${Date.now() - chatStarted}`,
    );
  } catch (e) {
    console.log(
      `[chat] conv=${conversationId} char=${character.id} history=${history.length} ms=${Date.now() - chatStarted}`,
    );
    const msg = e instanceof Error ? e.message : String(e);
    replyText = `（LLM 暂时不可用：${msg}。请确认 Ollama 已启动或 .env 里 DeepSeek 配置正确。）`;
  }

  const aid = uuid();
  const at = nowIso();
  // B-07: voice bubble when user spoke, or text asks to sing/speak aloud
  const llmFailed =
    replyText.includes('LLM 暂时不可用') || replyText.startsWith('（LLM');
  const assistantSource: 'text' | 'voice' =
    !llmFailed && shouldAssistantUseVoice(source, trimmed) ? 'voice' : 'text';

  const recentAssistants = db
    .prepare(
      `SELECT content FROM messages
       WHERE conversation_id = ? AND role = 'assistant'
       ORDER BY created_at DESC, rowid DESC
       LIMIT 2`,
    )
    .all(conversationId) as Array<{ content: string }>;
  const recentAssistantHadEmoji = recentAssistants.some((m) => hasEmojiToken(m.content || ''));
  replyText = sanitizeAssistantEmoji(replyText, { recentAssistantHadEmoji });

  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, character_id, content, created_at, source)
     VALUES (?, ?, 'assistant', ?, ?, ?, ?)`
  ).run(aid, conversationId, character.id, replyText, at, assistantSource);

  db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(at, conversationId);

  if (conv.type === 'private' && character?.id && !llmFailed && !pendingResolved) {
    scheduleMemoryExtractAfterTurn(character.id, conversationId);
  }

  const userMessage = db.prepare('SELECT * FROM messages WHERE id = ?').get(userMsgId);

  markConversationRead(conversationId);
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
        source: assistantSource,
      },
    ],
    transcript: source === 'voice' ? trimmed : undefined,
  };
}
