/**
 * IP classification tests.
 *
 * These cover the four required network scenarios. Every case in the first
 * three describes a real failure: CGNAT is what mobile carriers hand out for
 * hotspots, and loopback being classified "public" is why local development
 * put unrelated users in the same bucket.
 */

import { describe, expect, test } from 'bun:test';
import { classifyAddress, resolveClientAddress } from '../src/utils/net.js';

describe('classifyAddress — IPv4 local ranges', () => {
  test('RFC1918 10/8', () => {
    const r = classifyAddress('10.0.0.5');
    expect(r.scope).toBe('private');
    expect(r.isLocal).toBe(true);
    expect(r.prefix).toBe('10.0.0');
  });

  test('RFC1918 172.16/12 lower bound', () => {
    expect(classifyAddress('172.16.0.1').isLocal).toBe(true);
    expect(classifyAddress('172.16.0.1').prefix).toBe('172.16.0');
  });

  test('RFC1918 172.16/12 upper bound', () => {
    expect(classifyAddress('172.31.255.254').isLocal).toBe(true);
  });

  test('172.15 and 172.32 are public — off-by-one guard', () => {
    expect(classifyAddress('172.15.0.1').isLocal).toBe(false);
    expect(classifyAddress('172.32.0.1').isLocal).toBe(false);
  });

  test('RFC1918 192.168/16', () => {
    expect(classifyAddress('192.168.1.42').isLocal).toBe(true);
    expect(classifyAddress('192.168.1.42').prefix).toBe('192.168.1');
  });
});

describe('classifyAddress — the mobile hotspot case', () => {
  test('CGNAT 100.64/10 lower bound is local', () => {
    // This is the range carriers hand out for phone hotspots. The old
    // implementation classified it PUBLIC, so hotspot discovery found nobody.
    const r = classifyAddress('100.64.0.1');
    expect(r.scope).toBe('cgnat');
    expect(r.isLocal).toBe(true);
  });

  test('CGNAT 100.64/10 upper bound is local', () => {
    expect(classifyAddress('100.127.255.254').isLocal).toBe(true);
  });

  test('100.63 and 100.128 are outside CGNAT', () => {
    expect(classifyAddress('100.63.255.255').scope).not.toBe('cgnat');
    expect(classifyAddress('100.128.0.0').scope).not.toBe('cgnat');
  });

  test('link-local 169.254/16 (APIPA) is local', () => {
    const r = classifyAddress('169.254.10.20');
    expect(r.scope).toBe('link-local');
    expect(r.isLocal).toBe(true);
  });

  test('common Android hotspot range 192.168.43/24', () => {
    expect(classifyAddress('192.168.43.128').prefix).toBe('192.168.43');
  });

  test('common iOS hotspot range 172.20.10/24', () => {
    expect(classifyAddress('172.20.10.5').isLocal).toBe(true);
    expect(classifyAddress('172.20.10.5').prefix).toBe('172.20.10');
  });
});

describe('classifyAddress — ranges the old version got wrong', () => {
  test('loopback is local, not public', () => {
    // The old regex only matched 10/172/192.168, so 127.0.0.1 was PUBLIC and
    // every local developer shared a bogus "public" bucket.
    const r = classifyAddress('127.0.0.1');
    expect(r.scope).toBe('loopback');
    expect(r.isLocal).toBe(true);
    expect(r.prefix).toBeNull();
  });

  test('the whole 127/8 is loopback', () => {
    expect(classifyAddress('127.1.2.3').scope).toBe('loopback');
  });

  test('0.0.0.0/8 is unspecified and matches nobody', () => {
    const r = classifyAddress('0.0.0.0');
    expect(r.scope).toBe('unspecified');
    expect(r.prefix).toBeNull();
    expect(r.isLocal).toBe(false);
  });

  test('multicast is not a nearby peer', () => {
    expect(classifyAddress('224.0.0.1').prefix).toBeNull();
    expect(classifyAddress('239.255.255.250').prefix).toBeNull();
  });

  test('broadcast is not a nearby peer', () => {
    expect(classifyAddress('255.255.255.255').prefix).toBeNull();
  });

  test('documentation ranges are not treated as real peers', () => {
    expect(classifyAddress('192.0.2.5').isLocal).toBe(false);
    expect(classifyAddress('198.51.100.5').isLocal).toBe(false);
    expect(classifyAddress('203.0.113.5').isLocal).toBe(false);
  });
});

