import extract from 'png-chunks-extract';
import text from 'png-chunk-text';

export type CharacterCard = {
  name: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  system_prompt?: string;
  post_history_instructions?: string;
  creator_notes?: string;
  tags?: string[];
  raw: unknown;
};

function fromV1V2(data: Record<string, unknown>): CharacterCard {
  const name = String(data.name ?? data.char_name ?? '未命名');
  return {
    name,
    description: String(data.description ?? ''),
    personality: String(data.personality ?? ''),
    scenario: String(data.scenario ?? ''),
    first_mes: String(data.first_mes ?? data.first_message ?? ''),
    mes_example: String(data.mes_example ?? ''),
    system_prompt: String(data.system_prompt ?? data.system ?? ''),
    post_history_instructions: String(data.post_history_instructions ?? ''),
    creator_notes: String(data.creator_notes ?? ''),
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    raw: data,
  };
}

function fromV3(data: Record<string, unknown>): CharacterCard {
  const spec = data as {
    data?: Record<string, unknown>;
    name?: string;
  };
  const inner = (spec.data ?? data) as Record<string, unknown>;
  return fromV1V2(inner);
}

export function parseCharacterJson(input: unknown): CharacterCard {
  if (!input || typeof input !== 'object') {
    throw new Error('角色卡 JSON 无效');
  }
  const obj = input as Record<string, unknown>;
  const spec = String(obj.spec ?? '');
  if (spec.includes('chara_card_v3') || obj.spec_version === '3.0' || obj.data) {
    return fromV3(obj);
  }
  return fromV1V2(obj);
}

export function extractPngCharacterCard(buffer: Buffer): CharacterCard {
  const chunks = extract(buffer);
  const texts: Record<string, string> = {};
  for (const chunk of chunks) {
    if (chunk.name === 'tEXt') {
      const decoded = text.decode(chunk.data);
      texts[decoded.keyword] = decoded.text;
    }
  }

  const prefer = texts['ccv3'] ?? texts['chara'];
  if (!prefer) {
    throw new Error('PNG 中未找到 ccv3 / chara tEXt 角色卡数据');
  }

  let jsonStr: string;
  try {
    jsonStr = Buffer.from(prefer, 'base64').toString('utf8');
  } catch {
    jsonStr = prefer;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error('角色卡 tEXt 内容不是合法 JSON');
  }
  return parseCharacterJson(parsed);
}

export function buildSystemPrompt(card: {
  name: string;
  description?: string | null;
  personality?: string | null;
  scenario?: string | null;
  system_prompt?: string | null;
  post_history_instructions?: string | null;
  mes_example?: string | null;
}): string {
  const parts: string[] = [];
  if (card.system_prompt?.trim()) {
    parts.push(card.system_prompt.trim());
  } else {
    parts.push(`你是「${card.name}」。请始终以该角色的身份与用户对话，保持人设一致，不要跳出角色。`);
  }
  if (card.description?.trim()) parts.push(`【角色简介】\n${card.description.trim()}`);
  if (card.personality?.trim()) parts.push(`【性格】\n${card.personality.trim()}`);
  if (card.scenario?.trim()) parts.push(`【场景】\n${card.scenario.trim()}`);
  if (card.mes_example?.trim()) parts.push(`【对话示例】\n${card.mes_example.trim()}`);
  if (card.post_history_instructions?.trim()) {
    parts.push(`【额外指示】\n${card.post_history_instructions.trim()}`);
  }
  parts.push('用中文回复。说话像熟人私聊短讯：句子短，直接对着用户说。不要舞台旁白，不要第三人称描写用户，不要系统通知腔。不要输出角色名的前缀。');
  return parts.join('\n\n');
}
