# Page Pulse

A production-grade URL audit service. Give it a URL; it fetches the page under strict timeouts and size limits, runs a set of reachability/SEO/performance checks, and returns a structured report with a weighted 0–100 score.

**Live:** https://page-pulse-80mo.onrender.com
Built for Digital Heroes Training Task — https://digitalheroesco.com

## What it does

- Fetches the target with layered timeouts, a redirect cap, a streamed size cap, and decompression-bomb guards (undici).
- Blocks SSRF: DNS is pinned and the resolved IP is checked, so private / loopback / link-local / cloud-metadata addresses are rejected.
- Caches results in Redis for a configurable window; repeat audits of the same URL are served without refetching.
- Rate limits per client (sliding window in Redis), sheds load past a concurrency limit, and tags every request with an ID for structured logs.

## Quick start

Requires Node 20+ and a Redis instance.

```bash
cp .env.example .env
npm install
npm run dev            # http://localhost:8080
```

Or run the whole thing (app + Redis) with Docker:

```bash
docker compose up --build
```

Smoke test:

```bash
curl -s -X POST http://localhost:8080/audit \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'
```

## API

Base URL is the deployment root. All responses are JSON.

### `POST /audit`

Audit a URL. Request body:

```json
{
  "url": "https://example.com",
  "options": { "timeoutMs": 8000, "maxRedirects": 5 }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `url` | string | yes | Must be `http`/`https`. Normalized before fetch. |
| `options.timeoutMs` | number | no | Total fetch deadline. Clamped to `[500, FETCH_TOTAL_DEADLINE_MS]`. |
| `options.maxRedirects` | number | no | Clamped to `[0, MAX_REDIRECTS]`. |

### `GET /audit`

Same audit via query string: `?url=<encoded>&timeoutMs=&maxRedirects=`.

```bash
curl "http://localhost:8080/audit?url=https%3A%2F%2Fexample.com"
```

### Cache control

- `?fresh=1` (or header `Cache-Control: no-cache`) bypasses a cached result and refetches.
- `Cache-Control: no-store` refetches **and** skips writing the result back to the cache.

### Success response — `200`

A `200` means *the audit completed*. A target that returns its own 4xx/5xx is still a successful audit — that shows up as a failing check, not as an API error (see [Errors](#errors)).

```json
{
  "requestId": "MZtMglN8VZ9kcf8fo6U28",
  "cached": false,
  "url": "https://example.com/",
  "reachable": true,
  "http": { "status": 200, "class": "2xx", "ok": true },
  "redirects": { "count": 0, "finalUrl": "https://example.com/", "chain": [] },
  "timing": { "dnsMs": null, "connectMs": null, "ttfbMs": 34, "downloadMs": 0, "totalMs": 34 },
  "content": { "contentType": "text/html", "bytes": 318, "encoding": "br", "truncated": false },
  "seo": {
    "title": { "present": true, "length": 14 },
    "metaDescription": { "present": false, "length": 0 },
    "h1": { "present": true, "count": 1 }
  },
  "checks": [
    { "id": "reachable", "weight": 3, "verdict": "pass", "detail": "target responded" },
    { "id": "http-status", "weight": 3, "verdict": "pass", "detail": "200 (2xx)" },
    { "id": "https", "weight": 2, "verdict": "pass", "detail": "served over https" },
    { "id": "ttfb", "weight": 1, "verdict": "pass", "detail": "34ms" },
    { "id": "redirect-count", "weight": 1, "verdict": "pass", "detail": "0 redirect(s)" },
    { "id": "page-weight", "weight": 1, "verdict": "pass", "detail": "318 bytes" },
    { "id": "title-length", "weight": 2, "verdict": "pass", "detail": "14 chars (ideal 10-60)" },
    { "id": "meta-description", "weight": 1, "verdict": "fail", "detail": "missing meta description" },
    { "id": "h1-count", "weight": 1, "verdict": "pass", "detail": "1 h1 element(s)" }
  ],
  "score": 93,
  "fetchedAt": "2026-07-25T08:08:52.039Z",
  "cache": { "status": "bypass", "age": 0 }
}
```

| Field | Meaning |
|---|---|
| `requestId` | Correlates the response with server logs; echoes an inbound `X-Request-Id` if valid. |
| `cached` | `true` if served from cache. |
| `url` | Normalized target. |
| `reachable` | Whether the fetch completed. If `false`, `fetchError` is present and the HTML fields are omitted. |
| `fetchError` | `{ code, message }` on failure — see [fetch error codes](#fetch-error-codes). |
| `http` | `{ status, class, ok }` where `class` is one of `1xx`–`5xx`/`unknown`. |
| `redirects` | Count, final URL, and the hop `chain` of `{ url, status }`. |
| `timing` | `dnsMs`, `connectMs`, `ttfbMs`, `downloadMs`, `totalMs` (nulls where not measured). |
| `content` | `contentType`, `bytes`, `encoding`, `truncated` (true if the size cap was hit). |
| `seo` | Title / meta-description / h1 signals, or `null` for non-HTML responses. |
| `checks` | The individual checks — see below. |
| `score` | Weighted 0–100, or `null` when no check applies. |
| `fetchedAt` | ISO timestamp of the underlying fetch. |
| `cache` | `{ status: hit\|miss\|bypass, age }` (age in seconds). |

### Checks

Each check has an `id`, a `weight`, a `verdict` (`pass` / `warn` / `fail` / `n/a`), and a human `detail`.

| id | weight | `pass` when |
|---|---|---|
| `reachable` | 3 | target responded |
| `http-status` | 3 | `2xx` (`3xx`/unknown → warn, `4xx`/`5xx` → fail) |
| `https` | 2 | final URL is HTTPS |
| `ttfb` | 1 | < 600ms (≤ 1500ms → warn) |
| `redirect-count` | 1 | ≤ 1 hop (≤ 3 → warn) |
| `page-weight` | 1 | < 1 MB and not truncated (≤ 2 MB → warn) |
| `title-length` | 2 | `<title>` 10–60 chars |
| `meta-description` | 1 | meta description 50–160 chars |
| `h1-count` | 1 | exactly one `<h1>` |

The three SEO checks are `n/a` for non-HTML responses.

### Scoring

`pass` = 1, `warn` = 0.5, `fail` = 0. `n/a` checks are excluded from the denominator.

```
score = round( 100 × Σ(weight × credit) / Σ(weight) )
```

If every check is `n/a`, `score` is `null`.

### Response headers

| Header | On | Value |
|---|---|---|
| `X-Request-Id` | all | Request correlation id. |
| `X-Cache` | `/audit` | `HIT` / `MISS` / `BYPASS`. |
| `Age` | `/audit` | Cached result age in seconds. |
| `RateLimit-Limit` / `-Remaining` / `-Reset` | all | Current window budget. |
| `Retry-After` | `429`, `503` | Seconds to wait. |

### Errors

Errors from *our* service use a consistent envelope. A failing target is **not** an error — it returns `200` with a failing check.

```json
{ "error": { "code": "BLOCKED_TARGET", "message": "Target resolves to a disallowed address.", "requestId": "..." } }
```

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing/malformed `url` or bad request body. |
| 403 | `BLOCKED_TARGET` | Target resolves to a private/loopback/link-local/metadata IP (SSRF guard). |
| 422 | `UNSUPPORTED_TARGET` | Scheme or port not allowed (e.g. `ftp://`, non 80/443). |
| 429 | `RATE_LIMITED` | Client exceeded the rate limit. `Retry-After` set. |
| 503 | `OVER_CAPACITY` | Concurrency limit reached; load shed. `Retry-After` set. |
| 404 | `NOT_FOUND` | Unknown route. |
| 500 | `INTERNAL_ERROR` | Unexpected server error. |

