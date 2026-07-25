import type { Config } from '../config/env';
import type { RedisClient } from '../lib/redis';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

const SLIDING_WINDOW_LUA = `
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local windowSec = tonumber(ARGV[1])
local maxReq = tonumber(ARGV[2])
local windowMs = windowSec * 1000
local curWindow = math.floor(nowMs / windowMs)
local curKey = KEYS[1] .. ':' .. curWindow
local prevKey = KEYS[1] .. ':' .. (curWindow - 1)
local curCount = tonumber(redis.call('GET', curKey) or '0')
local prevCount = tonumber(redis.call('GET', prevKey) or '0')
local elapsed = nowMs - (curWindow * windowMs)
local weight = (windowMs - elapsed) / windowMs
local estimated = prevCount * weight + curCount
if estimated >= maxReq then
  return {0, 0, windowSec}
end
redis.call('INCR', curKey)
redis.call('PEXPIRE', curKey, windowMs * 2)
local remaining = math.floor(maxReq - (estimated + 1))
if remaining < 0 then remaining = 0 end
return {1, remaining, windowSec}
`;

class MemoryRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  consume(key: string, max: number, windowSeconds: number): RateLimitResult {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowSeconds * 1000 };
      this.buckets.set(key, bucket);
    }
    const resetSeconds = Math.max(0, Math.ceil((bucket.resetAt - now) / 1000));
    if (bucket.count >= max) {
      return { allowed: false, limit: max, remaining: 0, resetSeconds };
    }
    bucket.count += 1;
    return { allowed: true, limit: max, remaining: max - bucket.count, resetSeconds };
  }
}

export class RateLimiter {
  private readonly memory = new MemoryRateLimiter();

  constructor(
    private readonly redis: RedisClient,
    private readonly config: Config,
  ) {}

  async consume(key: string, max: number, windowSeconds: number): Promise<RateLimitResult> {
    if (!this.config.RATE_LIMIT_ENABLED) {
      return { allowed: true, limit: max, remaining: max, resetSeconds: 0 };
    }
    try {
      const res = await this.redis.eval(SLIDING_WINDOW_LUA, 1, key, String(windowSeconds), String(max));
      if (!Array.isArray(res) || res.length < 3) {
        throw new Error('unexpected eval result');
      }
      const [allowed, remaining, reset] = res as [number, number, number];
      return {
        allowed: Number(allowed) === 1,
        limit: max,
        remaining: Number(remaining),
        resetSeconds: Number(reset),
      };
    } catch {
      if (this.config.RATE_LIMIT_FAIL_MODE === 'closed') {
        return { allowed: false, limit: max, remaining: 0, resetSeconds: windowSeconds };
      }
      return this.memory.consume(key, max, windowSeconds);
    }
  }
}
