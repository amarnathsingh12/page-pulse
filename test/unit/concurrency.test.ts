import { describe, expect, it } from 'vitest';
import { ConcurrencyGuard } from '../../src/lib/concurrency';
import { OverCapacityError, RateLimitedError } from '../../src/lib/errors';

describe('ConcurrencyGuard', () => {
  it('rejects with 429 when a client exceeds its per-client cap', async () => {
    const guard = new ConcurrencyGuard({
      globalMax: 10,
      perClientMax: 1,
      queueMaxDepth: 0,
      queueTimeoutMs: 100,
    });
    const release = await guard.acquire('c1');
    await expect(guard.acquire('c1')).rejects.toBeInstanceOf(RateLimitedError);
    release();
  });

  it('sheds load with 503 when global capacity and queue are exhausted', async () => {
    const guard = new ConcurrencyGuard({
      globalMax: 1,
      perClientMax: 5,
      queueMaxDepth: 0,
      queueTimeoutMs: 100,
    });
    const release = await guard.acquire('a');
    await expect(guard.acquire('b')).rejects.toBeInstanceOf(OverCapacityError);
    release();
  });

  it('queues a waiter and admits it once a slot frees', async () => {
    const guard = new ConcurrencyGuard({
      globalMax: 1,
      perClientMax: 5,
      queueMaxDepth: 5,
      queueTimeoutMs: 1000,
    });
    const release = await guard.acquire('a');
    const pending = guard.acquire('b');
    setTimeout(() => release(), 10);
    const release2 = await pending;
    release2();
    expect(guard.inflight).toBe(0);
  });
});
