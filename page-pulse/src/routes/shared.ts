import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config/env';
import type { AuditResult, FetcherOptions } from '../audit/types';

const InputSchema = z.object({
  url: z.string().min(1),
  options: z
    .object({
      timeoutMs: z.coerce.number().int().optional(),
      maxRedirects: z.coerce.number().int().optional(),
    })
    .optional(),
});

export type AuditInput = z.infer<typeof InputSchema>;

export function parseBody(body: unknown): AuditInput {
  return InputSchema.parse(body ?? {});
}

export function parseQuery(query: unknown): AuditInput {
  const q = (query ?? {}) as Record<string, string | undefined>;
  return InputSchema.parse({
    url: q.url ?? '',
    options: { timeoutMs: q.timeoutMs, maxRedirects: q.maxRedirects },
  });
}

export function clampOptions(options: AuditInput['options'], config: Config): FetcherOptions {
  const timeoutMs =
    options?.timeoutMs !== undefined
      ? Math.min(Math.max(options.timeoutMs, 500), config.FETCH_TOTAL_DEADLINE_MS)
      : config.FETCH_TOTAL_DEADLINE_MS;
  const maxRedirects =
    options?.maxRedirects !== undefined
      ? Math.min(Math.max(options.maxRedirects, 0), config.MAX_REDIRECTS)
      : config.MAX_REDIRECTS;
  return { timeoutMs, maxRedirects };
}

function cacheControl(req: FastifyRequest): string {
  const h = req.headers['cache-control'];
  return (Array.isArray(h) ? h[0] : (h ?? '')).toLowerCase();
}

export function wantsFresh(req: FastifyRequest): boolean {
  const q = (req.query ?? {}) as Record<string, string | undefined>;
  if (q.fresh === '1' || q.fresh === 'true') return true;
  const cc = cacheControl(req);
  return cc.includes('no-cache') || cc.includes('no-store');
}

export function wantsNoStore(req: FastifyRequest): boolean {
  return cacheControl(req).includes('no-store');
}

export function ageOf(fetchedAt: number): number {
  return Math.max(0, Math.floor((Date.now() - fetchedAt) / 1000));
}

export function sendAudit(
  reply: FastifyReply,
  req: FastifyRequest,
  result: AuditResult,
  status: string,
  age: number,
  cached: boolean,
): FastifyReply {
  reply.header('x-cache', status);
  reply.header('age', String(age));
  return reply.code(200).send({
    requestId: req.id,
    cached,
    ...result,
    cache: { status: status.toLowerCase(), age },
  });
}