A reachable-but-failed fetch (still `200`):

```json
{
  "url": "https://slow.example/",
  "reachable": false,
  "fetchError": { "code": "TIMEOUT_TOTAL", "message": "exceeded total deadline" },
  "redirects": { "count": 0, "finalUrl": "https://slow.example/", "chain": [] },
  "checks": [{ "id": "reachable", "weight": 3, "verdict": "fail", "detail": "unreachable: TIMEOUT_TOTAL" }],
  "score": 0
}
```

#### Fetch error codes

`DNS_FAILURE`, `CONNECTION_REFUSED`, `CONNECTION_RESET`, `TLS_ERROR`, `TIMEOUT_CONNECT`, `TIMEOUT_HEADERS`, `TIMEOUT_BODY`, `TIMEOUT_TOTAL`, `REDIRECT_LOOP`, `TOO_MANY_REDIRECTS`, `PROTOCOL_ERROR`, `UNREACHABLE`.

### Health

| Route | Purpose |
|---|---|
| `GET /healthz` | Liveness — `{ "status": "ok" }`. |
| `GET /readyz` | Readiness — pings Redis; `503 { "status": "degraded", "check": "redis" }` if down. |
| `GET /` | Service info, endpoint list, and the build credit line. |

## Configuration

Config is read from the environment and validated at boot (the process refuses to start on invalid config). Full list in [.env.example](.env.example); the ones you'll usually touch:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port. |
| `REDIS_URL` | `redis://localhost:6379` | Cache + rate-limit store. Required (non-localhost) in production. |
| `CACHE_TTL_SECONDS` | `300` | How long a result stays fresh. |
| `NEG_CACHE_TTL_SECONDS` | `30` | TTL for failed/unreachable results. |
| `FETCH_TOTAL_DEADLINE_MS` | `10000` | Hard ceiling on a single fetch. |
| `MAX_RESPONSE_BYTES` | `2097152` | Streamed download cap. |
| `MAX_REDIRECTS` | `5` | Redirect cap. |
| `ALLOWED_SCHEMES` / `ALLOWED_PORTS` | `http,https` / `80,443` | Target allowlist. |
| `ALLOW_PRIVATE_IPS` | `false` | Disables the SSRF guard when `true` (tests only). |
| `GLOBAL_MAX_CONCURRENCY` | `50` | In-flight audit cap before load shedding. |
| `RATE_LIMIT_MAX` | `60` | Requests per window per client. |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Rate-limit window. |

## Testing

```bash
npm test              # vitest, no live network (mock origin + ioredis-mock)
npm run test:coverage
npm run typecheck
npm run lint
```

CI runs install → typecheck → lint → coverage → build on every push (`.github/workflows/ci.yml`).

## Deployment

The service is a stateless container plus Redis. It ships with a multi-stage [Dockerfile](Dockerfile) and a [render.yaml](render.yaml) blueprint that provisions the web service and a managed Redis in one step — that's what the live link runs on. `.vercelignore` / `.gcloudignore` and a Vercel function wrapper are included for alternative hosts.

Scaling design for higher load (10k audits/day, 500-concurrent bursts) is written up separately in [SCALING.md](SCALING.md).

## License

MIT.
