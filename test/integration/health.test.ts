import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/build-app';

describe('health + metadata routes', () => {
  it('healthz returns 200 without checking dependencies', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
    await app.close();
  });

  it('readyz returns 200 when Redis responds', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ready');
    await app.close();
  });

  it('root exposes the required credit line', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/' });
    const body = res.json();
    expect(body.credit.text).toBe('Built for Digital Heroes Training Task');
    expect(body.credit.url).toBe('https://digitalheroesco.com');
    await app.close();
  });
});
