import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const EnvSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    HOST: z.string().default('0.0.0.0'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    LOG_PRETTY: bool.default('false'),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),

    REDIS_URL: z.string().default('redis://localhost:6379'),
    REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(200),

    CACHE_ENABLED: bool.default('true'),
    CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(86400).default(300),
    NEG_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(3600).default(30),
    CACHE_MAX_VALUE_BYTES: z.coerce.number().int().positive().default(262144),

    FETCH_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
    FETCH_HEADERS_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    FETCH_BODY_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
    FETCH_TOTAL_DEADLINE_MS: z.coerce.number().int().positive().default(10000),
    MAX_RESPONSE_BYTES: z.coerce.number().int().positive().default(2097152),
    MAX_DECOMPRESSED_BYTES: z.coerce.number().int().positive().default(8388608),
    MAX_PARSE_BYTES: z.coerce.number().int().positive().default(1048576),
    MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(5),
    USER_AGENT: z.string().default('PagePulse/1.0 (+https://digitalheroesco.com)'),

    MAX_URL_LENGTH: z.coerce.number().int().positive().default(2048),
    BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(16384),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(12000),
    ALLOWED_SCHEMES: csv.default('http,https'),
    ALLOWED_PORTS: csv.default('80,443'),

    ALLOW_PRIVATE_IPS: bool.default('false'),

    GLOBAL_MAX_CONCURRENCY: z.coerce.number().int().positive().default(50),
    PER_HOST_CONCURRENCY: z.coerce.number().int().positive().default(4),
    PER_CLIENT_CONCURRENCY: z.coerce.number().int().positive().default(5),
    CONCURRENCY_QUEUE_MAX_DEPTH: z.coerce.number().int().min(0).default(100),
    CONCURRENCY_QUEUE_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),

    RATE_LIMIT_ENABLED: bool.default('true'),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_FAIL_MODE: z.enum(['open', 'closed']).default('open'),
  })
  .transform((c) => ({
    ...c,
    ALLOWED_PORTS_SET: new Set(c.ALLOWED_PORTS.map(Number)),
    ALLOWED_SCHEMES_SET: new Set(c.ALLOWED_SCHEMES.map((s) => s.replace(/:$/, ''))),
    isProd: c.NODE_ENV === 'production',
  }))
  .superRefine((c, ctx) => {
    if (c.isProd && c.REDIS_URL === 'redis://localhost:6379') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'REDIS_URL must be set to a real instance in production',
        path: ['REDIS_URL'],
      });
    }
    if (c.isProd && c.LOG_PRETTY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'LOG_PRETTY must be false in production',
        path: ['LOG_PRETTY'],
      });
    }
  });

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return EnvSchema.parse(env);
}

export function testConfig(overrides: Partial<Record<string, string>> = {}): Config {
  return EnvSchema.parse({ NODE_ENV: 'test', ...overrides });
}
