import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { healthRoutes } from './routes/health.js';
import { characterRoutes } from './routes/characters.js';
import { conversationRoutes } from './routes/conversations.js';
import { momentRoutes } from './routes/moments.js';
import { profileRoutes } from './routes/profile.js';
import { getUploadsDir } from './db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../../');
dotenv.config({ path: path.join(root, '.env') });
dotenv.config(); // also allow apps/server/.env

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(multipart, {
  limits: { fileSize: 20 * 1024 * 1024 },
});

// static uploads
const uploadsDir = getUploadsDir();
app.get('/uploads/:name', async (req, reply) => {
  const name = (req.params as { name: string }).name;
  const file = path.join(uploadsDir, path.basename(name));
  if (!fs.existsSync(file)) return reply.code(404).send({ error: 'not found' });
  return reply.send(fs.createReadStream(file));
});

await app.register(healthRoutes);
await app.register(characterRoutes);
await app.register(conversationRoutes);
await app.register(momentRoutes);
await app.register(profileRoutes);

try {
  await app.listen({ port, host });
  console.log(`[agent-chat] server http://${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
