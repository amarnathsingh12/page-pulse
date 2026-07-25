import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/build-app';
import { startMockOrigin, type MockOrigin } from '../helpers/mock-origin';

let origin: MockOrigin;

beforeAll(async () => {
  origin = await startMockOrigin();
});

afterAll(async () => {
  await origin.close();
});

function ports() {
  return { ALLOWED_PORTS: `80,443,${origin.port}` };
}

describe('POST /audit', () => {
  it('audits a healthy HTML page and returns a score', async () => {
    const { app } = await buildTestApp(ports());
    const res = await app.inject({
      method: 'POST',
      url: '/audit',
      payload: { url: `${origin.url}/ok` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reachable).toBe(true);
    expect(body.http.status).toBe(200);
    expect(body.seo.title.present).toBe(true);
    expect(body.seo.h1.count).toBe(1);
    expect(body.score).toBeGreaterThan(0);
    expect(res.headers['x-cache']).toBe('MISS');
    await app.close();
  });

  it('serves a repeat audit from cache without a second fetch', async () => {
    const { app } = await buildTestApp(ports());
    const url = `${origin.url}/ok`;
    const before = origin.hits.get('/ok') ?? 0;
    const first = await app.inject({ method: 'POST', url: '/audit', payload: { url } });
    const second = await app.inject({ method: 'POST', url: '/audit', payload: { url } });
    expect(first.headers['x-cache']).toBe('MISS');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.json().cached).toBe(true);
    expect((origin.hits.get('/ok') ?? 0) - before).toBe(1);
    await app.close();
  });

  it('treats a target 404 as a completed audit (200 with a failing check)', async () => {
    const { app } = await buildTestApp(ports());
    const res = await app.inject({
      method: 'POST',
      url: '/audit',
      payload: { url: `${origin.url}/notfound` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reachable).toBe(true);
    expect(body.http.status).toBe(404);
    const httpCheck = body.checks.find((c: { id: string }) => c.id === 'http-status');
    expect(httpCheck.verdict).toBe('fail');
    await app.close();
  });

  it('follows redirects and reports the chain', async () => {
    const { app } = await buildTestApp(ports());
    const res = await app.inject({
      method: 'POST',
      url: '/audit',
      payload: { url: `${origin.url}/redirect` },
    });
    const body = res.json();
    expect(body.http.status).toBe(200);
    expect(body.redirects.count).toBe(1);
    expect(body.redirects.finalUrl).toContain('/ok');
    await app.close();
  });

  it('reports an unreachable audit on timeout, still as 200', async () => {
    const { app } = await buildTestApp({
      ...ports(),
      FETCH_TOTAL_DEADLINE_MS: '400',
      FETCH_HEADERS_TIMEOUT_MS: '400',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/audit',
      payload: { url: `${origin.url}/slow` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reachable).toBe(false);
    expect(body.fetchError.code).toMatch(/TIMEOUT/);
    await app.close();
  }, 10000);

  it('truncates an oversized body and warns', async () => {
    const { app } = await buildTestApp({ ...ports(), MAX_RESPONSE_BYTES: '1024' });
    const res = await app.inject({
      method: 'POST',
      url: '/audit',
      payload: { url: `${origin.url}/big` },
    });
    const body = res.json();
    expect(body.content.truncated).toBe(true);
    await app.close();
  });

  it('marks HTML checks n/a for non-HTML content', async () => {
    const { app } = await buildTestApp(ports());
    const res = await app.inject({
      method: 'POST',
      url: '/audit',
      payload: { url: `${origin.url}/nonhtml` },
    });
    const body = res.json();
    expect(body.reachable).toBe(true);
    expect(body.seo).toBeNull();
    const titleCheck = body.checks.find((c: { id: string }) => c.id === 'title-length');
    expect(titleCheck.verdict).toBe('n/a');
    await app.close();
  });
});

describe('POST /audit — guardrails', () => {
  it('blocks a private-IP target with 403 (SSRF guard)', async () => {
    const { app } = await buildTestApp({ ALLOW_PRIVATE_IPS: 'false' });
    const res = await app.inject({
      method: 'POST',
      url: '/audit',
      payload: { url: 'http://127.0.0.1/' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('BLOCKED_TARGET');
    await app.close();
  });

  it('rejects a malformed URL with 400', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/audit',
      payload: { url: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });

  it('rejects an unsupported scheme with 422', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/audit',
      payload: { url: 'ftp://example.com/' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('UNSUPPORTED_TARGET');
    await app.close();
  });

  it('rate limits per client and returns 429 with headers', async () => {
    const { app } = await buildTestApp({ ...ports(), RATE_LIMIT_MAX: '3' });
    const url = `${origin.url}/ok`;
    const codes: number[] = [];
    let limited;
    for (let i = 0; i < 6; i += 1) {
      const res = await app.inject({ method: 'POST', url: '/audit', payload: { url } });
      codes.push(res.statusCode);
      if (res.statusCode === 429) limited = res;
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect(limited?.headers['retry-after']).toBeDefined();
    expect(limited?.headers['ratelimit-limit']).toBe('3');
    await app.close();
  });

  it('echoes a valid inbound X-Request-Id', async () => {
    const { app } = await buildTestApp(ports());
    const res = await app.inject({
      method: 'POST',
      url: '/audit',
      payload: { url: `${origin.url}/ok` },
      headers: { 'x-request-id': 'test-req-123' },
    });
    expect(res.headers['x-request-id']).toBe('test-req-123');
    expect(res.json().requestId).toBe('test-req-123');
    await app.close();
  });
});

describe('GET /audit', () => {
  it('audits via the query-string variant', async () => {
    const { app } = await buildTestApp(ports());
    const res = await app.inject({
      method: 'GET',
      url: `/audit?url=${encodeURIComponent(`${origin.url}/ok`)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().http.status).toBe(200);
    await app.close();
  });
});
