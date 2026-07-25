import { describe, expect, it } from 'vitest';
import { testConfig } from '../../src/config/env';
import { ipIsBlocked, makeSafeLookup, normalizeUrl } from '../../src/lib/url';

const cfg = testConfig({ ALLOW_PRIVATE_IPS: 'false' });
const cfgAllow = testConfig({ ALLOW_PRIVATE_IPS: 'true' });

describe('ipIsBlocked', () => {
  it('blocks private, loopback, link-local, CGNAT and mapped addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(ipIsBlocked(ip)).toBe(true);
    }
  });

  it('allows public unicast addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
      expect(ipIsBlocked(ip)).toBe(false);
    }
  });
});

describe('normalizeUrl', () => {
  it('lowercases scheme and host and strips fragment + default port', () => {
    const { normalized } = normalizeUrl('HTTPS://Example.COM:443/Path?b=2&a=1#top', cfg);
    expect(normalized).toBe('https://example.com/Path?b=2&a=1');
  });

  it('preserves query parameter order', () => {
    const { normalized } = normalizeUrl('https://example.com/?b=2&a=1', cfg);
    expect(normalized).toBe('https://example.com/?b=2&a=1');
  });

  it('rejects unsupported schemes', () => {
    expect(() => normalizeUrl('ftp://example.com', cfg)).toThrowError(/scheme/i);
  });

  it('rejects malformed URLs', () => {
    expect(() => normalizeUrl('not a url', cfg)).toThrow();
  });

  it('rejects credentials embedded in the URL', () => {
    expect(() => normalizeUrl('https://user:pass@example.com', cfg)).toThrowError(/credential/i);
  });

  it('rejects disallowed ports', () => {
    expect(() => normalizeUrl('https://example.com:22', cfg)).toThrowError(/port/i);
  });

  it('blocks private IP literals when SSRF protection is on', () => {
    expect(() => normalizeUrl('http://127.0.0.1/', cfg)).toThrowError(/disallowed address/i);
  });

  it('permits private IPs only when explicitly enabled', () => {
    const { normalized } = normalizeUrl('http://127.0.0.1/', cfgAllow);
    expect(normalized).toBe('http://127.0.0.1/');
  });
});

describe('makeSafeLookup', () => {
  it('returns an array of addresses when undici calls it with all:true', async () => {
    const lookup = makeSafeLookup(cfgAllow);
    const result = await new Promise<unknown>((resolve, reject) => {
      lookup('127.0.0.1', { all: true }, (err, address) => (err ? reject(err) : resolve(address)));
    });
    expect(Array.isArray(result)).toBe(true);
    expect((result as Array<{ address: string }>)[0].address).toBe('127.0.0.1');
  });

  it('rejects when a resolved address is blocked', async () => {
    const lookup = makeSafeLookup(cfg);
    await expect(
      new Promise((resolve, reject) => {
        lookup('127.0.0.1', { all: true }, (err, address) => (err ? reject(err) : resolve(address)));
      }),
    ).rejects.toBeTruthy();
  });
});
