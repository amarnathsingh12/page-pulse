import type { FastifyRequest } from 'fastify';

export interface RequestContext {
  clientId: string;
  cache?: string;
  upstreamStatus?: number;
  bytes?: number;
  redirects?: number;
  errorCode?: string;
  targetUrl?: string;
}

const store = new WeakMap<FastifyRequest, RequestContext>();

export function getContext(req: FastifyRequest): RequestContext {
  let ctx = store.get(req);
  if (!ctx) {
    ctx = { clientId: 'unknown' };
    store.set(req, ctx);
  }
  return ctx;
}
