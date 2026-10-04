/**
 * IP address classification.
 *
 * This module is what makes "nearby users" work at all, and the previous
 * implementation was wrong in ways that broke the exact networks people care
 * about most:
 *
 *  - `100.64.0.0/10` (CGNAT) was classified PUBLIC. That is the range mobile
 *    carriers hand out for phone hotspots, so hotspot discovery silently did
 *    nothing.
 *  - `169.254.0.0/16` (link-local / APIPA) was classified PUBLIC.
 *  - `127.0.0.0/8` was classified PUBLIC, so every local developer landed in
 *    the same "public" bucket.
 *  - `0.0.0.0/8`, broadcast and multicast were unhandled.
 *  - IPv6 loopback `::1` was classified PUBLIC.
 *  - Public IPv6 addresses were bucketed by their first two hextets, which
 *    collapses an entire mobile carrier's /32 into one bucket and shows
 *    strangers as "nearby".
 *
 * Everything below is table driven so it is trivially testable and auditable.
 */

export type AddressScope =
  | 'loopback'
  | 'private' // RFC1918 / RFC4193 ULA
  | 'cgnat' // RFC6598 shared address space
  | 'link-local' // RFC3927 / RFC4291 link-local
  | 'reserved' // documentation / benchmarking — real but never a real peer
  | 'multicast'
  | 'broadcast'
  | 'unspecified'
  | 'public';

export interface ClassifiedAddress {
  /** Canonical textual form. */
  address: string;
  scope: AddressScope;
  /** True when two peers with a matching prefix are genuinely on one network. */
  isLocal: boolean;
  /**
   * Bucket key used for nearby-user matching. Two users discover each other
   * only when their prefixes are equal.
   */
  prefix: string | null;
  /** Privacy-safe identifier for logs. Never the raw address. */
  fingerprint: string;
}

/** v4 CIDR blocks we treat as non-public. */
const V4_LOCAL_BLOCKS: ReadonlyArray<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // RFC6598 CGNAT — phone hotspots live here
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local / APIPA
  ['172.16.0.0', 12], // RFC1918
  ['192.168.0.0', 16], // RFC1918
];

/**
 * Reserved but real-looking ranges.
 *
 * Separate from local ranges on purpose: two people both reading RFC1918
 * documentation should not appear as "nearby" to each other, and neither
 * should they be shown a bucket full of strangers.
 */
const V4_RESERVED_BLOCKS: ReadonlyArray<[string, number]> = [
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
];

const V4_SPECIAL_BLOCKS: ReadonlyArray<[string, number]> = [
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes 255.255.255.255
];

/**
 * IPv6 local blocks.
 *
 * `::` and `::1` are deliberately absent: they are full-address comparisons,
 * not prefixes. `::1` as a /128 would match every address whose last hextet
 * happens to be 1, which classified almost all of IPv6 as loopback.
 */
