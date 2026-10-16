/**
 * D-03-b: private-chat image upload + vision reply turn (B-04A), moved verbatim from
 * routes/conversations.ts. Route keeps validation + multipart I/O; behaviour unchanged.
 */
import { v4 as uuid } from 'uuid';
import fs from 'node:fs';
import { db } from '../db/index.js';
import { buildSystemPrompt } from '../utils/characterCard.js';
import { emojiConstraintForPrompt, hasEmojiToken, sanitizeAssistantEmoji } from '../constants/emojiWhitelist.js';
import { chatCompletion, resolveVisionModel } from './llm.js';
import { appendMemoryBlock, memoryStickyReminder, scheduleMemoryExtractAfterTurn } from './memory.js';
import { historyTokenBudget, takeRecentWithinTokenBudget } from './promptInject.js';
import { onPrivateUserMessage } from './proactive.js';
import { nowIso } from '../utils/time.js';

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

export async function handleImageMessage(
  conversationId: string,
  convRow: { id: string; type: string },
  saved: { publicPath: string; filename: string; absPath: string },
  mime: string,
  markConversationRead: (conversationId: string) => void,
) {
  const now = nowIso();
  const userMsgId = uuid();
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, character_id, content, created_at, source, image_path)
     VALUES (?, ?, 'user', NULL, ?, ?, 'image', ?)`
  ).run(userMsgId, conversationId, '[图片]', now, saved.publicPath);

  db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(now, conversationId);
  markConversationRead(conversationId);

  const userMessage = db.prepare('SELECT * FROM messages WHERE id = ?').get(userMsgId);

  // Group chats: store image only (B-04A scope)
  if (convRow.type !== 'private') {
    return { userMessage, assistantMessages: [] as unknown[] };
  }

  const members = db
    .prepare(
      `SELECT ch.* FROM conversation_members cm
       JOIN characters ch ON ch.id = cm.character_id
       WHERE cm.conversation_id = ?`
    )
    .all(conversationId) as CharacterRow[];
  if (!members.length) {
    return { userMessage, assistantMessages: [] as unknown[] };
  }
  const character = members[0];
  onPrivateUserMessage(character.id);

  let system = buildSystemPrompt(character);
  system = appendMemoryBlock(system, character.id);
  system += `\n\n${emojiConstraintForPrompt()}`;
  system +=
    '\n\n【读图】用户发来一张图片。请结合图片可见内容，以你的人设自然回应；不要只说「收到图片」。';

  type LlmMsg = {
    role: 'system' | 'user' | 'assistant';
    content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
  };
  const llmMessages: LlmMsg[] = [{ role: 'system', content: system }];

  const historyRaw = (
    db
      .prepare(
        `SELECT role, content, image_path FROM messages
         WHERE conversation_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 24`
      )
      .all(conversationId) as Array<{ role: string; content: string; image_path: string | null }>
  ).reverse();
  // D-25: vision keeps count cap 24; token budget trims only when over
  const history = takeRecentWithinTokenBudget(historyRaw, historyTokenBudget());

  function isNoticeBubble(text: string): boolean {
    return (
      text.includes('LLM 暂时不可用') ||
      text.includes('暂时看不清这张图') ||
      text.startsWith('（LLM')
    );
  }

  for (const m of history) {
    if (m.role === 'user' && m.image_path && m === history[history.length - 1]) {
      // current image turn added as multimodal below
      continue;
    }
    if (isNoticeBubble(m.content || '')) continue;
    if (m.role === 'user') {
      const text = m.image_path ? '[图片]' : m.content;
      llmMessages.push({ role: 'user', content: text });
    } else if (m.role === 'assistant') {
      llmMessages.push({ role: 'assistant', content: m.content });
    }
  }

  const lastUserText = '[图片]';
  const recentAssistantTexts = history
    .filter((m) => m.role === 'assistant')
    .slice(-8)
    .map((m) => m.content);
  const sticky = memoryStickyReminder(character.id, { lastUserText, recentAssistantTexts });
  if (sticky) {
    llmMessages.push({ role: 'system', content: sticky });
  }

  const b64 = fs.readFileSync(saved.absPath).toString('base64');
  const dataUrl = `data:${mime};base64,${b64}`;
  llmMessages.push({
    role: 'user',
    content: [
      {
        type: 'text',
        text: '（用户发来一张图片，请基于图中可见内容回应。）',
      },
      { type: 'image_url', image_url: { url: dataUrl } },
    ],
  });

  let replyText: string;
  const visionModel = resolveVisionModel();
  const started = Date.now();
  let visionFailed = false;
  try {
    replyText = await chatCompletion(llmMessages as any, { model: visionModel });
    console.log(
      `[vision] conv=${conversationId} char=${character.id} model=${visionModel} ms=${Date.now() - started}`,
    );
  } catch (e) {
    visionFailed = true;
    const msg = e instanceof Error ? e.message : String(e);
    console.log(
      `[vision] conv=${conversationId} char=${character.id} model=${visionModel} fail ms=${Date.now() - started} ${msg}`,
    );
    replyText = `（我暂时看不清这张图：${msg.slice(0, 180)}。可以换一张，或检查本机视觉模型 / LLM_VISION_MODEL。）`;
  }

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

  const aid = uuid();
  const at = nowIso();
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, character_id, content, created_at, source)
     VALUES (?, ?, 'assistant', ?, ?, ?, ?)`
  ).run(aid, conversationId, character.id, replyText, at, 'text');
  db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(at, conversationId);

  if (!visionFailed) {
    scheduleMemoryExtractAfterTurn(character.id, conversationId);
  }

  const assistantMessage = db.prepare('SELECT * FROM messages WHERE id = ?').get(aid);
  return { userMessage, assistantMessages: [assistantMessage] };
}
