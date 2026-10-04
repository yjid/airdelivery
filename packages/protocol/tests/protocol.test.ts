/**
 * Protocol contract tests.
 *
 * These schemas are the trust boundary between an untrusted browser and the
 * signaling server, so they get the most adversarial coverage in the repo.
 */

import { describe, expect, test } from 'bun:test';
import {
  AckSchema,
  FlightCodeSchema,
  IceCandidateSchema,
  InviteClientSchema,
  JoinFlightClientSchema,
  LIMITS,
  SdpSchema,
  UpdateStatsClientSchema,
  ackErr,
  ackOk,
  normalizeFlightCode,
} from '../src/index.js';

describe('normalizeFlightCode', () => {
  test('accepts a canonical code', () => {
    expect(normalizeFlightCode('K7M2QX')).toBe('K7M2QX');
  });

  test('uppercases lowercase input', () => {
    expect(normalizeFlightCode('k7m2qx')).toBe('K7M2QX');
  });

  test('trims surrounding whitespace', () => {
    expect(normalizeFlightCode('  K7M2QX \n')).toBe('K7M2QX');
  });

  test('strips separators people insert when copying', () => {
    expect(normalizeFlightCode('K7M2-QX')).toBe('K7M2QX');
    expect(normalizeFlightCode('K7M2 QX')).toBe('K7M2QX');
    expect(normalizeFlightCode('K7M2_QX')).toBe('K7M2QX');
  });

  test('maps look-alike characters a human mistypes', () => {
    // O -> Q, I/L -> J, 0 -> 2, 1 -> 3, matching the generator's alphabet.
    expect(normalizeFlightCode('O')).toBeNull(); // too short regardless
    expect(normalizeFlightCode('OOOOOO')).toBe('QQQQQQ');
    expect(normalizeFlightCode('IIIIII')).toBe('JJJJJJ');
    expect(normalizeFlightCode('000000')).toBe('222222');
    expect(normalizeFlightCode('111111')).toBe('333333');
  });

  test('rejects the wrong length', () => {
    expect(normalizeFlightCode('ABC')).toBeNull();
    expect(normalizeFlightCode('ABCDEFG')).toBeNull();
    expect(normalizeFlightCode('')).toBeNull();
  });

  test('maps excluded look-alikes rather than rejecting them', () => {
    // 0/O/1/I/L are excluded from the generated alphabet so codes read
    // correctly off a screen, but a human WILL type them. Mapping beats
    // rejecting: refusing the code over one mistyped glyph is worse UX.
    expect(normalizeFlightCode('ABC0EF')).toBe('ABC2EF');
    expect(normalizeFlightCode('ABCOEF')).toBe('ABCQEF');
    expect(normalizeFlightCode('ABCIEF')).toBe('ABCJEF');
  });

  test('rejects characters with no look-alike mapping', () => {
    // Only I, L and O are excluded from the letter alphabet, and all three map
    // to a valid letter above. So a genuinely invalid code must contain a
    // non-alphanumeric that nothing maps.
    expect(normalizeFlightCode('ABC$EF')).toBeNull();
    expect(normalizeFlightCode('ABCD@F')).toBeNull();
    expect(normalizeFlightCode('AB#CDEF')).toBeNull();
    expect(normalizeFlightCode('ABC%EF')).toBeNull();
  });

  test('strips control characters a decoder or deep link can inject', () => {
    // A NUL byte is not whitespace, so trim() alone leaves it in place and the
    // code fails to validate. This is reachable from a pasted deep link.
    expect(normalizeFlightCode('K7M2QX\u0000')).toBe('K7M2QX');
    expect(normalizeFlightCode('\u0007K7M2QX\u001f')).toBe('K7M2QX');
    expect(normalizeFlightCode('K7M\t2\nQX')).toBe('K7M2QX');
  });

  test('rejects non-strings without throwing', () => {
    for (const bad of [undefined, null, 42, {}, [], true, Symbol('x')]) {
      expect(normalizeFlightCode(bad)).toBeNull();
    }
  });

  test('rejects a homograph injection attempt', () => {
    expect(normalizeFlightCode('../../etc/passwd')).toBeNull();
    expect(normalizeFlightCode('<script>')).toBeNull();
    expect(normalizeFlightCode('K7M2QX\u0000')).toBe('K7M2QX');
  });
});

describe('FlightCodeSchema', () => {
  test('is stable for a valid code', () => {
    expect(FlightCodeSchema.safeParse('ABC234').success).toBe(true);
  });
});