describe('classifyAddress — IPv6', () => {
  test('loopback ::1 is local', () => {
    const r = classifyAddress('::1');
    expect(r.scope).toBe('loopback');
    expect(r.isLocal).toBe(true);
  });

  test('the unspecified address', () => {
    expect(classifyAddress('::').scope).toBe('unspecified');
  });

  test('unique local fc00::/7 is private', () => {
    const r = classifyAddress('fd12:3456:789a::1');
    expect(r.scope).toBe('private');
    expect(r.isLocal).toBe(true);
  });

  test('fc00::/7 lower bound', () => {
    expect(classifyAddress('fc00::1').isLocal).toBe(true);
  });

  test('link-local fe80::/10', () => {
    const r = classifyAddress('fe80::1ff:fe23:4567:890a');
    expect(r.scope).toBe('link-local');
    expect(r.isLocal).toBe(true);
  });

  test('multicast ff00::/8 has no prefix', () => {
    expect(classifyAddress('ff02::1').prefix).toBeNull();
  });

  test('a zone index is stripped', () => {
    expect(classifyAddress('fe80::1%en0').scope).toBe('link-local');
  });

  test('a global address is public', () => {
    expect(classifyAddress('2409:8f00::1').isLocal).toBe(false);
  });

  test('IPv4-mapped private addresses inherit the v4 scope', () => {
    // A dual-stack socket on a private LAN must still be seen as local, or
    // nearby discovery fails for exactly the laptop+phone case we care about.
    const r = classifyAddress('::ffff:192.168.1.5');
    expect(r.isLocal).toBe(true);
  });

  test('IPv4-mapped public addresses stay public', () => {
    expect(classifyAddress('::ffff:8.8.8.8').isLocal).toBe(false);
  });

  test('public IPv6 uses a /48 so a carrier is not one giant bucket', () => {
    // The old code bucketed public IPv6 by the first two hextets, which
    // collapsed an entire mobile carrier into a single "nearby" list.
    const a = classifyAddress('2409:8f00:1111::1');
    const b = classifyAddress('2409:8f10:2222::1');
    expect(a.prefix).not.toBe(b.prefix);
  });

  test('local IPv6 uses a /64 so one LAN is one bucket', () => {
    const a = classifyAddress('fd00::1');
    const b = classifyAddress('fd00::ffff:ffff:ffff');
    expect(a.prefix).toBe(b.prefix);
  });
});

describe('classifyAddress — robustness', () => {
  test('unparseable input is public with no prefix, never throws', () => {
    for (const bad of ['', '   ', 'not-an-ip', '999.999.999.999', '1.2.3', ':::', 'gggg::1']) {
      const r = classifyAddress(bad);
      expect(r.prefix).toBeNull();
      expect(r.isLocal).toBe(false);
    }
  });

  test('unusual but valid IPv4 forms', () => {
    expect(classifyAddress('010.0.0.1').scope).toBeDefined();
    expect(classifyAddress('1.2.3.4').isLocal).toBe(false);
  });

  test('the fingerprint is stable and does not contain the address', () => {
    const a = classifyAddress('192.168.1.5');
    const b = classifyAddress('192.168.1.5');
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toContain('192.168');
    expect(a.fingerprint.length).toBeGreaterThan(4);
  });

  test('different addresses get different fingerprints', () => {
    expect(classifyAddress('192.168.1.5').fingerprint).not.toBe(
      classifyAddress('192.168.1.6').fingerprint,
    );
  });

  test('fingerprints are short enough to be useful in a log line', () => {
    expect(classifyAddress('8.8.8.8').fingerprint.length).toBeLessThanOrEqual(12);
  });
});

describe('resolveClientAddress — proxy trust', () => {
  const headers = {
    'cf-connecting-ip': '203.0.113.9',
    'x-forwarded-for': '198.51.100.1, 192.0.2.1',
  };

  test('ignores forwarded headers when there is no trusted proxy', () => {
    // Trusting these unconditionally lets any client claim any address and
    // poison the nearby-user buckets.
    expect(resolveClientAddress(headers, '10.0.0.1', false)).toBe('10.0.0.1');
  });

  test('prefers cf-connecting-ip behind a trusted proxy', () => {
    expect(resolveClientAddress(headers, '10.0.0.1', true)).toBe('203.0.113.9');
  });

  test('takes the right-most x-forwarded-for entry', () => {
    expect(
      resolveClientAddress({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, '10.0.0.1', true),
    ).toBe('2.2.2.2');
  });

  test('handles an array-valued header', () => {
    expect(
      resolveClientAddress({ 'x-forwarded-for': ['1.1.1.1', '2.2.2.2'] }, '10.0.0.1', true),
    ).toBe('2.2.2.2');
  });

  test('falls back to x-real-ip', () => {
    expect(resolveClientAddress({ 'x-real-ip': '5.5.5.5' }, '10.0.0.1', true)).toBe('5.5.5.5');
  });

  test('falls back to the socket when no header is usable', () => {
    expect(resolveClientAddress({}, '10.0.0.1', true)).toBe('10.0.0.1');
    expect(resolveClientAddress(undefined, '10.0.0.1', true)).toBe('10.0.0.1');
  });

  test('survives an empty forwarded-for', () => {
    expect(resolveClientAddress({ 'x-forwarded-for': ' , ' }, '10.0.0.1', true)).toBe('10.0.0.1');
  });

  test('does not throw when the socket address is missing', () => {
    expect(resolveClientAddress({}, undefined, false)).toBe('');
  });
});