import RedisMock from 'ioredis-mock';
import { testConfig } from '../../src/config/env';
import type { RedisClient } from '../../src/lib/redis';
import { buildServer } from '../../src/server';

export async function buildTestApp(overrides: Record<string, string> = {}) {
  const config = testConfig({ LOG_LEVEL: 'silent', ALLOW_PRIVATE_IPS: 'true', ...overrides });
  const redis = new RedisMock() as unknown as RedisClient;
  await redis.flushall();
  const { app, deps } = await buildServer({ config, redis });
  await app.ready();
  return { app, deps, redis };
}
