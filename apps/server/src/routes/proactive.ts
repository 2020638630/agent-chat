import type { FastifyInstance } from 'fastify';
import {
  getProactiveSettings,
  patchProactiveSettings,
  runProactiveTick,
} from '../services/proactive.js';

export async function proactiveRoutes(app: FastifyInstance) {
  app.get('/api/proactive', async () => {
    return { settings: getProactiveSettings() };
  });

  app.patch('/api/proactive', async (req) => {
    const body = (req.body ?? {}) as {
      enabled?: boolean;
      quiet_start?: string;
      quiet_end?: string;
      daily_cap?: number;
    };
    return { settings: patchProactiveSettings(body) };
  });

  app.post('/api/proactive/tick', async () => {
    const result = await runProactiveTick();
    return result;
  });
}
