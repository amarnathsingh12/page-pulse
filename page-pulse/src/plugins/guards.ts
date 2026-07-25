import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../deps';
import { RateLimitedError } from '../lib/errors';
import { getContext } from './context';

function clientKey(req: FastifyRequest): string {
  const ip = req.ip || 'unknown';
  if (ip.includes(':')) {
    return `ip:${ip.split(':').slice(0, 4).join(':')}::/64`;
  }
  return `ip:${ip}`;
}

export function registerClientGuards(app: FastifyInstance, deps: AppDeps): void {
  const { config, rateLimiter } = deps;

  app.addHook('onRequest', async (req, reply) => {
    const clientId = clientKey(req);
    getContext(req).clientId = clientId;

    const rl = await rateLimiter.consume(
      `rl:audit:${clientId}`,
      config.RATE_LIMIT_MAX,
      config.RATE_LIMIT_WINDOW_SECONDS,
    );
    reply.header('ratelimit-limit', String(rl.limit));
    reply.header('ratelimit-remaining', String(rl.remaining));
    reply.header('ratelimit-reset', String(rl.resetSeconds));
    if (!rl.allowed) {
      reply.header('retry-after', String(rl.resetSeconds));
      throw new RateLimitedError(rl.resetSeconds, { limit: rl.limit });
    }
  });
}
