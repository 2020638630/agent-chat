import type { FastifyInstance } from 'fastify';
import { getMemoryExtractMetrics, pendingTtlDays } from '../services/memory.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => ({
    ok: true,
    service: 'agent-chat-server',
    time: new Date().toISOString(),
    // X05-D5: scrape-friendly extract counters (no secrets)
    memoryExtract: getMemoryExtractMetrics(),
    // X05-D2: current pending TTL policy (days)
    memoryPendingTtlDays: pendingTtlDays(),
  }));
}
