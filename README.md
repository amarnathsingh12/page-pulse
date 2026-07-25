# Page Pulse

A production-grade URL audit service. Give it a URL; it fetches the page under strict timeouts/size limits, runs reachability/SEO/performance checks, and returns a structured report with a weighted 0–100 score.

**Live:** https://page-pulse-80mo.onrender.com
Built for Digital Heroes Training Task — https://digitalheroesco.com

## What it does

- Fetches the target with layered timeouts, a redirect cap, a streamed size cap, and decompression-bomb guards (undici).
- Blocks SSRF: DNS is pinned and the resolved IP is checked, so private/loopback/link-local/cloud-metadata addresses are rejected.
- Caches results in Redis for a configurable window; repeat audits of the same URL skip the refetch.
- Rate limits per client (sliding window in Redis), sheds load past a concurrency limit, and tags every request with an ID for structured logs.

## Quick start

Requires Node 20+ and a Redis instance.

```bash
cp .env.example .env
npm install
npm run dev            # http://localhost:8080
```

Or run app + Redis together:

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

```json
{
  "url": "https://example.com",
  "options": { "timeoutMs": 8000, "maxRedirects": 5 }
}
```

| Field | Required | Notes |
|---|---|---|
| `url` | yes | Must be `http`/`https`. Normalized before fetch. |
| `options.timeoutMs` | no | Clamped to `[500, FETCH_TOTAL_DEADLINE_MS]`. |
| `options.maxRedirects` | no | Clamped to `[0, MAX_REDIRECTS]`. |

### `GET /audit`

Same audit via query string: `?url=<encoded>&timeoutMs=&maxRedirects=`

### Cache control

- `?fresh=1` or header `Cache-Control: no-cache` → bypass cache and refetch.
- `Cache-Control: no-store` → refetch and skip writing back to cache.

### Success response — `200`

`200` means the audit *completed* — a target returning its own 4xx/5xx is a failing check, not an API error.

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
    { "id": "http-status", "weight": 3, "verdict": "pass", "detail": "200 (2xx)" }
  ],
  "score": 93,
  "fetchedAt": "2026-07-25T08:08:52.039Z",
  "cache": { "status": "bypass", "age": 0 }
}
```

Key fields: `reachable` is false only if the fetch itself failed (see `fetchError`); `seo` is `null` for non-HTML responses; `score` is `null` if no check applies; `cache.status` is `hit`/`miss`/`bypass`.

### Checks

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

SEO checks are `n/a` for non-HTML responses.

**Scoring:** `pass`=1, `warn`=0.5, `fail`=0, `n/a` excluded from denominator.
`score = round(100 × Σ(weight × credit) / Σ(weight))` — `null` if every check is `n/a`.

### Response headers

`X-Request-Id` (all) · `X-Cache: HIT/MISS/BYPASS` and `Age` (on `/audit`) · `RateLimit-Limit/-Remaining/-Reset` (all) · `Retry-After` (on `429`/`503`).

### Errors

Errors from our service use a consistent envelope. A failing *target* is not an error — it's still a `200` with a failing check.

```json
{ "error": { "code": "BLOCKED_TARGET", "message": "Target resolves to a disallowed address.", "requestId": "..." } }
```

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing/malformed `url` or bad request body. |
| 403 | `BLOCKED_TARGET` | Target resolves to a private/loopback/link-local/metadata IP (SSRF guard). |
| 422 | `UNSUPPORTED_TARGET` | Scheme or port not allowed (e.g. `ftp://`, non 80/443). |
| 429 | `RATE_LIMITED` | Client exceeded the rate limit. |
| 503 | `OVER_CAPACITY` | Concurrency limit reached; load shed. |
| 404 | `NOT_FOUND` | Unknown route. |
| 500 | `INTERNAL_ERROR` | Unexpected server error. |

Fetch-side failures (`reachable: false`) still return `200`, with `fetchError.code` set to one of: `DNS_FAILURE`, `CONNECTION_REFUSED`, `CONNECTION_RESET`, `TLS_ERROR`, `TIMEOUT_CONNECT`, `TIMEOUT_HEADERS`, `TIMEOUT_BODY`, `TIMEOUT_TOTAL`, `REDIRECT_LOOP`, `TOO_MANY_REDIRECTS`, `PROTOCOL_ERROR`, `UNREACHABLE`.

### Health

`GET /healthz` — liveness. `GET /readyz` — pings Redis, `503` if down. `GET /` — service info + build credit.

## Configuration

Read from the environment, validated at boot (won't start on invalid config). Full list in [.env.example](.env.example); the common ones:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port. |
| `REDIS_URL` | `redis://localhost:6379` | Cache + rate-limit store. |
| `CACHE_TTL_SECONDS` | `300` | Result freshness window. |
| `NEG_CACHE_TTL_SECONDS` | `30` | TTL for failed/unreachable results. |
| `FETCH_TOTAL_DEADLINE_MS` | `10000` | Hard ceiling on a single fetch. |
| `MAX_RESPONSE_BYTES` | `2097152` | Streamed download cap. |
| `MAX_REDIRECTS` | `5` | Redirect cap. |
| `ALLOWED_SCHEMES` / `ALLOWED_PORTS` | `http,https` / `80,443` | Target allowlist. |
| `ALLOW_PRIVATE_IPS` | `false` | Disables SSRF guard (tests only). |
| `GLOBAL_MAX_CONCURRENCY` | `50` | In-flight audit cap. |
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

Stateless container + Redis. Ships with a multi-stage [Dockerfile](Dockerfile) and a [render.yaml](render.yaml) blueprint (provisions web service + managed Redis — that's what the live link runs on). `.vercelignore`/`.gcloudignore` and a Vercel function wrapper are included for alternative hosts.

Scaling notes for higher load (10k audits/day, 500-concurrent bursts) are in [SCALING.md](SCALING.md).

## License

MIT.
