'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSocket } from '@/context/socketContext';

type Result = { mb: number; seconds: number; mbps: number } | null;

const ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

export default function BenchPage() {
  const { socket } = useSocket();
  const [code, setCode] = useState('');
  const [status, setStatus] = useState('Ready');
  const [result, setResult] = useState<Result>(null);
  const [chunkKB, setChunkKB] = useState(64);
  const [bufferMB, setBufferMB] = useState(2);
  const [totalMB, setTotalMB] = useState(256);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const roomRef = useRef('');
  const remoteIdRef = useRef('');
  // Separate queues — mixing these was causing the 1-minute delay
  const pendingOut = useRef<RTCIceCandidateInit[]>([]); // host's own candidates before remote id is known
  const pendingIn = useRef<RTCIceCandidateInit[]>([]); // remote's candidates before remote desc is set

  const removeListeners = useCallback(() => {
    socket?.off('flightUsers');
    socket?.off('offer');
    socket?.off('answer');
    socket?.off('ice-candidate');
  }, [socket]);

  const cleanup = useCallback(() => {
    removeListeners();
    pcRef.current?.close();
    pcRef.current = null;
    dcRef.current = null;
    pendingOut.current = [];
    pendingIn.current = [];
    remoteIdRef.current = '';
  }, [removeListeners]);

  useEffect(() => () => cleanup(), [cleanup]);

  // ─── Host ────────────────────────────────────────────────────────────────
  const host = useCallback(() => {
    if (!socket) return;
    cleanup();
    setResult(null);
    setStatus('Creating room…');

    socket.emit('createFlight', (resp: { code: string }) => {
      const room = resp.code;
      setCode(room);
      socket.emit('joinFlight', room, () => {
        roomRef.current = room;
        setStatus('Waiting for other tab to join…');
      });
    });

    socket.on('flightUsers', async ({ ownerId }: { ownerId: string }) => {
      if (socket.id !== ownerId || pcRef.current) return;
      setStatus('Connecting…');

      const pc = new RTCPeerConnection({ iceServers: ICE });
      pcRef.current = pc;

      // Buffer own ICE candidates until the answer arrives with the remote socket id
      pc.onicecandidate = ({ candidate }) => {
        if (!candidate) return;
        if (remoteIdRef.current) {
          socket.emit('ice-candidate', { id: remoteIdRef.current, candidate });
        } else {
          pendingOut.current.push(candidate);
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') setStatus('Connected — press Run to start');
        if (pc.connectionState === 'failed') setStatus('Connection failed — reload and try again');
        if (pc.connectionState === 'disconnected') setStatus('Disconnected');
      };

      const dc = pc.createDataChannel('bench');
      dc.binaryType = 'arraybuffer';
      dcRef.current = dc;

      // Incoming candidates from joiner — buffer until remote desc is set
      socket.on('ice-candidate', async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
        if (pc.remoteDescription) await pc.addIceCandidate(candidate);
        else pendingIn.current.push(candidate);
      });

      socket.once('answer', async ({ sdp, id }: { sdp: RTCSessionDescriptionInit; id: string }) => {
        remoteIdRef.current = id;
        await pc.setRemoteDescription(sdp);
        // Flush buffered incoming (joiner → host)
        for (const c of pendingIn.current) await pc.addIceCandidate(c);
        pendingIn.current = [];
        // Flush buffered outgoing (host → joiner)
        for (const c of pendingOut.current) socket.emit('ice-candidate', { id, candidate: c });
        pendingOut.current = [];
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', roomRef.current, { sdp: pc.localDescription });
    });
  }, [socket, cleanup]);

  // ─── Join ─────────────────────────────────────────────────────────────────
  const join = useCallback(() => {
    if (!socket || !code) return;
    cleanup();
    setResult(null);
    setStatus('Joining…');

    socket.emit('joinFlight', code, (resp: { success: boolean; message?: string }) => {
      if (!resp.success) {
        setStatus(`Could not join: ${resp.message}`);
        return;
      }
      setStatus('Waiting for host…');
    });

    socket.once('offer', async (id: string, { sdp }: { sdp: any }) => {
      const desc = sdp?.sdp ?? sdp;
      if (!desc) {
        setStatus('Offer not ready — retrying…');
        setTimeout(() => socket.emit('joinFlight', code, () => {}), 1500);
        return;
      }
      setStatus('Connecting…');
      remoteIdRef.current = id;

      const pc = new RTCPeerConnection({ iceServers: ICE });
      pcRef.current = pc;

      // Joiner's own ICE candidates — remote id known immediately from offer
      pc.onicecandidate = ({ candidate }) => {
        if (candidate) socket.emit('ice-candidate', { id, candidate });
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') setStatus('Connected — waiting for host to run');
        if (pc.connectionState === 'failed') setStatus('Connection failed — reload and try again');
        if (pc.connectionState === 'disconnected') setStatus('Disconnected');
      };

      pc.ondatachannel = ({ channel }) => {
        dcRef.current = channel;
        channel.binaryType = 'arraybuffer';
        let received = 0;
        let started = 0;
        channel.onmessage = ({ data }) => {
          if (typeof data === 'string') {
            if (data === 'start') {
              started = performance.now();
              setStatus('Receiving…');
            }
            return;
          }
          received += (data as ArrayBuffer).byteLength;
        };
        channel.onclose = () => {
          const sec = (performance.now() - (started || performance.now())) / 1000;
          const mb = received / (1024 * 1024);
          setResult({ mb, seconds: sec, mbps: mb / sec });
          setStatus('Done');
        };
      };

      // Incoming host candidates — buffer until remote desc is set
      socket.on('ice-candidate', async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
        if (pc.remoteDescription) await pc.addIceCandidate(candidate);
        else pendingIn.current.push(candidate);
      });

      await pc.setRemoteDescription(desc);
      // Flush any candidates that raced ahead of setRemoteDescription
      for (const c of pendingIn.current) await pc.addIceCandidate(c);
      pendingIn.current = [];

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      // Send answer immediately — trickle ICE handles the rest
      socket.emit('answer', code, { sdp: answer, id });
    });
  }, [socket, code, cleanup]);

  // ─── Run ──────────────────────────────────────────────────────────────────
  const run = useCallback(() => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') {
      setStatus('Not connected yet — wait for "Connected" status');
      return;
    }
    const chunkSize = chunkKB * 1024;
    const highWater = bufferMB * 1024 * 1024;
    const totalBytes = totalMB * 1024 * 1024;
    const buf = new Uint8Array(chunkSize);
    let sent = 0;
    let paused = false;

    dc.bufferedAmountLowThreshold = highWater / 2;
    dc.onbufferedamountlow = () => {
      if (paused) {
        paused = false;
        pump();
      }
    };

    setResult(null);
    setStatus(`Sending ${totalMB} MB…`);
    dc.send('start');

    function pump() {
      while (sent < totalBytes) {
        if (dc!.bufferedAmount > highWater) {
          paused = true;
          return;
        }
        dc!.send(buf);
        sent += chunkSize;
      }
      dc!.close();
    }
    pump();
  }, [chunkKB, bufferMB, totalMB]);

  if (process.env.NODE_ENV !== 'development') return null;

  return (
    <main className="mx-auto max-w-xl space-y-5 p-8 font-mono text-sm">
      <h1 className="text-xl font-bold">Transfer Benchmark</h1>
      <p className="text-gray-500">Tab A: Host → Tab B: paste code → Join → Host clicks Run.</p>

      {/* Controls */}
      <div className="flex flex-wrap gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="room code"
          className="rounded border px-2 py-1 w-32"
        />
        <button onClick={host} className="rounded bg-black px-3 py-1 text-white">
          Host
        </button>
        <button onClick={join} className="rounded bg-black px-3 py-1 text-white">
          Join
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label>
          chunk KB{' '}
          <input
            type="number"
            value={chunkKB}
            onChange={(e) => setChunkKB(+e.target.value)}
            className="w-20 rounded border px-1"
          />
        </label>
        <label>
          buffer MB{' '}
          <input
            type="number"
            value={bufferMB}
            onChange={(e) => setBufferMB(+e.target.value)}
            className="w-20 rounded border px-1"
          />
        </label>
        <label>
          total MB{' '}
          <input
            type="number"
            value={totalMB}
            onChange={(e) => setTotalMB(+e.target.value)}
            className="w-20 rounded border px-1"
          />
        </label>
        <button onClick={run} className="rounded bg-green-600 px-3 py-1 text-white">
          Run
        </button>
      </div>

      {/* Status + Result */}
      <div className="rounded border p-4 space-y-2">
        <p className="text-gray-700">{status}</p>
        {result && (
          <p className="text-2xl font-bold">
            {result.mbps.toFixed(1)} <span className="text-base font-normal">MB/s</span>
            <span className="ml-3 text-sm font-normal text-gray-500">
              {result.mb.toFixed(0)} MB in {result.seconds.toFixed(2)}s
            </span>
          </p>
        )}
      </div>
    </main>
  );
}
