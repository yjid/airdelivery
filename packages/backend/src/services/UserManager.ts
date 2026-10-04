/**
 * In-memory user registry.
 *
 * Buckets users by network prefix so nearby-user discovery is O(bucket) rather
 * than O(users) — the previous version claimed to do this but its
 * `updateUser` prefix-migration branch had an off-by-one (`delete` on the new
 * bucket instead of the old one), leaking entries.
 *
 * Everything here is per-connection and intentionally unpersisted. Nothing a
 * user does should outlive their socket.
 */

import type { Member } from '@airdelivery/protocol';
import type { ClassifiedAddress } from '../utils/net.js';
import { logger } from '../utils/logger.js';

export interface User {
  id: string;
  name: string;
  /** Canonical address. Kept in memory only; never logged raw. */
  address: string;
  addressScope: string;
  /** Bucket key for nearby matching. Null means "matches nobody". */
  prefix: string | null;
  isLocal: boolean;
  /** Non-reversible log identifier. */
  fingerprint: string;
  inFlight: boolean;
  connectedAt: number;
}

export class UserManager {
  private users = new Map<string, User>();
  private usersByPrefix = new Map<string, Set<string>>();

  constructor(private readonly maxNearby = 200) {}

  add(socketId: string, data: Omit<User, 'id' | 'inFlight' | 'connectedAt'>): User {
    const user: User = {
      id: socketId,
      inFlight: false,
      connectedAt: Date.now(),
      ...data,
    };

    const existing = this.users.get(socketId);
    if (existing?.prefix && existing.prefix !== user.prefix) {
      this.unbucket(existing.prefix, socketId);
    }

    this.users.set(socketId, user);
    if (user.prefix) this.bucket(user.prefix, socketId);
    return user;
  }

  remove(socketId: string): void {
    const user = this.users.get(socketId);
    if (!user) return;
    if (user.prefix) this.unbucket(user.prefix, socketId);
    this.users.delete(socketId);
  }

  get(socketId: string): User | undefined {
    return this.users.get(socketId);
  }

  get size(): number {
    return this.users.size;
  }

  update(socketId: string, updates: Partial<Pick<User, 'name' | 'inFlight'>>): void {
    const user = this.users.get(socketId);
    if (user) this.users.set(socketId, { ...user, ...updates });
  }

  /**
   * Users on the same network prefix.
   *
   * Two guards the old version lacked:
   *  - a hard cap, so a campus NAT with ten thousand clients cannot make one
   *    `getNearbyUsers` allocate ten thousand objects;
   *  - scope matching. A user behind a private NAT must not be shown a user
   *    on a public IP that merely happens to share a /16.
   */
  nearby(socketId: string): Member[] {
    const self = this.users.get(socketId);
    if (!self?.prefix) return [];

    const bucket = this.usersByPrefix.get(self.prefix);
    if (!bucket) return [];

    const out: Member[] = [];
    for (const id of bucket) {
      if (id === socketId) continue;
      if (out.length >= this.maxNearby) {
        logger.debug({ self: self.fingerprint }, 'nearby list truncated at cap');
        break;
      }
      const other = this.users.get(id);
      if (!other || other.inFlight) continue;
      if (other.prefix !== self.prefix) continue;
      // A local network and a public address are never "nearby" even if a
      // misconfigured bucket says otherwise.
      if (other.isLocal !== self.isLocal) continue;
      out.push({ id, name: other.name });
    }
    return out;
  }

  /** Builds a User from a classified address. */
  static fromAddress(socketId: string, name: string, addr: ClassifiedAddress): Omit<User, 'id' | 'inFlight' | 'connectedAt'> {
    return {
      name,
      address: addr.address,
      addressScope: addr.scope,
      prefix: addr.prefix,
      isLocal: addr.isLocal,
      fingerprint: addr.fingerprint,
    };
  }

  // -- internals ------------------------------------------------------------

  private bucket(prefix: string, socketId: string): void {
    let set = this.usersByPrefix.get(prefix);
    if (!set) {
      set = new Set();
      this.usersByPrefix.set(prefix, set);
    }
    set.add(socketId);
  }

  private unbucket(prefix: string, socketId: string): void {
    const set = this.usersByPrefix.get(prefix);
    if (!set) return;
    set.delete(socketId);
    if (set.size === 0) this.usersByPrefix.delete(prefix);
  }
}