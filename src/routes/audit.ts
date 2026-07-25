import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from '../deps';
import { cacheOutcome } from '../cache';
import { redactUrl } from '../lib/logger';
import { normalizeUrl } from '../lib/url';
import { getContext } from '../plugins/context';
import {
  ageOf,
  clampOptions,
  parseBody,
  parseQuery,
  sendAudit,
  wantsFresh,
  wantsNoStore,
  type AuditInput,
} from './shared';

export function registerAuditRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config, cache, guard, auditService } = deps;

  const handle = async (req: FastifyRequest, reply: FastifyReply, input: AuditInput) => {
    const target = normalizeUrl(input.url, config);
    const opts = clampOptions(input.options, config);
    const ctx = getContext(req);
    ctx.targetUrl = redactUrl(target.normalized);

    const bypass = wantsFresh(req);
    const noStore = wantsNoStore(req);
    const key = cache.buildKey(target.normalized, opts);

    if (config.CACHE_ENABLED && !bypass) {
      const hit = await cache.get(key);
      if (hit) {
        ctx.cache = 'hit';
        ctx.upstreamStatus = hit.result.http?.status;
        return sendAudit(reply, req, hit.result, 'HIT', ageOf(hit.fetchedAt), true);
      }
    }

    const release = await guard.acquire(ctx.clientId);
    try {
      const result = await cache.coalesce(key, async () => {
        const audit = await auditService.audit(target, opts);
        const { negative, ttl } = cacheOutcome(audit, config);
        if (!noStore) await cache.set(key, audit, ttl, negative);
        return audit;
      });

      ctx.cache = bypass ? 'bypass' : 'miss';
      ctx.upstreamStatus = result.http?.status;
      ctx.bytes = result.content.bytes;
      ctx.redirects = result.redirects.count;
      return sendAudit(reply, req, result, bypass ? 'BYPASS' : 'MISS', 0, false);
    } finally {
      release();
    }
  };

  app.post('/audit', async (req, reply) => handle(req, reply, parseBody(req.body)));
  app.get('/audit', async (req, reply) => handle(req, reply, parseQuery(req.query)));
}
