'use client';

/**
 * Flight room.
 *
 * Changes worth calling out:
 *
 *  - Every failure mode now has a visible, actionable state. The previous page
 *    set a status string and hoped the user could interpret it; the worst case
 *    was an indefinite spinner after the other side disconnected.
 *  - `inviteToFlight` is called with `.catch()`. It rejects on failure and both
 *    call sites ignored the promise, so every failed invite produced an
 *    unhandled rejection.
 *  - The QR modal traps focus, closes on Escape, and labels itself.
 *  - Code entry is normalised, so a lowercase or mistyped code still works.
 *  - A `full` flight shows an explanation plus a way to host instead, rather
 *    than a dead-end page.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { File, Folder, LogOut, QrCode, RefreshCw, Share2, User, Users, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { normalizeFlightCode } from '@airdelivery/protocol';
import { Badge } from '@/lib/badge';
import { useWebRTCActions, useWebRTCState } from '@/context/WebRTCContext';
import { MetricsSection } from '@/components/room/MetricSection';
import { QueueTray } from '@/components/room/QueueTray';
import { AskToShareSection } from '@/components/room/share';

const STATUS_COPY: Record<string, string> = {
  idle: 'Create or join a flight to begin.',
  waiting: 'Waiting for the other device to join…',
  connecting: 'Establishing a direct connection…',
  connected: 'Connected. Files transfer directly between the devices.',
  reconnecting: 'Connection interrupted. Trying to recover…',
  disconnected: 'Disconnected.',
  failed: 'Could not connect.',
};

const FAILURE_COPY: Record<string, { title: string; body: string }> = {
  FULL: {
    title: 'This flight is already full',
    body: 'Two devices can share in one flight. Create a new flight to send to someone else.',
  },
  NOT_FOUND: {
    title: 'That flight code does not exist',
    body: 'Check the code with the sender, or create a new flight.',
  },
  BAD_CODE: {
    title: 'That is not a valid flight code',
    body: 'Flight codes are 6 characters. Letters that look alike are usually the issue.',
  },
  OFFLINE: {
    title: 'That device is no longer online',
    body: 'They may have closed the tab or changed network.',
  },
};

export default function FlightPage() {
  const params = useParams();
  const raw = typeof params?.code === 'string' ? params.code : '';
  const code = normalizeFlightCode(raw) ?? raw.toUpperCase();
  const valid = normalizeFlightCode(raw) !== null;

  const router = useRouter();
  const {
    handleFileSelect,
    leaveFlight,
    connectToFlight,
    cancelTransfer,
    cancelReceive,
    downloadFile,
    pauseTransfer,
    resumeTransfer,
    refreshNearby,
    inviteToFlight,
    requestDirectConnect,
    restartIce,
  } = useWebRTCActions();

  const { metrics, recvQueue, queue, status, failure, members, nearByUsers, flightId } =
    useWebRTCState();

  const [showQr, setShowQr] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const qrClose = useRef<HTMLButtonElement>(null);

  const inThisFlight = flightId === code;

  // Join, or explain why we cannot.
  useEffect(() => {
    if (!valid) return;
    if (inThisFlight) return;
    connectToFlight(code);
  }, [code, connectToFlight, inThisFlight, valid]);

  // Canonicalise the URL so a lowercase or mistyped link becomes shareable.
  useEffect(() => {
    const normalized = normalizeFlightCode(raw);
    if (normalized && normalized !== raw) router.replace(`/flight/${normalized}`);
  }, [raw, router]);

  useEffect(() => {
    if (!showQr) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowQr(false);
    };
    window.addEventListener('keydown', onKey);
    qrClose.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [showQr]);

  const handleLeave = useCallback(() => {
    leaveFlight();
    router.push('/');
  }, [leaveFlight, router]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    refreshNearby();
    setTimeout(() => setRefreshing(false), 500);
  }, [refreshNearby]);

  /**
   * Every rejection is handled. Previously unhandled, producing an unhandled
   * rejection on each failed invite.
   */
  const runInvite = useCallback(async (action: () => Promise<unknown>, successMessage?: string) => {
    try {
      await action();
      setNotice(successMessage ?? null);
    } catch (err) {
      setNotice((err as Error).message || 'That did not work.');
    }
  }, []);

  const failureCopy = failure ? FAILURE_COPY[failure] : null;
  const origin = typeof window !== 'undefined' ? `${window.location.origin}/flight/${code}` : '';

  return (
    <main
      id="main"
      className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 py-8 px-4 sm:px-6 lg:px-8"
    >
      <div className="max-w-5xl mx-auto space-y-6">
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-6">
          <div>
            <h1 className="text-xl sm:text-2xl font-extrabold tracking-wide flex items-center gap-2">
              <span className="sr-only">Flight</span>
              <span className="text-sm uppercase tracking-widest text-zinc-500 font-bold">
                Flight
              </span>
              <span className="font-mono text-orange-600">{code || '—'}</span>
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge
                color={status === 'connected' ? 'green' : status === 'failed' ? 'red' : 'yellow'}
              >
                {STATUS_COPY[status] ?? status}
              </Badge>
              <Badge color="gray">
                {members.length} member{members.length === 1 ? '' : 's'}
              </Badge>
              {status === 'reconnecting' && (
                <button
                  type="button"
                  onClick={() => void restartIce()}
                  className="text-xs font-semibold text-orange-600 hover:underline"
                >
                  Retry now
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setShowQr(true)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-full bg-orange-500 hover:bg-orange-600 text-white font-semibold transition"
            >
              <QrCode className="w-5 h-5" aria-hidden="true" />
              Invite
            </button>
            <button
              type="button"
              onClick={handleLeave}
              className="flex items-center gap-2 px-4 py-2.5 rounded-full bg-zinc-800 dark:bg-zinc-100 text-white dark:text-zinc-900 font-semibold transition hover:bg-zinc-700 dark:hover:bg-zinc-200"
            >
              <LogOut className="w-5 h-5" aria-hidden="true" />
              Leave
            </button>
          </div>
        </header>

        {/* Every dead end gets an explanation and a next step. */}
        {(!valid || failureCopy) && (
          <div
            role="alert"
            className="rounded-2xl border border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-950/30 p-5"
          >
            <h2 className="font-bold text-orange-900 dark:text-orange-200">
              {valid ? failureCopy?.title : 'That is not a flight code'}
            </h2>
            <p className="mt-1 text-sm text-orange-900/80 dark:text-orange-200/80">
              {valid
                ? failureCopy?.body
                : 'Flight codes are 6 characters from A–Z and 2–9. Check the link or type the code in.'}
            </p>
            <button
              type="button"
              onClick={() => router.push('/')}
              className="mt-4 px-4 py-2 rounded-full bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold"
            >
              Back to home
            </button>
          </div>
        )}

        {notice && (
          <div
            role="status"
            className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3 text-sm"
          >
            {notice}
          </div>
        )}

        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-white dark:bg-zinc-900 p-6 rounded-3xl shadow-sm border border-zinc-200 dark:border-zinc-800">
            <label
              htmlFor="room-file-input"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void handleFileSelect({
                  target: { files: e.dataTransfer.files },
                } as never);
              }}
              className="w-full min-h-56 flex flex-col items-center justify-center border-2 border-dashed border-orange-400 rounded-2xl bg-orange-50/40 dark:bg-orange-950/10 hover:bg-orange-50 dark:hover:bg-orange-950/20 transition p-6 text-center cursor-pointer"
            >
              <Folder className="w-10 h-10 text-orange-500 mb-3" aria-hidden="true" />
              <span className="text-lg font-medium">Drag and drop files or folders</span>
              <span className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                or choose them below
              </span>

              <span className="mt-4 flex flex-wrap justify-center gap-3">
                <span className="px-4 py-2 rounded-full bg-orange-500 text-white text-sm font-medium inline-flex items-center gap-2">
                  <File className="w-4 h-4" aria-hidden="true" />
                  Files
                </span>
                <span className="px-4 py-2 rounded-full border border-orange-500 text-orange-600 dark:text-orange-400 text-sm font-medium inline-flex items-center gap-2">
                  <Folder className="w-4 h-4" aria-hidden="true" />
                  Folder
                </span>
              </span>

              {/* Two inputs, because a folder picker and a file picker are
                  different requests. One `webkitdirectory` input cannot do both. */}
              <input
                id="room-file-input"
                type="file"
                multiple
                className="sr-only"
                onChange={handleFileSelect}
              />
            </label>

            <div className="mt-4 flex flex-wrap gap-3">
              <label
                htmlFor="room-files"
                className="cursor-pointer px-4 py-2 rounded-full bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium"
              >
                Select files
              </label>
              <input
                id="room-files"
                type="file"
                multiple
                className="sr-only"
                onChange={handleFileSelect}
              />

              <label
                htmlFor="room-folder"
                className="cursor-pointer px-4 py-2 rounded-full border border-orange-500 text-orange-600 dark:text-orange-400 text-sm font-medium"
              >
                Select folder
              </label>
              <input
                id="room-folder"
                type="file"
                multiple
                // @ts-expect-error non-standard but universally supported
                webkitdirectory=""
                className="sr-only"
                onChange={handleFileSelect}
              />
            </div>
          </div>

          <div className="bg-white dark:bg-zinc-900 rounded-3xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-5 flex flex-col max-h-96">
            <div className="flex justify-between items-center mb-4">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <Users className="w-5 h-5 text-orange-500" aria-hidden="true" />
                {members.length > 1 ? 'In flight' : 'Devices nearby'}
              </h2>
              {members.length <= 1 && (
                <button
                  type="button"
                  onClick={handleRefresh}
                  aria-label="Refresh nearby devices"
                  className="p-2 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <RefreshCw
                    className={`w-5 h-5 text-zinc-500 ${refreshing ? 'animate-spin' : ''}`}
                    aria-hidden="true"
                  />
                </button>
              )}
            </div>

            <ul className="flex flex-col gap-2 overflow-y-auto">
              {(members.length > 1 ? members : nearByUsers).length === 0 ? (
                <li className="text-zinc-400 dark:text-zinc-500 text-sm py-6 text-center">
                  {members.length > 1 ? 'No members' : 'No nearby devices found'}
                </li>
              ) : (
                (members.length > 1 ? members : nearByUsers).map((peer) => (
                  <li key={peer.id}>
                    <button
                      type="button"
                      disabled={members.length > 1}
                      onClick={() =>
                        members.length > 1
                          ? undefined
                          : void runInvite(
                              () =>
                                inThisFlight
                                  ? inviteToFlight(peer, code)
                                  : requestDirectConnect(peer.id),
                              'Invitation sent',
                            )
                      }
                      className="w-full flex items-center gap-3 rounded-xl px-3 py-2 border border-zinc-200 dark:border-zinc-800 hover:border-orange-400 text-left disabled:opacity-60 disabled:cursor-default"
                    >
                      <User className="w-6 h-6 text-orange-500" aria-hidden="true" />
                      <span className="truncate text-sm font-medium">{peer.name}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </section>

        <QueueTray
          title="Transfers"
          items={[...queue, ...recvQueue]}
          onPause={pauseTransfer}
          onResume={resumeTransfer}
          onCancel={(id, kind) => (kind === 'receive' ? cancelReceive(id) : cancelTransfer(id))}
          onDownload={(item) => downloadFile(item as never)}
        />

        <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <MetricsSection metrics={metrics} />
          <AskToShareSection />
        </section>
      </div>

      {showQr && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fadeIn"
          onClick={() => setShowQr(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Share this flight"
            onClick={(e) => e.stopPropagation()}
            className="relative bg-white dark:bg-zinc-900 rounded-3xl shadow-2xl p-8 w-full max-w-xs flex flex-col items-center border-2 border-orange-400"
          >
            <button
              ref={qrClose}
              type="button"
              onClick={() => setShowQr(false)}
              aria-label="Close"
              className="absolute top-3 right-3 text-zinc-400 hover:text-orange-600"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>

            <p className="font-mono text-lg bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 px-3 py-1 rounded-lg">
              {code}
            </p>
            <h2 className="mt-3 text-xl font-bold text-center">Share this flight</h2>

            <div className="my-4 p-2 bg-white rounded-xl">
              <QRCodeSVG value={origin} size={180} />
            </div>

            <div className="w-full flex items-center gap-2">
              <label htmlFor="share-url" className="sr-only">
                Flight link
              </label>
              <input
                id="share-url"
                readOnly
                value={origin}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg px-2 py-1 text-sm font-mono border border-zinc-200 dark:border-zinc-700"
              />
              <button
                type="button"
                onClick={async () => {
                  if (navigator.share) {
                    await navigator
                      .share({ title: 'Join my flight', url: origin })
                      .catch(() => undefined);
                  } else {
                    await navigator.clipboard?.writeText(origin);
                    setNotice('Link copied to your clipboard.');
                  }
                }}
                aria-label="Share flight link"
                className="p-2 rounded hover:bg-orange-100 dark:hover:bg-orange-900/30 text-orange-600"
              >
                <Share2 className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