describe('SdpSchema — the memory exhaustion vector', () => {
  test('accepts a realistic offer', () => {
    const sdp = `v=0\r\no=- ${'1'.repeat(20)} 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n`;
    expect(SdpSchema.safeParse({ sdp }).success).toBe(true);
  });

  test('rejects an SDP beyond the cap', () => {
    const sdp = 'v=0\r\n' + 'a='.repeat(LIMITS.MAX_SDP_BYTES);
    const result = SdpSchema.safeParse({ sdp });
    expect(result.success).toBe(false);
  });

  test('rejects a non-string sdp', () => {
    expect(SdpSchema.safeParse({ sdp: { evil: true } }).success).toBe(false);
    expect(SdpSchema.safeParse({ sdp: 42 }).success).toBe(false);
    expect(SdpSchema.safeParse({}).success).toBe(false);
    expect(SdpSchema.safeParse(null).success).toBe(false);
  });

  test('only allows known description types', () => {
    expect(SdpSchema.safeParse({ sdp: 'v=0', type: 'offer' }).success).toBe(true);
    expect(SdpSchema.safeParse({ sdp: 'v=0', type: 'garbage' }).success).toBe(false);
  });
});

describe('IceCandidateSchema', () => {
  test('accepts a real candidate', () => {
    const candidate = {
      candidate: 'candidate:1 1 udp 2130706431 192.168.1.5 54321 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    expect(IceCandidateSchema.safeParse(candidate).success).toBe(true);
  });

  test('rejects an oversized candidate', () => {
    const candidate = { candidate: 'a'.repeat(LIMITS.MAX_CANDIDATE_BYTES + 1) };
    expect(IceCandidateSchema.safeParse(candidate).success).toBe(false);
  });

  test('rejects garbage', () => {
    expect(IceCandidateSchema.safeParse({}).success).toBe(false);
    expect(IceCandidateSchema.safeParse({ candidate: 123 }).success).toBe(false);
    expect(IceCandidateSchema.safeParse('not-an-object').success).toBe(false);
  });
});

describe('UpdateStatsClientSchema — the analytics poisoning vector', () => {
  test('accepts a normal report', () => {
    const parsed = UpdateStatsClientSchema.safeParse([{ filesShared: 2, bytesTransferred: 1024 }]);
    expect(parsed.success).toBe(true);
  });

  test('accepts an empty payload', () => {
    expect(UpdateStatsClientSchema.safeParse([{}]).success).toBe(true);
  });

  test('rejects negative counters', () => {
    expect(UpdateStatsClientSchema.safeParse([{ filesShared: -1 }]).success).toBe(false);
    expect(UpdateStatsClientSchema.safeParse([{ bytesTransferred: -1 }]).success).toBe(false);
  });

  test('rejects fractional counters', () => {
    expect(UpdateStatsClientSchema.safeParse([{ filesShared: 1.5 }]).success).toBe(false);
  });

  test('rejects out-of-range counters', () => {
    expect(UpdateStatsClientSchema.safeParse([{ filesShared: 1e12 }]).success).toBe(false);
    expect(UpdateStatsClientSchema.safeParse([{ bytesTransferred: Infinity }]).success).toBe(false);
    expect(UpdateStatsClientSchema.safeParse([{ bytesTransferred: NaN }]).success).toBe(false);
  });

  test('rejects a string payload', () => {
    expect(UpdateStatsClientSchema.safeParse(['lots']).success).toBe(false);
  });
});

describe('InviteClientSchema', () => {
  test('accepts a valid invite', () => {
    expect(InviteClientSchema.safeParse([{ targetId: 'abc', flightCode: 'ABC234' }]).success).toBe(
      true,
    );
  });

  test('rejects an oversized socket id', () => {
    const targetId = 'a'.repeat(200);
    expect(InviteClientSchema.safeParse([{ targetId, flightCode: 'ABC234' }]).success).toBe(false);
  });

  test('rejects a malformed flight code', () => {
    expect(InviteClientSchema.safeParse([{ targetId: 'abc', flightCode: 'nope' }]).success).toBe(
      false,
    );
  });
});

describe('JoinFlightClientSchema', () => {
  test('normalizes through the tuple', () => {
    const parsed = JoinFlightClientSchema.safeParse(['abc234']);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data[0]).toBe('ABC234');
  });

  test('rejects a non-string code', () => {
    expect(JoinFlightClientSchema.safeParse([{ toString: () => 'ABC234' }]).success).toBe(false);
  });
});

describe('AckSchema', () => {
  test('round-trips a success ack', () => {
    expect(AckSchema.safeParse(ackOk({ code: 'ABC234' })).success).toBe(true);
  });

  test('round-trips an error ack', () => {
    expect(AckSchema.safeParse(ackErr('FULL', 'Flight is full')).success).toBe(true);
  });

  test('rejects a malformed ack', () => {
    expect(AckSchema.safeParse({}).success).toBe(false);
    expect(AckSchema.safeParse(null).success).toBe(false);
  });

  test('error messages are length-capped', () => {
    const ack = ackErr('X', 'y'.repeat(500));
    expect(AckSchema.safeParse(ack).success).toBe(false);
  });
});
