import zlib from 'node:zlib';
import type { Readable } from 'node:stream';
import { Agent, request } from 'undici';
import type { Config } from '../config/env';
import { BlockedTargetError } from '../lib/errors';
import { makeSafeLookup } from '../lib/url';
import type {
  FetchContent,
  FetchErrorCode,
  FetchOutcome,
  FetcherOptions,
  HttpClass,
  RedirectHop,
} from './types';

function classify(status: number): HttpClass {
  const c = Math.floor(status / 100);
  if (c === 1) return '1xx';
  if (c === 2) return '2xx';
  if (c === 3) return '3xx';
  if (c === 4) return '4xx';
  if (c === 5) return '5xx';
  return 'unknown';
}

function headerStr(h: string | string[] | undefined): string | null {
  if (h === undefined) return null;
  return Array.isArray(h) ? (h[0] ?? null) : h;
}

function detectCharset(contentType: string | null): string | null {
  if (!contentType) return null;
  const m = /charset=([^;]+)/i.exec(contentType);
  return m ? m[1].trim().replace(/["']/g, '') : null;
}

function collectErrorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let cur: unknown = err;
  let depth = 0;
  while (cur && typeof cur === 'object' && depth < 5) {
    const e = cur as { code?: string; name?: string; cause?: unknown; message?: string };
    if (e.code) codes.push(e.code);
    if (e.name) codes.push(e.name);
    if (e.message) codes.push(e.message);
    cur = e.cause;
    depth += 1;
  }
  return codes;
}

function findBlocked(err: unknown): BlockedTargetError | null {
  let cur: unknown = err;
  let depth = 0;
  while (cur && typeof cur === 'object' && depth < 5) {
    if (cur instanceof BlockedTargetError) return cur;
    cur = (cur as { cause?: unknown }).cause;
    depth += 1;
  }
  return null;
}

export class Fetcher {
  private readonly agent: Agent;

  constructor(private readonly config: Config) {
    this.agent = new Agent({
      connect: {
        lookup: makeSafeLookup(config),
        timeout: config.FETCH_CONNECT_TIMEOUT_MS,
      },
      headersTimeout: config.FETCH_HEADERS_TIMEOUT_MS,
      bodyTimeout: config.FETCH_BODY_TIMEOUT_MS,
      connections: config.PER_HOST_CONCURRENCY,
      pipelining: 1,
    });
  }

  async close(): Promise<void> {
    await this.agent.close();
  }

  async fetch(target: URL, opts: FetcherOptions): Promise<FetchOutcome> {
    const startedAt = performance.now();
    const signal = AbortSignal.timeout(opts.timeoutMs);
    const chain: RedirectHop[] = [];
    const visited = new Set<string>();
    let current = target;
    let hop = 0;
    let ttfbAt: number | null = null;

    try {
      for (;;) {
        const key = current.toString();
        if (visited.has(key)) {
          return this.failure('REDIRECT_LOOP', 'Redirect loop detected.', chain, current, startedAt, ttfbAt);
        }
        visited.add(key);

        const res = await request(current, {
          dispatcher: this.agent,
          method: 'GET',
          maxRedirections: 0,
          signal,
          headers: {
            'user-agent': this.config.USER_AGENT,
            'accept-encoding': 'gzip, deflate, br',
            accept: 'text/html,application/xhtml+xml,*/*',
          },
        });
        if (ttfbAt === null) ttfbAt = performance.now();

        const status = res.statusCode;
        const location = headerStr(res.headers['location'] as string | string[] | undefined);

        if (status >= 300 && status < 400 && location) {
          chain.push({ url: current.toString(), status });
          await res.body.dump();
          if (hop >= opts.maxRedirects) {
            return this.failure(
              'TOO_MANY_REDIRECTS',
              `Exceeded ${opts.maxRedirects} redirects.`,
              chain,
              current,
              startedAt,
              ttfbAt,
            );
          }
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            return this.failure('PROTOCOL_ERROR', 'Invalid redirect location.', chain, current, startedAt, ttfbAt);
          }
          const scheme = next.protocol.replace(/:$/, '');
          if (!this.config.ALLOWED_SCHEMES_SET.has(scheme)) {
            throw new BlockedTargetError('Redirect to a disallowed scheme.');
          }
          if (next.port && !this.config.ALLOWED_PORTS_SET.has(Number(next.port))) {
            throw new BlockedTargetError('Redirect to a disallowed port.');
          }
          current = next;
          hop += 1;
          continue;
        }

        const contentType = headerStr(res.headers['content-type'] as string | string[] | undefined);
        const encoding = headerStr(res.headers['content-encoding'] as string | string[] | undefined);
        const { buffer, onWire, truncated } = await this.readBodyCapped(res.body, encoding);
        const isHtml = !!contentType && /^(?:text\/html|application\/xhtml\+xml)/i.test(contentType);
        const totalMs = Math.round(performance.now() - startedAt);
        const ttfbMs = ttfbAt !== null ? Math.round(ttfbAt - startedAt) : null;

        const content: FetchContent = {
          contentType,
          bytes: onWire,
          encoding,
          truncated,
          charset: detectCharset(contentType),
          isHtml,
          body: isHtml ? buffer : undefined,
        };

        return {
          reachable: true,
          http: { status, class: classify(status), ok: status >= 200 && status < 300 },
          redirects: { count: chain.length, finalUrl: current.toString(), chain },
          timing: {
            dnsMs: null,
            connectMs: null,
            ttfbMs,
            downloadMs: ttfbMs !== null ? Math.max(0, totalMs - ttfbMs) : null,
            totalMs,
          },
          content,
        };
      }
    } catch (err) {
      const blocked = findBlocked(err);
      if (blocked) throw blocked;
      return this.mapFetchError(err, chain, current, startedAt, ttfbAt);
    }
  }

  private async readBodyCapped(
    body: Readable,
    encoding: string | null,
  ): Promise<{ buffer: Buffer; onWire: number; truncated: boolean }> {
    const chunks: Buffer[] = [];
    let onWire = 0;
    let truncated = false;

    for await (const chunk of body) {
      const buf = chunk as Buffer;
      onWire += buf.length;
      if (onWire > this.config.MAX_RESPONSE_BYTES) {
        truncated = true;
        body.on('error', () => undefined);
        body.destroy();
        break;
      }
      chunks.push(buf);
    }

    const raw = Buffer.concat(chunks);
    let out = raw;
    if (encoding) {
      const enc = encoding.toLowerCase();
      const zopts = { maxOutputLength: this.config.MAX_DECOMPRESSED_BYTES };
      try {
        if (enc.includes('br')) out = zlib.brotliDecompressSync(raw, zopts);
        else if (enc.includes('gzip')) out = zlib.gunzipSync(raw, zopts);
        else if (enc.includes('deflate')) out = zlib.inflateSync(raw, zopts);
      } catch {
        truncated = true;
        out = Buffer.alloc(0);
      }
    }
    if (out.length > this.config.MAX_PARSE_BYTES) {
      out = out.subarray(0, this.config.MAX_PARSE_BYTES);
    }
    return { buffer: out, onWire, truncated };
  }

  private mapFetchError(
    err: unknown,
    chain: RedirectHop[],
    current: URL,
    startedAt: number,
    ttfbAt: number | null,
  ): FetchOutcome {
    const codes = collectErrorCodes(err).join(' ');
    let code: FetchErrorCode = 'UNREACHABLE';
    if (/AbortError|UND_ERR_ABORTED|TimeoutError|aborted/i.test(codes)) code = 'TIMEOUT_TOTAL';
    else if (/UND_ERR_CONNECT_TIMEOUT/.test(codes)) code = 'TIMEOUT_CONNECT';
    else if (/UND_ERR_HEADERS_TIMEOUT/.test(codes)) code = 'TIMEOUT_HEADERS';
    else if (/UND_ERR_BODY_TIMEOUT/.test(codes)) code = 'TIMEOUT_BODY';
    else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(codes)) code = 'DNS_FAILURE';
    else if (/ECONNREFUSED/.test(codes)) code = 'CONNECTION_REFUSED';
    else if (/ECONNRESET|UND_ERR_SOCKET|EPIPE/.test(codes)) code = 'CONNECTION_RESET';
    else if (/ERR_TLS|CERT_|self.signed|certificate|ERR_SSL|DEPTH_ZERO/i.test(codes)) code = 'TLS_ERROR';
    else if (/UND_ERR|HPE_|PROTOCOL/i.test(codes)) code = 'PROTOCOL_ERROR';

    const message = err instanceof Error ? err.message : 'Fetch failed.';
    return this.failure(code, message, chain, current, startedAt, ttfbAt);
  }

  private failure(
    code: FetchErrorCode,
    message: string,
    chain: RedirectHop[],
    current: URL,
    startedAt: number,
    ttfbAt: number | null,
  ): FetchOutcome {
    const totalMs = Math.round(performance.now() - startedAt);
    return {
      reachable: false,
      fetchError: { code, message },
      redirects: {
        count: chain.length,
        finalUrl: chain.length ? chain[chain.length - 1].url : current.toString(),
        chain,
      },
      timing: {
        dnsMs: null,
        connectMs: null,
        ttfbMs: ttfbAt !== null ? Math.round(ttfbAt - startedAt) : null,
        downloadMs: null,
        totalMs,
      },
    };
  }
}
