import dns, { type LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { BlockedTargetError, UnsupportedTargetError, ValidationError } from './errors';
import type { Config } from '../config/env';

const CONTROL_CHARS = /[\x00-\x1F\x7F]/;

export interface NormalizedTarget {
  url: URL;
  normalized: string;
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export function ipIsBlocked(address: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(address);
  } catch {
    return true;
  }
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      return v6.toIPv4Address().range() !== 'unicast';
    }
  }
  return addr.range() !== 'unicast';
}

function normalizeHost(url: URL): string {
  let host = url.hostname.toLowerCase();
  if (host.endsWith('.') && host.length > 1 && !host.endsWith(']')) {
    host = host.slice(0, -1);
  }
  const isDefaultPort =
    url.port === '' ||
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443');
  return isDefaultPort ? host : `${host}:${url.port}`;
}

export function normalizeUrl(raw: string, config: Config): NormalizedTarget {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ValidationError('url is required.');
  }
  if (raw.length > config.MAX_URL_LENGTH) {
    throw new ValidationError('url exceeds the maximum allowed length.', {
      maxLength: config.MAX_URL_LENGTH,
    });
  }
  if (CONTROL_CHARS.test(raw)) {
    throw new ValidationError('url contains control characters.');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('url is not a valid absolute URL.');
  }

  const scheme = url.protocol.replace(/:$/, '');
  if (!config.ALLOWED_SCHEMES_SET.has(scheme)) {
    throw new UnsupportedTargetError('URL scheme is not supported.', {
      scheme,
      allowed: [...config.ALLOWED_SCHEMES_SET],
    });
  }
  if (url.username || url.password) {
    throw new ValidationError('credentials embedded in the URL are not allowed.');
  }
  if (!url.hostname) {
    throw new ValidationError('url has no host.');
  }
  if (url.port) {
    const port = Number(url.port);
    if (!config.ALLOWED_PORTS_SET.has(port)) {
      throw new UnsupportedTargetError('URL port is not allowed.', {
        port,
        allowed: [...config.ALLOWED_PORTS_SET],
      });
    }
  }

  const literal = stripBrackets(url.hostname);
  if (!config.ALLOW_PRIVATE_IPS && ipaddr.isValid(literal) && ipIsBlocked(literal)) {
    throw new BlockedTargetError();
  }

  url.hash = '';
  const host = normalizeHost(url);
  const normalized = `${scheme}://${host}${url.pathname}${url.search}`;
  return { url, normalized };
}

export function makeSafeLookup(config: Config): LookupFunction {
  const lookup = (
    hostname: string,
    options: unknown,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) {
        callback(err, '', 0);
        return;
      }
      const list = Array.isArray(addresses) ? addresses : [addresses];
      if (list.length === 0) {
        callback(new BlockedTargetError('Host did not resolve.') as NodeJS.ErrnoException, '', 0);
        return;
      }
      if (!config.ALLOW_PRIVATE_IPS) {
        for (const a of list) {
          if (ipIsBlocked(a.address)) {
            callback(new BlockedTargetError() as NodeJS.ErrnoException, '', 0);
            return;
          }
        }
      }
      const wantsAll =
        typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
      if (wantsAll) {
        callback(null, list);
      } else {
        callback(null, list[0].address, list[0].family);
      }
    });
  };
  return lookup as unknown as LookupFunction;
}
