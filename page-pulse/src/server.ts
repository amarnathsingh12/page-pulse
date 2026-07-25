import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { nanoid } from 'nanoid';
import { ZodError } from 'zod';
import { loadConfig, type Config } from './config/env';
import { createRedisClient, type RedisClient } from './lib/redis';
import { loggerOptions } from './lib/logger';
import {
  AppError,
  OverCapacityError,
  RateLimitedError,
  ValidationError,
  statusForError,
  toErrorEnvelope,
} from './lib/errors';
import { ConcurrencyGuard } from './lib/concurrency';
import { Fetcher } from './audit/fetcher';
import { AuditService } from './audit/service';
import { Cache } from './cache';
import { RateLimiter } from './ratelimit';
import type { AppDeps } from './deps';
import { getContext } from './plugins/context';
import { registerClientGuards } from './plugins/guards';
import { registerHealthRoutes } from './routes/health';
import { registerAuditRoutes } from './routes/audit';

export interface BuildOptions {
  config?: Config;
  redis?: RedisClient;
}

export interface BuiltServer {
  app: FastifyInstance;
  deps: AppDeps;
}

const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export async function buildServer(opts: BuildOptions = {}): Promise<BuiltServer> {
  const config = opts.config ?? loadConfig();
  const redis = opts.redis ?? createRedisClient(config);

  const fetcher = new Fetcher(config);
  const auditService = new AuditService(config, fetcher);
  const cache = new Cache(redis, config);
  const rateLimiter = new RateLimiter(redis, config);
  const guard = new ConcurrencyGuard({
    globalMax: config.GLOBAL_MAX_CONCURRENCY,
    perClientMax: config.PER_CLIENT_CONCURRENCY,
    queueMaxDepth: config.CONCURRENCY_QUEUE_MAX_DEPTH,
    queueTimeoutMs: config.CONCURRENCY_QUEUE_TIMEOUT_MS,
  });

  const deps: AppDeps = { config, redis, fetcher, auditService, cache, rateLimiter, guard };

  const app = Fastify({
    logger: loggerOptions(config),
    genReqId(req) {
      const raw = req.headers['x-request-id'];
      const value = Array.isArray(raw) ? raw[0] : raw;
      return value && REQUEST_ID.test(value) ? value : nanoid();
    },
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    disableRequestLogging: true,
    trustProxy: config.TRUST_PROXY_HOPS,
    bodyLimit: config.BODY_LIMIT_BYTES,
    requestTimeout: config.REQUEST_TIMEOUT_MS,
  });

  redis.on('error', (err: Error) => app.log.warn({ err: err.message }, 'redis error'));

  await app.register(cors, { origin: true, methods: ['GET', 'POST'], credentials: false });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  app.addHook('onResponse', async (req, reply) => {
    const ctx = getContext(req);
    req.log.info(
      {
        clientId: ctx.clientId,
        method: req.method,
        route: req.routeOptions?.url ?? req.url,
        statusCode: reply.statusCode,
        latencyMs: Math.round(reply.elapsedTime),
        cache: ctx.cache,
        targetUrl: ctx.targetUrl,
        upstreamStatus: ctx.upstreamStatus,
        bytes: ctx.bytes,
        redirects: ctx.redirects,
        errorCode: ctx.errorCode,
      },
      'request.completed',
    );
  });

  app.setErrorHandler((err, req, reply) => {
    const ctx = getContext(req);
    let normalized: unknown = err;
    if (err instanceof ZodError) {
      normalized = new ValidationError('Request validation failed.', { issues: err.flatten() });
    } else if (!(err instanceof AppError)) {
      const fe = err as FastifyError;
      if (typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500) {
        normalized = new ValidationError(fe.message || 'Bad request.');
      }
    }
    const status = statusForError(normalized);
    const envelope = toErrorEnvelope(normalized, req.id);
    ctx.errorCode = envelope.error.code;
    if (normalized instanceof RateLimitedError) reply.header('retry-after', String(normalized.retryAfter));
    if (normalized instanceof OverCapacityError) reply.header('retry-after', String(normalized.retryAfter));
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    reply.code(status).send(envelope);
  });

  app.setNotFoundHandler((req, reply) => {
    reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: 'Route not found.', requestId: req.id } });
  });

  registerHealthRoutes(app, deps);
  await app.register(async (instance) => {
    registerClientGuards(instance, deps);
    registerAuditRoutes(instance, deps);
  });

  app.addHook('onClose', async () => {
    await fetcher.close();
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
  });

  return { app, deps };
}
