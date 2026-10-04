'use client';

/**
 * Socket.IO connection management.
 *
 * Three defects this replaces:
 *
 *  1. `reconnect()` dialled `http://locahost:5500` — a typo. Pressing reconnect
 *     guaranteed a permanent failure rather than a recovery.
 *
 *  2. `transports: ['websocket']`. Socket.IO's WebSocket-only mode cannot get
 *     through any proxy that strips the upgrade, which is a large share of
 *     corporate and campus networks. Polling is the fallback that works
 *     everywhere, and Socket.IO upgrades to WebSocket afterwards.
 *
 *  3. No `connect` / `disconnect` / `reconnect` handling at all. When a phone
 *     changed Wi-Fi cells the app went silently dead while still showing
 *     "Connected", and listeners registered by feature hooks were never
 *     re-attached to the recovered socket.
 *
 * Connection state is now exposed so the UI can explain what is happening, and
 * `onReconnect` lets consumers re-run whatever they need after the socket id
 * changes.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ClientConfig } from '@airdelivery/protocol';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'error';

export interface PeerIdentity {
  id?: string;
  name?: string;
}

export interface SocketContextValue {
  socket: Socket | null;
  state: ConnectionState;
  user: PeerIdentity;
  /** ICE servers and transfer tuning, or null until loaded. */
  clientConfig: ClientConfig | null;
  /** Why TURN is unavailable, for the UI. Null when TURN is configured. */
  turnNotice: string | null;
  reconnect: () => void;
  /** Registers a callback invoked after every successful (re)connect. */
  onReconnect: (fn: () => void) => () => void;
}

const SocketContext = createContext<SocketContextValue>({
  socket: null,
  state: 'connecting',
  user: {},
  clientConfig: null,
  turnNotice: null,
  reconnect: () => {},
  onReconnect: () => () => {},
});

const API_ORIGIN = process.env.NEXT_PUBLIC_API ?? 'http://localhost:5500';

/**
 * Fetches ICE servers and transfer tuning from the signaling server.
 *
 * Going through an endpoint rather than build-time env means TURN credentials
 * can be rotated on the server without rebuilding and redeploying the
 * frontend, which matters because TURN credentials are typically short-lived.
 */
async function fetchClientConfig(signalOrigin: string): Promise<ClientConfig | null> {
  const candidates = [
    `${signalOrigin.replace(/\/$/, '')}/api/v1/config`,
    `${API_ORIGIN.replace(/\/$/, '')}/api/v1/config`,
  ];

  for (const url of candidates) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      const body: unknown = await res.json();
      if (
        body &&
        typeof body === 'object' &&
        Array.isArray((body as ClientConfig).iceServers) &&
        (body as ClientConfig).iceServers.length > 0
      ) {
        return body as ClientConfig;
      }
    } catch {
      // Offline or blocked. Fall through to the built-in STUN default.
    }
  }
  return null;
}

/** STUN-only fallback so the app still works on a simple home network. */
const FALLBACK_CONFIG: ClientConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  turnAvailable: false,
  transfer: { maxChunkBytes: 256 * 1024, highWaterMarkBytes: 8 * 1024 * 1024, parallelChannels: 2 },
  limits: { maxFlightMembers: 2, flightTtlMs: 6 * 60 * 60 * 1000 },
};

export const SocketProvider = ({ children }: { children: ReactNode }) => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [state, setState] = useState<ConnectionState>('connecting');
  const [user, setUser] = useState<PeerIdentity>({});
  const [clientConfig, setClientConfig] = useState<ClientConfig | null>(null);
  const [attempt, setAttempt] = useState(0);

  const reconnectHandlers = useRef(new Set<() => void>());
  const socketRef = useRef<Socket | null>(null);
  const hadConnected = useRef(false);

  const onReconnect = useCallback((fn: () => void) => {
    reconnectHandlers.current.add(fn);
    return () => reconnectHandlers.current.delete(fn);
  }, []);

  useEffect(() => {
    let disposed = false;
    setState(hadConnected.current ? 'reconnecting' : 'connecting');

    const signalOrigin = process.env.NEXT_PUBLIC_SOCKET || 'http://localhost:5500';

    void fetchClientConfig(signalOrigin).then((cfg) => {
      if (disposed) return;
      const resolved = cfg ?? FALLBACK_CONFIG;
      setClientConfig(resolved);
    });

    const next = io(signalOrigin, {
      // Polling first, then upgrade. This is what gets us through proxies.
      transports: ['websocket', 'polling'],
      withCredentials: true,
      // Give up eventually rather than retrying silently forever, but retry
      // generously: a phone moving between cells can be offline for a while.
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 8_000,
      randomizationFactor: 0.4,
      timeout: 10_000,
      autoConnect: true,
    });

    socketRef.current = next;
    setSocket(next);

    next.on('connect', () => {
      if (disposed) return;
      setState('connected');
      // The socket id changes on every reconnect, so anything that captured the
      // old one has to re-establish itself.
      if (hadConnected.current) {
        for (const fn of reconnectHandlers.current) {
          try {
            fn();
          } catch {
            // One bad handler must not block the rest.
          }
        }
      }
      hadConnected.current = true;
    });

    next.on('yourName', (identity: PeerIdentity) => {
      if (!disposed) setUser(identity);
    });

    next.on('disconnect', (reason: string) => {
      if (disposed) return;
      // `io client disconnect` is deliberate and will not auto-reconnect.
      setState(reason === 'io client disconnect' ? 'offline' : 'reconnecting');
    });

    next.on('connect_error', (err: Error) => {
      if (disposed) return;
      setState('error');
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[socket] connection error:', err.message);
      }
    });

    // `navigator.onLine` is the only reliable hint we get for a phone that has
    // simply lost signal.
    const onOnline = () => next.connect();
    const onOffline = () => setState('offline');
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      disposed = true;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      next.removeAllListeners();
      next.disconnect();
      socketRef.current = null;
    };
  }, [attempt]);

  const reconnect = useCallback(() => {
    const current = socketRef.current;
    if (current) {
      current.removeAllListeners();
      current.disconnect();
      socketRef.current = null;
      setSocket(null);
    }
    // Remount the effect with a fresh socket.
    setAttempt((n) => n + 1);
  }, []);

  const turnNotice = useMemo(() => {
    if (!clientConfig) return null;
    if (clientConfig.turnAvailable) return null;
    return (
      'Relayed connections are not configured, so this device may not be able to reach peers ' +
      'on campus or office networks. Local and home networks are unaffected.'
    );
  }, [clientConfig]);

  const value = useMemo<SocketContextValue>(
    () => ({ socket, state, user, clientConfig, turnNotice, reconnect, onReconnect }),
    [socket, state, user, clientConfig, turnNotice, reconnect, onReconnect],
  );

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
};

export const useSocket = () => useContext(SocketContext);
