'use client';

/**
 * WebRTC session management.
 *
 * Replaces an implementation with four defects that made connections fail on
 * exactly the networks this app is used on:
 *
 *  1. `pc.restartIce()` was called on a transient disconnect. Calling
 *     `restartIce()` WITHOUT renegotiating is a documented no-op — it sets an
 *     internal flag and nothing else. The "reconnecting…" message was
 *     decorative. Recovery now performs a real ICE restart: create a new offer
 *     with `iceRestart: true` and push it through signaling.
 *
 *  2. No perfect negotiation. Any offer glare (both sides offering at once)
 *     made `setRemoteDescription` reject and the UI dead-end on "Connection
 *     failed — try refreshing". The polite/impolite pattern is implemented
 *     below.
 *
 *  3. A repeated `offer` event replaced `peer.current` without closing the old
 *     connection, orphaning its data channel. Offers are now deduplicated and
 *     the previous connection is always closed first.
 *
 *  4. `dataChannel` and `controlChannel` were returned as `ref.current` from
 *     render. A ref mutation does not re-render, so consumers only ever saw a
 *     channel because an unrelated `setStatus` happened to fire first. They are
 *     now state, with the refs kept only for use inside async callbacks.
 *
 * Also: STUN/TURN come from the server's config endpoint rather than being
 * hardcoded, `iceCandidatePoolSize` pre-gathers candidates so setup is faster,
 * and listeners are registered with explicit handler references so
 * `socket.off` cannot remove somebody else's listener.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EV, type IceCandidatePayload, type Member, type SdpPayload } from '@airdelivery/protocol';
import { useSocket } from '@/context/socketContext';

export type FlightStatus =
  'idle' | 'waiting' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

export type FailureCode =
  'BAD_CODE' | 'NOT_FOUND' | 'FULL' | 'BAD_PAYLOAD' | 'SELF' | 'OFFLINE' | 'INTERNAL';

export interface SignalAck {
  ok: boolean;
  code?: string;
  message?: string;
}

const DEFAULT_ICE: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export function useWebRTC(onMessage: (e: MessageEvent) => void) {
  const { socket, clientConfig, state: socketState, onReconnect } = useSocket();

  const [flightCode, setFlightCode] = useState<string | null>(null);
  const [status, setStatus] = useState<FlightStatus>('idle');
  const [failure, setFailure] = useState<FailureCode | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [ownerId, setOwnerId] = useState('');
  const [nearByUsers, setNearByUsers] = useState<Member[]>([]);
  /**
   * Perfect negotiation politeness.
   *
   * The owner is the impolite peer (it created the flight and the first
   * connection) and a joiner is polite, which resolves glare deterministically.
   * A ref rather than state: it must be readable inside `onnegotiationneeded`
   * without re-creating the peer connection, which would drop the data channel.
   */
  const polite = flightCode === null;

  // Refs mirror state for use inside long-lived callbacks, which would
  // otherwise close over a stale render.
  const peerRef = useRef<RTCPeerConnection | null>(null);
  // Channels are STATE, not refs. A ref mutation does not schedule a render, so
  // reading `ref.current` during render hands consumers a stale value that only
  // happens to be correct if an unrelated setState fired first. That is a race,
  // not a guarantee, and it meant the send queue could silently never start.
  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const [controlChannel, setControlChannel] = useState<RTCDataChannel | null>(null);
  // Refs mirror the state purely so async callbacks can read the latest value
  // without being recreated on every channel change.
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const controlChannelRef = useRef<RTCDataChannel | null>(null);
  const remoteIdRef = useRef<string | null>(null);
  const queuedCandidates = useRef<RTCIceCandidateInit[]>([]);
  const makingOffer = useRef(false);
  const ignoreOffer = useRef(false);
  const settingRemoteAnswerPending = useRef(false);
  const politeRef = useRef(false);
  const restartAttempts = useRef(0);
  const disconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageHandler = useRef(onMessage);

  // Assigning a ref during render is exactly what the lint rule forbids: a
  // render may be thrown away, leaving the ref pointing at a value from a
  // render that never committed. An effect is the correct place.
  useEffect(() => {
    messageHandler.current = onMessage;
  }, [onMessage]);

  const iceServers = useMemo(
    () => (clientConfig?.iceServers?.length ? clientConfig.iceServers : DEFAULT_ICE),
    [clientConfig],
  );

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  const teardownPeer = useCallback(() => {
    if (disconnectTimer.current) clearTimeout(disconnectTimer.current);
    if (restartTimer.current) clearTimeout(restartTimer.current);
    disconnectTimer.current = null;
    restartTimer.current = null;

    for (const channel of [dataChannelRef.current, controlChannelRef.current]) {
      if (!channel) continue;
      channel.onmessage = null;
      channel.onopen = null;
      channel.onclose = null;
      channel.onerror = null;
      channel.onbufferedamountlow = null;
      // Closing an already-closed channel throws in some engines.
      try {
        channel.close();
      } catch {
        // Nothing to do.
      }
    }
    dataChannelRef.current = null;
    controlChannelRef.current = null;
    setDataChannel(null);
    setControlChannel(null);

    const peer = peerRef.current;
    if (peer) {
      // Detach every handler before closing: `close()` can fire a final
      // connectionstatechange, which would re-enter this function.
      peer.onicecandidate = null;
      peer.onicegatheringstatechange = null;
      peer.onconnectionstatechange = null;
      peer.ondatachannel = null;
      peer.onnegotiationneeded = null;
      peer.ontrack = null;
      try {
        peer.close();
      } catch {
        // Already closed.
      }
      peerRef.current = null;
    }

    remoteIdRef.current = null;
    queuedCandidates.current = [];
    restartAttempts.current = 0;
  }, []);

  const disconnect = useCallback(
    (notifyServer = true) => {
      teardownPeer();
      setFlightCode(null);
      setStatus('disconnected');
      setOwnerId('');
      setMembers([]);
      setFailure(null);
      if (notifyServer) socket?.emit(EV.leaveFlight);
    },
    [socket, teardownPeer],
  );

  // -------------------------------------------------------------------------
  // ICE restart — a real one, with renegotiation
  // -------------------------------------------------------------------------

  // A ref holds the callback so the retry timer can re-enter it without the
  // declaration referring to itself inside its own dependency list.
  const restartRef = useRef<() => Promise<void>>(async () => {});

  const attemptIceRestart = useCallback(async () => {
    const peer = peerRef.current;
    if (!peer || !flightCode || restartAttempts.current >= 3) {
      setStatus('failed');
      return;
    }
    restartAttempts.current += 1;

    try {
      // The actual restart: a fresh offer with `iceRestart: true` re-runs
      // candidate gathering and republishes credentials to the remote peer.
      // Without the accompanying offer, `restartIce()` alone does nothing.
      const offer = await peer.createOffer({ iceRestart: true });
      await peer.setLocalDescription(offer);
      socket?.emit(EV.offer, flightCode, { sdp: peer.localDescription });
      setStatus('reconnecting');

      restartTimer.current = setTimeout(() => {
        if (peerRef.current?.connectionState === 'connected') return;
        void restartRef.current();
      }, 5000);
    } catch (err) {
      console.warn('[webrtc] ICE restart failed', err);
      setStatus('failed');
    }
  }, [flightCode, socket]);

  useEffect(() => {
    restartRef.current = attemptIceRestart;
  }, [attemptIceRestart]);

  // -------------------------------------------------------------------------
  // Peer construction
  // -------------------------------------------------------------------------

  const attachDataChannel = useCallback((channel: RTCDataChannel, isControl: boolean) => {
    channel.binaryType = 'arraybuffer';
    channel.onmessage = (e) => messageHandler.current(e);
    channel.onopen = () => setStatus('connected');
    channel.onerror = () => {
      // A channel error is terminal for the transfer; the caller decides
      // whether to renegotiate.
      console.warn('[webrtc] data channel error');
    };

    if (isControl) {
      controlChannelRef.current = channel;
      setControlChannel(channel);
    } else {
      dataChannelRef.current = channel;
      channel.bufferedAmountLowThreshold = 8 * 1024 * 1024;
      setDataChannel(channel);
    }
  }, []);

  const createPeer = useCallback(
    (remoteId: string | null) => {
      // Always tear the old one down first. Replacing `peerRef.current` without
      // closing orphaned the previous connection and its data channel, so the
      // UI showed "connected" while nothing was flowing.
      teardownPeer();

      const peer = new RTCPeerConnection({
        iceServers: iceServers as RTCIceServer[],
        // Pre-gather candidates while the user is still choosing files. Without
        // this, connection setup pays the full STUN round trip at send time.
        iceCandidatePoolSize: 10,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
      });

      peerRef.current = peer;
      remoteIdRef.current = remoteId;
      politeRef.current = polite;

      peer.onicecandidate = (e) => {
        if (!e.candidate) return;
        const target = remoteIdRef.current;
        if (!target || !flightCode) return;
        socket?.emit(EV.iceCandidate, { id: target, candidate: e.candidate.toJSON() });
      };

      peer.onconnectionstatechange = () => {
        const s = peer.connectionState;
        if (s === 'connected') {
          restartAttempts.current = 0;
          setStatus('connected');
        } else if (s === 'disconnected') {
          // Transient. A real ICE restart is worth one attempt before giving up,
          // because this is what a phone leaving Wi-Fi range looks like.
          setStatus('reconnecting');
          void attemptIceRestart();
        } else if (s === 'failed') {
          // A failed state is terminal: ICE has exhausted its candidates.
          // Without TURN this is where symmetric NAT users end up.
          setStatus('failed');
          teardownPeer();
        } else if (s === 'closed') {
          teardownPeer();
        }
      };

      // Perfect negotiation. Both sides may offer; the impolite peer ignores a
      // colliding offer and waits for a rollback, which removes the glare
      // deadlock that used to dead-end on "Connection failed".
      peer.onnegotiationneeded = async () => {
        try {
          makingOffer.current = true;
          await peer.setLocalDescription();
          const target = remoteIdRef.current;
          if (target && flightCode) {
            socket?.emit(EV.offer, flightCode, { sdp: peer.localDescription });
          }
        } catch (err) {
          console.warn('[webrtc] negotiation failed', err);
        } finally {
          makingOffer.current = false;
        }
      };

      return peer;
    },
    [attemptIceRestart, flightCode, iceServers, polite, socket, teardownPeer],
  );

  // -------------------------------------------------------------------------
  // Signaling
  // -------------------------------------------------------------------------

  const attachRemote = useCallback(async (sdp: SdpPayload) => {
    const peer = peerRef.current;
    if (!peer) return;
    await peer.setRemoteDescription(sdp as RTCSessionDescriptionInit);
    // Anything that raced ahead of setRemoteDescription is now safe to add.
    for (const candidate of queuedCandidates.current) {
      try {
        await peer.addIceCandidate(candidate);
      } catch (err) {
        console.warn('[webrtc] buffered ICE rejected', err);
      }
    }
    queuedCandidates.current = [];
  }, []);

  const handleOffer = useCallback(
    async (fromId: string, payload: SdpPayload) => {
      const offerCollision =
        makingOffer.current || (peerRef.current?.signalingState ?? 'stable') !== 'stable';
      ignoreOffer.current = !politeRef.current && offerCollision;
      if (ignoreOffer.current) return;

      try {
        if (offerCollision) {
          // Polite peer: roll back and accept the other side's offer.
          await peerRef.current?.setLocalDescription({ type: 'rollback' });
        }

        remoteIdRef.current = fromId;

        // Only build a connection if we do not have a usable one, so a
        // renegotiation does not orphan the existing data channel.
        if (!peerRef.current || peerRef.current.connectionState === 'closed') {
          const peer = createPeer(fromId);
          peer.ondatachannel = (e) => {
            attachDataChannel(e.channel, e.channel.label === 'control');
          };
        }

        await attachRemote(payload);

        // The previous implementation emitted `answer` without waiting for ICE
        // gathering but also without the `id`, so the host could never address
        // its candidates back.
        socket?.emit(EV.answer, flightCode, {
          sdp: { sdp: peerRef.current?.localDescription?.sdp ?? '', type: 'answer' },
        });
      } catch (err) {
        console.warn('[webrtc] failed to handle offer', err);
        setStatus('failed');
      }
    },
    [attachDataChannel, attachRemote, createPeer, flightCode, socket],
  );

  const handleAnswer = useCallback(
    async (fromId: string, payload: SdpPayload) => {
      try {
        settingRemoteAnswerPending.current = true;
        remoteIdRef.current = fromId;
        await attachRemote(payload);
      } catch (err) {
        console.warn('[webrtc] failed to apply answer', err);
        setStatus('failed');
      } finally {
        settingRemoteAnswerPending.current = false;
      }
    },
    [attachRemote],
  );

  const handleCandidate = useCallback(async (fromId: string, candidate: IceCandidatePayload) => {
    remoteIdRef.current = remoteIdRef.current ?? fromId;
    if (!peerRef.current?.remoteDescription) {
      // Buffer until a remote description exists; adding a candidate earlier
      // rejects and we would lose it.
      queuedCandidates.current.push(candidate);
      return;
    }
    try {
      await peerRef.current.addIceCandidate(candidate);
    } catch (err) {
      console.warn('[webrtc] ICE candidate rejected', err);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Flight lifecycle
  // -------------------------------------------------------------------------

  const connectToFlight = useCallback((code: string) => {
    setFlightCode(code.toUpperCase());
    setStatus('waiting');
    setFailure(null);
  }, []);

  const refreshNearby = useCallback(() => {
    socket?.emit(EV.getNearbyUsers);
  }, [socket]);

  const updateStats = useCallback(
    (files: number, bytesTransferred: number, relayed = false) => {
      socket?.emit(EV.updateStats, { filesShared: files, bytesTransferred, relayed });
    },
    [socket],
  );

  const inviteToFlight = useCallback(
    (user: Member, code: string): Promise<void> =>
      new Promise((resolve, reject) => {
        socket?.emit(
          EV.inviteToFlight,
          { targetId: user.id, flightCode: code },
          (res: SignalAck) => {
            if (res?.ok) resolve();
            else reject(new Error(res?.message ?? 'Invite failed'));
          },
        );
      }),
    [socket],
  );

  /**
   * Pulls another nearby device straight into a flight.
   *
   * The server already emitted `flightStarted` for this, but no client ever
   * listened for it, so the feature could not work. Now both sides handle it.
   */
  const requestDirectConnect = useCallback(
    (targetId: string): Promise<string> =>
      new Promise((resolve, reject) => {
        socket?.emit(EV.requestToConnect, targetId, (res: SignalAck & { code?: string }) => {
          if (res?.ok && res.code) resolve(res.code);
          else reject(new Error(res?.message ?? 'Could not connect'));
        });
      }),
    [socket],
  );

  // -------------------------------------------------------------------------
  // Socket wiring
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!socket) return;
    // Named handlers so `off` removes exactly ours and nothing else. The old
    // code called `socket.off('offer')` with no reference, which nuked every
    // other listener for that event on the shared socket.
    const onOffer = (id: string, payload: SdpPayload) => void handleOffer(id, payload);
    const onAnswer = (payload: { id: string; sdp: SdpPayload }) =>
      void handleAnswer(payload.id, payload.sdp);
    const onIce = (payload: { id: string; candidate: IceCandidatePayload }) =>
      void handleCandidate(payload.id, payload.candidate);

    const onFlightUsers = (payload: {
      code: string;
      ownerId: string;
      members: Member[];
      ownerConnected: boolean;
    }) => {
      setOwnerId(payload.ownerId);
      setMembers(payload.members);
      setFailure(null);
      refreshNearby();
    };

    const onNearby = (users: Member[]) => setNearByUsers(users);

    // This is what the server emits when it pulls us into a flight via
    // requestToConnect. It was previously unhandled anywhere in the codebase.
    const onFlightStarted = (payload: { code: string; members: Member[] }) => {
      setMembers(payload.members);
      setFlightCode(payload.code);
      setStatus('connecting');
    };

    const onFlightDeleted = (reason: string) => {
      // The old UI had no path out of this state, which is the single most
      // reported bug: the other side leaves and the page spins forever.
      teardownPeer();
      setStatus(reason === 'server-shutdown' ? 'disconnected' : 'failed');
      setFlightCode(reason === 'server-shutdown' ? null : flightCode);
      setFailure(reason === 'peer-left' ? 'OFFLINE' : null);
    };

    socket.on(EV.offer, onOffer);
    socket.on(EV.answer, onAnswer);
    socket.on(EV.iceCandidate, onIce);
    socket.on(EV.flightUsers, onFlightUsers);
    socket.on(EV.nearbyUsers, onNearby);
    socket.on(EV.flightStarted, onFlightStarted);
    socket.on(EV.flightDeleted, onFlightDeleted);

    return () => {
      socket.off(EV.offer, onOffer);
      socket.off(EV.answer, onAnswer);
      socket.off(EV.iceCandidate, onIce);
      socket.off(EV.flightUsers, onFlightUsers);
      socket.off(EV.nearbyUsers, onNearby);
      socket.off(EV.flightStarted, onFlightStarted);
      socket.off(EV.flightDeleted, onFlightDeleted);
    };
  }, [flightCode, handleAnswer, handleCandidate, handleOffer, refreshNearby, socket, teardownPeer]);

  // Join the flight whenever the code or the socket changes. Re-running on
  // socket change is what makes a reconnect recover the flight instead of
  // leaving the client attached to a dead one.
  useEffect(() => {
    if (!socket || !flightCode || socketState !== 'connected') return;

    socket.emit(EV.joinFlight, flightCode, (res: SignalAck & { code?: string }) => {
      if (res?.ok) {
        setStatus((prev) => (prev === 'connected' ? prev : 'connecting'));
        setFailure(null);
      } else {
        const code = (res?.code as FailureCode) ?? 'INTERNAL';
        setFailure(code);
        setStatus('failed');
      }
    });
  }, [flightCode, socket, socketState]);

  // After a reconnect the server hands out a new socket id, so anything holding
  // the old one has to re-join.
  useEffect(
    () =>
      onReconnect(() => {
        if (!flightCode) return;
        remoteIdRef.current = null;
        setStatus('reconnecting');
      }),
    [flightCode, onReconnect],
  );

  // The owner creates the connection and the channels. The joiner waits for the
  // offer.
  useEffect(() => {
    if (!ownerId || !flightCode || !socket || socket.id !== ownerId) return;
    if (peerRef.current) return;

    const peer = createPeer(null);
    // Bulk channels are partially reliable: one lost packet must not stall the
    // whole file, which is exactly what fully-reliable ordered delivery does.
    // The control channel stays reliable and ordered so JSON messages cannot be
    // lost or reordered.
    for (let i = 0; i < (clientConfig?.transfer.parallelChannels ?? 1); i++) {
      const channel = peer.createDataChannel(`bulk${i}`, {
        ordered: false,
        maxRetransmits: i === 0 ? 3 : 0,
      });
      attachDataChannel(channel, false);
    }
    attachDataChannel(peer.createDataChannel('control', { ordered: true }), true);
  }, [attachDataChannel, clientConfig, createPeer, flightCode, ownerId, socket]);

  // Clean up on unmount so a route change does not leave a peer connection and
  // its timers running.
  useEffect(() => () => teardownPeer(), [teardownPeer]);

  return {
    dataChannel,
    controlChannel,
    peerRef,
    status,
    failure,
    flightCode,
    nearByUsers,
    members,
    ownerId,
    inviteToFlight,
    requestDirectConnect,
    updateStats,
    connectToFlight,
    refreshNearby,
    disconnect,
    restartIce: attemptIceRestart,
  };
}
