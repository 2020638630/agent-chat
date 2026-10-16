/**
 * D-03-c: voice turn orchestration (STT transcribe -> handleUserMessage).
 * Moved verbatim from routes/conversations.ts; multipart parsing stays in the route.
 */
import type { FastifyReply } from 'fastify';
import { transcribeAudio } from './audio.js';
import { handleUserMessage } from './chatTurn.js';

export async function handleVoiceMessage(
  reply: FastifyReply,
  conversationId: string,
  audioBuf: Buffer,
  filename: string,
  mime: string,
  mentionCharacterId: string | undefined
) {
  let text: string;
  try {
    text = await transcribeAudio(audioBuf, filename, mime);
  } catch (e) {
    // STT failure must NOT enter LLM history
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(502).send({ error: msg });
  }

  return handleUserMessage(reply, conversationId, text, mentionCharacterId, 'voice');
}