const V6_LOCAL_BLOCKS: ReadonlyArray<[string, number]> = [
  ['fc00::', 7], // RFC4193 unique local
  ['fe80::', 10], // link-local
];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseIpv4(input: string): number[] | null {
  const parts = input.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (part.length === 0 || part.length > 3 || !/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function parseIpv6(input: string): number[] | null {
  const value = input.trim();
  if (!value.includes(':')) return null;

  // Split on the "::" elision.
  const doubleColon = value.indexOf('::');
  let head: string[];
  let tail: string[] = [];

  if (doubleColon === -1) {
    head = value.split(':');
  } else {
    const before = value.slice(0, doubleColon);
    const after = value.slice(doubleColon + 2);
    head = before ? before.split(':') : [];
    tail = after ? after.split(':') : [];
    // "::" may only elide once.
    if (after.includes('::')) return null;
  }

  const parseGroups = (groups: string[]): number[] | null => {
    const out: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (group.includes('.')) {
        // Trailing IPv4-mapped form, e.g. ::ffff:192.168.1.1
        if (i !== groups.length - 1) return null;
        const v4 = parseIpv4(group);
        if (!v4) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
        continue;
      }
      if (group.length === 0 || group.length > 4 || !/^[0-9a-fA-F]+$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };

  const headNums = parseGroups(head);
  const tailNums = parseGroups(tail);
  if (!headNums || !tailNums) return null;

  const total = headNums.length + tailNums.length;
  if (doubleColon === -1) {
    return total === 8 ? headNums : null;
  }
  if (total > 7) return null;
  const elided = 8 - total;
  return [...headNums, ...new Array<number>(elided).fill(0), ...tailNums];
}

// ---------------------------------------------------------------------------
// Scope detection
// ---------------------------------------------------------------------------

function v4InBlock(octets: number[], block: [string, number]): boolean {
  const base = parseIpv4(block[0]);
  if (!base) return false;
  const bits = block[1];
  for (let i = 0; i < 4; i++) {
    const remaining = bits - i * 8;
    if (remaining <= 0) break;
    const mask = remaining >= 8 ? 0xff : (0xff << (8 - remaining)) & 0xff;
    if ((octets[i] & mask) !== (base[i] & mask)) return false;
  }
  return true;
}

function v6InBlock(groups: number[], block: [string, number]): boolean {
  const base = parseIpv6(block[0]);
  if (!base) return false;
  const bits = block[1];
  for (let i = 0; i < 8; i++) {
    const remaining = bits - i * 16;
    if (remaining <= 0) break;
    const mask = remaining >= 16 ? 0xffff : (0xffff << (16 - remaining)) & 0xffff;
    if ((groups[i] & mask) !== (base[i] & mask)) return false;
  }
  return true;
}

function classifyIpv4(octets: number[]): AddressScope {
  if (octets.every((o) => o === 0)) return 'unspecified';

  for (const [block, bits] of V4_LOCAL_BLOCKS) {
    if (v4InBlock(octets, [block, bits])) {
      if (block === '127.0.0.0') return 'loopback';
      if (block === '169.254.0.0') return 'link-local';
      if (block === '100.64.0.0') return 'cgnat';
      if (block === '0.0.0.0') return 'unspecified';
      return 'private';
    }
  }

  for (const [block, bits] of V4_RESERVED_BLOCKS) {
    if (v4InBlock(octets, [block, bits])) return 'reserved';
  }

  for (const [block, bits] of V4_SPECIAL_BLOCKS) {
    if (v4InBlock(octets, [block, bits])) {
      return octets.every((o) => o === 255) ? 'broadcast' : 'multicast';
    }
  }

  return 'public';
}

function groupsEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((g, i) => g === b[i]);
}

const V6_UNSPECIFIED = [0, 0, 0, 0, 0, 0, 0, 0];
const V6_LOOPBACK = [0, 0, 0, 0, 0, 0, 0, 1];

function classifyIpv6(groups: number[]): AddressScope {
  if (groupsEqual(groups, V6_UNSPECIFIED)) return 'unspecified';
  if (groupsEqual(groups, V6_LOOPBACK)) return 'loopback';
  if ((groups[0] & 0xff00) === 0xff00) return 'multicast';

  for (const block of V6_LOCAL_BLOCKS) {
    if (v6InBlock(groups, block)) {
      return block[0] === 'fe80::' ? 'link-local' : 'private';
    }
  }

  // IPv4-mapped (::ffff:a.b.c.d) — classify by the embedded v4 address so an
  // IPv6 socket on a private LAN is still treated as local.
  const isV4Mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (isV4Mapped) {
    const octets = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
    return classifyIpv4(octets);
  }

  // IPv4-compatible (deprecated) and NAT64 well-known prefix.
  const isNat64 = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0x0064;
  if (isNat64) {
    const octets = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
    return classifyIpv4(octets);
  }

  return 'public';
}

/** Scopes that mean "these two devices share a network". */
const LOCAL_SCOPES: ReadonlySet<AddressScope> = new Set<AddressScope>([
  'loopback',
  'private',
  'cgnat',
  'link-local',
]);

// ---------------------------------------------------------------------------
// Canonicalization + prefix
// ---------------------------------------------------------------------------

function canonicalIpv4(octets: number[]): string {
  return octets.join('.');
}

function canonicalIpv6(groups: number[]): string {
  return groups.map((g) => g.toString(16)).join(':');
}

/**
 * Bucket size per scope.
 *
 * Local networks get a /24 for v4 and a /64 for v6: one household or office
 * floor is exactly one bucket, no more, no less. Public addresses get a /16
 * for v4 and a /48 for v6, which is coarse enough not to be a tracking
 * fingerprint but tight enough not to dump a whole carrier's subscribers into
 * one "nearby" list.
 */
function prefixFor(
  scope: AddressScope,
  version: 4 | 6,
  octets?: number[],
  groups?: number[],
): string | null {
  // Only genuine private networks and public routable space get a bucket.
  // Loopback, reserved, multicast, broadcast and unspecified match nobody:
  // loopback is `isLocal` so callers can reason about it, but bucketing every
  // loopback client together would put unrelated local processes in one list.
  if (scope === 'loopback' || scope === 'reserved') return null;
  if (scope !== 'public' && !LOCAL_SCOPES.has(scope)) return null;

  if (version === 4 && octets) {
    const bits = LOCAL_SCOPES.has(scope) ? 24 : 16;
    return octets.slice(0, bits / 8).join('.');
  }

  if (version === 6 && groups) {
    const bits = LOCAL_SCOPES.has(scope) ? 64 : 48;
    const hextets = bits / 16;
    return `${groups
      .slice(0, hextets)
      .map((g) => g.toString(16))
      .join(':')}::/${bits}`;
  }

  return null;
}

/**
 * A stable, non-reversible identifier for logs.
 *
 * We never want raw addresses in a log aggregator, but we do want to be able
 * to count "how many distinct clients hit this error". FNV-1a over the
 * canonical form is fine for that and is not a security primitive — it is
 * explicitly documented as such so nobody mistakes it for anonymization.
 */
function fingerprint(canonical: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0');
}

/**
 * Strips a zone index (`fe80::1%en0`) which is meaningless off-device.
 */
function stripZone(address: string): string {
  const idx = address.indexOf('%');
  return idx === -1 ? address : address.slice(0, idx);
}

/** Unwraps `::ffff:1.2.3.4` down to `1.2.3.4` and strips `::ffff:`. */
function unwrapV4Mapped(address: string): string {
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

/**
 * Classifies an address. Never throws — an unparseable address is reported as
 * public with a null prefix, which means "matches nobody", the safe default.
 */
export function classifyAddress(raw: string): ClassifiedAddress {
  const cleaned = stripZone((raw ?? '').trim());

  if (!cleaned) {
    return {
      address: 'unknown',
      scope: 'unspecified',
      isLocal: false,
      prefix: null,
      fingerprint: fingerprint('unknown'),
    };
  }

  const v4 = parseIpv4(cleaned);
  if (v4) {
    const scope = classifyIpv4(v4);
    const canonical = canonicalIpv4(v4);
    return {
      address: canonical,
      scope,
      isLocal: LOCAL_SCOPES.has(scope),
      prefix: prefixFor(scope, 4, v4),
      fingerprint: fingerprint(canonical),
    };
  }

  const v6 = parseIpv6(cleaned);
  if (v6) {
    const scope = classifyIpv6(v6);
    const canonical = canonicalIpv6(v6);
    return {
      address: canonical,
      scope,
      isLocal: LOCAL_SCOPES.has(scope),
      prefix: prefixFor(scope, 6, undefined, v6),
      fingerprint: fingerprint(canonical),
    };
  }

  return {
    address: cleaned,
    scope: 'public',
    isLocal: false,
    prefix: null,
    fingerprint: fingerprint(cleaned),
  };
}

/**
 * Pulls the client address out of a handshake request.
 *
 * Order matters:
 *  1. If we do not sit behind a trusted proxy, only the socket address is
 *     believable. Honouring `x-forwarded-for` unconditionally lets any client
 *     claim any address and poison nearby-user buckets.
 *  2. `cf-connecting-ip` first when trusted, because Cloudflare appends to
 *     `x-forwarded-for` and the left-most entry is the one we appended.
 *  3. `x-forwarded-for`, taking the entry the outermost proxy appended —
 *     which is the right-most one — unless a proxy count tells us otherwise.
 */
export function resolveClientAddress(
  headers: Record<string, string | string[] | undefined> | undefined,
  socketAddress: string | undefined,
  trustProxy: boolean,
): string {
  const socketAddr = socketAddress ?? '';

  if (!trustProxy || !headers) return socketAddr;

  const cf = headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf.trim();

  const forwarded = headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  if (raw) {
    const chain = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (chain.length > 0) {
      // The right-most entry was appended by the proxy closest to us and is
      // the only one that proxy vouched for.
      return chain[chain.length - 1];
    }
  }

  const real = headers['x-real-ip'];
  if (typeof real === 'string' && real) return real.trim();

  return socketAddr;
}

export { unwrapV4Mapped };
