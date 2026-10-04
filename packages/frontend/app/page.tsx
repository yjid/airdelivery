'use client';

/**
 * Home page.
 *
 * THE PRIMARY SEND FLOW WAS DEAD. The ticket card wrapped a `<button>` with
 * `className="hidden"` inside a `<label>`. A `<button>` is not a labelable
 * element, so the label had no control to activate, and the button was
 * `display:none` so it could not be clicked either. There was no file input on
 * this page at all. "Tap to start sending" did nothing, on every device.
 *
 * That is the first thing a new user tries. It is now a real file input plus a
 * real drop zone, and the page works without JavaScript for the file selection
 * itself.
 */

import { useCallback, useEffect, useState, type ChangeEvent, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, FileUp, Info, QrCode, Users } from 'lucide-react';
import { useSocket } from '@/context/socketContext';
import { useWebRTCActions, useWebRTCState } from '@/context/WebRTCContext';
import { normalizeFlightCode } from '@airdelivery/protocol';
import InfoSection from '@/components/InfoSection';
import { TermsModal } from '@/components/terms';
import AboutCard from '@/components/aboutCard';
import { InvitationToJoin } from '@/components/invitationToJoin';

const TERMS_KEY = 'airdelivery:terms-accepted';

export default function HomePage() {
  const router = useRouter();
  const { socket, user, state, turnNotice } = useSocket();
  const { flightId, status, nearByUsers, metrics } = useWebRTCState();
  const { handleFileSelect, connectToFlight, inviteToFlight, requestDirectConnect, refreshNearby } =
    useWebRTCActions();

  const [typed, setTyped] = useState<string | null>(null);
  const [showTerms, setShowTerms] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  // Derived, not synchronised. An effect that pushed `flightId` into state on
  // every change was an extra render pass and could briefly show the previous
  // flight's code.
  const codeInput = typed ?? flightId ?? '';

  // Discovery polls while the page is open. Paused when the tab is hidden: a
  // background tab polling every 5s is pure waste and, on a phone, pure battery.
  useEffect(() => {
    if (!socket) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      refreshNearby();
      timer = setInterval(refreshNearby, 5_000);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [socket, refreshNearby]);

  const requireTerms = useCallback((): boolean => {
    if (localStorage.getItem(TERMS_KEY)) return true;
    setShowTerms(true);
    return false;
  }, []);

  const createFlight = useCallback((): Promise<string | null> => {
    if (!requireTerms()) return Promise.resolve(null);
    return new Promise((resolve) => {
      if (!socket) {
        setInviteError('Not connected to the signaling server yet.');
        return resolve(null);
      }
      socket.emit('createFlight', (res: { ok: boolean; code?: string; message?: string }) => {
        if (res?.ok && res.code) resolve(res.code);
        else {
          setInviteError(res?.message ?? 'Could not create a flight.');
          resolve(null);
        }
      });
    });
  }, [requireTerms, socket]);

  const handleCreateAndSend = useCallback(async () => {
    const code = await createFlight();
    if (!code) return;
    connectToFlight(code);
    router.push(`/flight/${code}`);
  }, [connectToFlight, createFlight, router]);

  const handleJoin = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const code = normalizeFlightCode(codeInput);
      if (!code) {
        setInviteError('That does not look like a valid flight code. It is 6 characters.');
        return;
      }
      setInviteError(null);
      connectToFlight(code);
      router.push(`/flight/${code}`);
    },
    [codeInput, connectToFlight, router],
  );

  /**
   * Reuses the current flight when there is one, otherwise creates one.
   *
   * Invites previously called `inviteToFlight` without a `.catch()`, and that
   * function rejects on failure, so every failed invite produced an unhandled
   * promise rejection.
   */
  const inviteOrConnect = useCallback(
    async (peer: { id: string; name: string }) => {
      const code = flightId || (await createFlight());
      if (!code) return;
      if (!flightId) connectToFlight(code);
      router.push(`/flight/${code}`);

      try {
        if (flightId && flightId === code) {
          await inviteToFlight(peer, code);
        } else {
          await requestDirectConnect(peer.id);
        }
        setInviteError(null);
      } catch (err) {
        setInviteError((err as Error).message || 'Could not reach that device.');
      }
    },
    [connectToFlight, createFlight, flightId, inviteToFlight, requestDirectConnect, router],
  );

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      setDragOver(false);
      const code = flightId;
      if (!code) {
        setInviteError('Create or join a flight before dropping files.');
        return;
      }
      void handleFileSelect({
        target: { files: event.dataTransfer.files },
      } as ChangeEvent<HTMLInputElement>);
    },
    [flightId, handleFileSelect],
  );

  return (
    <>
      <main
        id="main"
        className="relative flex flex-col lg:flex-row items-center justify-center gap-10 max-w-6xl mx-auto px-4 py-10 min-h-[calc(100vh-4rem)]"
      >
        <InvitationToJoin />

        {turnNotice && (
          <div
            role="status"
            className="w-full max-w-3xl rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm text-amber-900 dark:text-amber-200"
          >
            <strong className="font-semibold">Heads up:</strong> {turnNotice}
          </div>
        )}

        <section className="w-full lg:w-auto">
          <h1 className="sr-only">Send files peer to peer</h1>
          <p className="text-4xl sm:text-5xl font-extrabold tracking-tight text-zinc-900 dark:text-zinc-100">
            SHARE FILES.
            <br />
            <span className="text-orange-500">INSTANTLY.</span>
          </p>
          <p className="mt-3 text-base text-zinc-600 dark:text-zinc-400 max-w-md">
            Peer to peer over WebRTC. No uploads, no sign-up, no size limits. Your files never touch
            a server.
          </p>

          <dl className="mt-6 grid grid-cols-2 gap-3 max-w-md">
            <Stat label="Sent" value={metrics.totalSent} />
            <Stat label="Received" value={metrics.totalReceived} />
          </dl>
        </section>

        <section aria-labelledby="transfer-ticket" className="w-full max-w-md">
          <h2 id="transfer-ticket" className="sr-only">
            Start or join a transfer
          </h2>

          <div className="rounded-3xl bg-orange-600 text-zinc-900 shadow-2xl p-6">
            <div className="flex items-center justify-between mb-5">
              <div>
                <span className="uppercase tracking-widest text-xs font-bold text-zinc-100 opacity-70">
                  airdelivery.site
                </span>
                <p className="text-2xl font-extrabold text-zinc-50">{user.name ?? 'Connecting'}</p>
              </div>
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  state === 'connected'
                    ? 'bg-green-500/20 text-green-50'
                    : 'bg-black/20 text-zinc-100'
                }`}
              >
                {state}
              </span>
            </div>

            {/* A real file input. This is the control that was missing entirely. */}
            <label
              htmlFor="home-file-input"
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={`flex flex-col items-center justify-center gap-2 rounded-2xl px-6 py-8 text-center cursor-pointer transition ${
                dragOver ? 'bg-orange-300' : 'bg-orange-50 hover:bg-orange-100'
              }`}
            >
              <FileUp className="w-8 h-8 text-orange-700" aria-hidden="true" />
              <span className="font-semibold text-orange-900">
                {flightId ? 'Add more files' : 'Tap to choose files'}
              </span>
              <span className="text-xs text-orange-800">
                or drop files here, including whole folders
              </span>
              <input
                id="home-file-input"
                type="file"
                multiple
                // @ts-expect-error non-standard but universally supported
                webkitdirectory=""
                className="sr-only"
                onChange={handleFileSelect}
              />
            </label>

            <div className="flex items-center gap-3 my-5">
              <div className="h-px flex-1 bg-zinc-100/40" />
              <span className="text-xs font-semibold uppercase tracking-widest text-zinc-100 opacity-80">
                or
              </span>
              <div className="h-px flex-1 bg-zinc-100/40" />
            </div>

            <button
              type="button"
              onClick={() => void handleCreateAndSend()}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-zinc-900 px-5 py-3 font-semibold text-white transition hover:bg-zinc-800"
            >
              <QrCode className="w-5 h-5" aria-hidden="true" />
              Create a flight to send
            </button>

            <form onSubmit={handleJoin} className="mt-4">
              <label
                htmlFor="flight-code"
                className="block text-xs font-semibold uppercase tracking-widest text-zinc-100 opacity-80 mb-2"
              >
                Enter a flight code to receive
              </label>
              <div className="flex gap-2">
                <input
                  id="flight-code"
                  value={codeInput}
                  onChange={(e) => setTyped(e.target.value.toUpperCase())}
                  placeholder="ABC234"
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="text"
                  maxLength={12}
                  className="flex-1 rounded-2xl border-0 bg-zinc-50 px-4 py-3 font-mono uppercase text-zinc-900 outline-none focus:ring-2 focus:ring-orange-300"
                />
                <button
                  type="submit"
                  aria-label="Join flight"
                  className="rounded-2xl bg-zinc-900 px-4 py-3 text-white transition hover:bg-zinc-800"
                >
                  <ArrowRight className="w-5 h-5" aria-hidden="true" />
                </button>
              </div>
            </form>

            {flightId && (
              <p className="mt-4 text-sm text-zinc-50">
                In flight <span className="font-mono font-bold">{flightId}</span> · {status}
              </p>
            )}

            {inviteError && (
              <p
                role="alert"
                className="mt-3 text-sm font-medium text-red-50 bg-red-500/20 rounded-xl px-3 py-2"
              >
                {inviteError}
              </p>
            )}
          </div>

          {/* Nearby devices. Previously drag-and-drop only, which is unusable on
              a phone — the single most likely way to start a transfer with a
              laptop. Every entry is now also a button. */}
          {nearByUsers.length > 0 && (
            <div className="mt-6">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-3">
                <Users className="w-4 h-4" aria-hidden="true" />
                Devices on your network
              </h3>
              <ul className="grid grid-cols-2 gap-2">
                {nearByUsers.map((peer) => (
                  <li key={peer.id}>
                    <button
                      type="button"
                      onClick={() => void inviteOrConnect(peer)}
                      className="w-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2 text-left text-sm font-medium text-zinc-800 dark:text-zinc-200 transition hover:border-orange-400"
                    >
                      {peer.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-6 rounded-2xl bg-zinc-900 text-zinc-200 p-5">
            <h3 className="flex items-center gap-2 text-lg font-bold text-white">
              <Info className="w-5 h-5" aria-hidden="true" />
              About
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">
              AirDelivery sends files directly between two browsers. The server only introduces the
              two devices to each other; the file data never reaches it.
            </p>
            <div className="mt-4">
              <AboutCard />
            </div>
          </div>
        </section>
      </main>

      <InfoSection />

      <TermsModal
        show={showTerms}
        onClose={() => setShowTerms(false)}
        onAccept={() => {
          localStorage.setItem(TERMS_KEY, 'true');
          setShowTerms(false);
        }}
      />
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  const mb = value / (1024 * 1024);
  return (
    <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3">
      <dt className="text-[10px] uppercase tracking-wider font-bold text-zinc-500">{label}</dt>
      <dd className="text-lg font-black tabular-nums text-zinc-900 dark:text-zinc-100">
        {mb < 0.01 ? `${Math.round(value / 1024)} KB` : `${mb.toFixed(2)} MB`}
      </dd>
    </div>
  );
}
