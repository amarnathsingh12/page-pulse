export type HttpClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'unknown';

export type Verdict = 'pass' | 'warn' | 'fail' | 'n/a';

export type FetchErrorCode =
  | 'DNS_FAILURE'
  | 'CONNECTION_REFUSED'
  | 'CONNECTION_RESET'
  | 'TLS_ERROR'
  | 'TIMEOUT_CONNECT'
  | 'TIMEOUT_HEADERS'
  | 'TIMEOUT_BODY'
  | 'TIMEOUT_TOTAL'
  | 'REDIRECT_LOOP'
  | 'TOO_MANY_REDIRECTS'
  | 'PROTOCOL_ERROR'
  | 'UNREACHABLE';

export interface RedirectHop {
  url: string;
  status: number;
}

export interface Timings {
  dnsMs: number | null;
  connectMs: number | null;
  ttfbMs: number | null;
  downloadMs: number | null;
  totalMs: number;
}

export interface HttpInfo {
  status: number;
  class: HttpClass;
  ok: boolean;
}

export interface FetchContent {
  contentType: string | null;
  bytes: number;
  encoding: string | null;
  truncated: boolean;
  charset: string | null;
  isHtml: boolean;
  body?: Buffer;
}

export interface FetchOutcome {
  reachable: boolean;
  fetchError?: { code: FetchErrorCode; message: string };
  http?: HttpInfo;
  redirects: { count: number; finalUrl: string; chain: RedirectHop[] };
  timing: Timings;
  content?: FetchContent;
}

export interface Seo {
  title: { present: boolean; length: number };
  metaDescription: { present: boolean; length: number };
  h1: { present: boolean; count: number };
}

export interface CheckResult {
  id: string;
  verdict: Verdict;
  weight: number;
  detail: string;
}

export interface AuditResult {
  url: string;
  reachable: boolean;
  fetchError?: { code: FetchErrorCode; message: string };
  http?: HttpInfo;
  redirects: { count: number; finalUrl: string; chain: RedirectHop[] };
  timing: Timings;
  content: {
    contentType: string | null;
    bytes: number;
    encoding: string | null;
    truncated: boolean;
  };
  seo: Seo | null;
  checks: CheckResult[];
  score: number | null;
  fetchedAt: string;
}

export interface FetcherOptions {
  timeoutMs: number;
  maxRedirects: number;
}
