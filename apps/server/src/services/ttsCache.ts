/**
 * D-03-d: TTS cache for /api/messages/:id/tts — voice resolution, cache filename,
 * hit check, synthesize-on-miss. Moved verbatim from routes/conversations.ts;
 * DB lookups and the file stream stay in the route.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getUploadsDir } from '../db/index.js';
import { resolveCharacterVoiceKind, synthesizeSpeech, ttsFilename, voiceForKind } from './audio.js';

export async function ensureTtsCacheFile(
  msg: { id: string; content: string; role: string; character_id: string | null },
  ch: { name: string; raw_json: string | null } | undefined
): Promise<{ filePath: string } | { error: string }> {
  let voice: string;
  if (msg.role === 'user') {
    voice = voiceForKind('user');
  } else if (msg.character_id) {
    const kind = resolveCharacterVoiceKind(ch?.name || '', ch?.raw_json);
    voice = voiceForKind(kind);
  } else {
    voice = voiceForKind('female');
  }

  const uploads = getUploadsDir();
  const name = ttsFilename(msg.id, voice);
  const filePath = path.join(uploads, name);

  if (!fs.existsSync(filePath)) {
    try {
      const audio = await synthesizeSpeech(msg.content, voice);
      fs.writeFileSync(filePath, audio);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      return { error: errMsg };
    }
  }
  return { filePath };
}
