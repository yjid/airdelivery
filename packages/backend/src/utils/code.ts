/**
 * Flight code generation and normalization.
 *
 * The old implementation used `nanoid(6).toUpperCase()`. Two problems:
 *  1. Folding a 62-character alphabet into uppercase collapses distinct ids
 *     onto the same code, so collisions arrive far faster than nanoid's
 *     birthday math assumes.
 *  2. The alphabet included 0/O and 1/I/L — indistinguishable when a code is
 *     read off one screen and typed into another.
 *
 * Now: crypto-random draws from an unambiguous alphabet, with normalization
 * applied on both ends so a lowercase or mistyped code still resolves.
 */

import { randomInt } from 'node:crypto';
import { FLIGHT_CODE_ALPHABET, LIMITS, normalizeFlightCode } from '@airdelivery/protocol';

/**
 * Generates a flight code.
 *
 * Uses rejection-free modulo-free selection via `randomInt`, which is
 * cryptographically secure and, unlike `Math.random() % n`, unbiased.
 */
export function generateCode(length: number = LIMITS.FLIGHT_CODE_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += FLIGHT_CODE_ALPHABET[randomInt(0, FLIGHT_CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Generates a code that is not already taken.
 *
 * `isTaken` is injected rather than reaching into the FlightManager so this
 * stays a pure function and is directly testable. Bounded so a pathological
 * collision run cannot spin forever.
 */
export function generateUniqueCode(isTaken: (code: string) => boolean, attempts = 16): string {
  for (let i = 0; i < attempts; i++) {
    const code = generateCode();
    if (!isTaken(code)) return code;
  }
  // 36^6 is ~2.2 billion. Exhausting 16 draws means the map is either full or
  // something is wrong; either way a wider code is the safe answer.
  return generateCode(LIMITS.FLIGHT_CODE_LENGTH + 2);
}

export { normalizeFlightCode };