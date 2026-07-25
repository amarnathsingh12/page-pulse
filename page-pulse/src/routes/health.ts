import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../deps';
import { pingRedis } from '../lib/redis';

export function registerHealthRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/healthz', { logLevel: 'silent' }, async () => ({ status: 'ok' }));

  app.get('/readyz', { logLevel: 'warn' }, async (_req, reply) => {
    const ok = await pingRedis(deps.redis, 500);
    if (!ok) {
      return reply.code(503).send({ status: 'degraded', check: 'redis' });
    }
    return { status: 'ready' };
  });

  app.get('/', async () => ({
    service: 'page-pulse',
    description: 'Production-grade URL audit service.',
    credit: {
      text: 'Built for Digital Heroes Training Task',
      url: 'https://digitalheroesco.com',
    },
    endpoints: ['POST /audit', 'GET /audit?url=', 'GET /healthz', 'GET /readyz'],
  }));
}
