import { Redis } from 'ioredis';
import type { Config } from '../config/env';

export type RedisClient = Redis;

export function createRedisClient(config: Config): Redis {
  const client = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    commandTimeout: config.REDIS_COMMAND_TIMEOUT_MS,
    connectTimeout: 5000,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  return client;
}

export function createBullConnection(config: Config): Redis {
  return new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
}

export async function pingRedis(client: Redis, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const res = await Promise.race([
      client.ping(),
      new Promise<'TIMEOUT'>((resolve) => {
        timer = setTimeout(() => resolve('TIMEOUT'), timeoutMs);
      }),
    ]);
    return res === 'PONG';
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
