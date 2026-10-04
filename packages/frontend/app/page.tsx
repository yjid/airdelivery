'use client';

import React, { ChangeEvent, useEffect, useState } from 'react';
import { useSocket } from '@/context/socketContext';
import { useRouter } from 'next/navigation';
import AboutCard from '@/components/aboutCard';
import { useInvitationToJoin } from '@/components/invitationToJoin';
import { useWebRTCState, useWebRTCActions } from '@/context/WebRTCContext';
import InfoSection from '@/components/InfoSection';
import TermsModal from '@/components/terms';

export default function MainPage() {
  const router = useRouter();
  const { socket, user } = useSocket();

  // Local form state for entering / showing flight code
  const [flightCode, setFlightCode] = useState<string>('');

  // Modal for showing terms
  const [showTerms, setShowTerms] = useState(false);

  // Drag-over visual state for nearby user tiles
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // --- WebRTC / app context ------------------------------------------------
  const { flightId, status, nearByUsers } = useWebRTCState();

  const { handleFileSelect, connectToFlight, inviteToFlight, leaveFlight, refreshNearby } =
    useWebRTCActions();

  // Keep local flightCode in sync with any existing flightId from context
  useEffect(() => {
    if (flightId) {
      setFlightCode(flightId);
    }
  }, [flightId]);

  // --- Create / Join handlers ----------------------------------------------
  const handleCreate = async () => {
    // Ensure user accepted terms before creating a flight
    const accepted = localStorage.getItem('acceptedTerms');
    if (!accepted) {
      setShowTerms(true);
      return;
    }

    if (!socket) return;

    if (flightId) {
      // If already in a flight, open it
      router.push(`/flight/${flightId}`);
    } else {
      // Ask server to create a new flight and navigate to it
      socket.emit('createFlight', (response: { code: string }) => {
        router.push(`/flight/${response.code}`);
      });
    }
  };

  const handleJoin = () => {
    if (flightCode.trim()) {
      router.push(`/flight/${flightCode.trim()}`);
    }
  };

  // Periodically refresh nearby users. Trigger a refresh on mount and every 5s
  useEffect(() => {
    refreshNearby();

    const interval = setInterval(() => {
      refreshNearby();
    }, 5000);

    return () => clearInterval(interval);
  }, [socket]);

  const handleLeaveFlight = () => {
    leaveFlight();
  };

  const handleAccept = () => {
    localStorage.setItem('acceptedTerms', 'true');
  };

  const invitationPop = useInvitationToJoin();

  // --- Render ---------------------------------------------------------------
  return (
    <>
      {/* Background */}
      <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
        {/* Soft glows */}
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-orange-500/10 dark:bg-orange-600/5 blur-[120px] rounded-full animate-pulse" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-500/10 dark:bg-blue-600/5 blur-[120px] rounded-full animate-pulse [animation-delay:2s]" />
        <div className="absolute inset-0 bg-gradient-to-tr from-white via-transparent to-white dark:from-zinc-950 dark:via-transparent dark:to-zinc-950 opacity-60" />
      </div>

      {/* Main content */}
      <main className="relative flex mb-10 flex-col md:flex-row items-center max-w-9xl mx-auto justify-around min-h-[calc(100vh-64px)] overflow-hidden">
        {invitationPop}

        {/* Flight shortcut bar shown when inside a flight */}
        {flightId && (
          <div className="fixed top-8 left-1/2 transform -translate-x-1/2 z-50 w-full max-w-sm px-4">
            <div className="flex animate-fadeIn items-center justify-between px-6 py-3 backdrop-blur-lg bg-white/30 border border-white/20 rounded-full shadow-[0_8px_32px_rgba(31,38,135,0.2)] transition-all duration-300 hover:shadow-[0_12px_48px_rgba(31,38,135,0.3)] text-sm text-zinc-800 space-x-4">
              {/* Flight info */}
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-semibold truncate text-black/90">
                  Flight: <code className="text-orange-500 font-mono">{flightId}</code>
                </div>
                <div className="text-[12px] font-medium mt-0.5">
                  <span
                    className={`${
                      status.includes('Connection')
                        ? 'text-green-600'
                        : status.includes('Failed') || status.includes('Disconnected')
                          ? 'text-red-600'
                          : 'text-yellow-500'
                    }`}
                  >
                    {status}
                  </span>
                </div>
              </div>

              {/* Open / Leave buttons */}
              <div className="flex gap-2">
                <button
                  onClick={() => router.push(`flight/${flightId}`)}
                  className="px-3 py-1.5 rounded-full bg-zinc-100/60 hover:bg-zinc-200 text-zinc-900 text-xs font-semibold transition duration-200 shadow-inner"
                >
                  Open
                </button>
                <button
                  onClick={handleLeaveFlight}
                  className="px-3 py-1.5 rounded-full bg-red-100/70 hover:bg-red-200 text-red-600 text-xs font-semibold transition duration-200 shadow-inner"
                >
                  Leave
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Terms modal */}
        <TermsModal show={showTerms} onClose={() => setShowTerms(false)} onAccept={handleAccept} />

        {/* Large tagline (desktop) */}
        <section className="relative w-full mt-10 md:w-auto hidden md:block flex-col items-center md:items-start text-center md:text-left justify-center">
          <h2 className="text-6xl md:text-8xl font-extrabold drop-shadow-2xl select-none mb-2 dark:text-zinc-100">
            SHARE.
            <br className="block" />
            FILES.
            <br className="block" />
            INSTANTLY.
          </h2>
          <h1 className="text-lg md:text-xl text-zinc-600 dark:text-zinc-400 font-medium mt-1 max-w-md">
            The fastest and most private way to send files — peer to peer.
          </h1>
          <p className="mt-1 text-sm mb-2 text-zinc-400 dark:text-zinc-500 max-w-md">
            No cloud. No limits. Just you and the receiver.
          </p>
        </section>

        {/* Tagline (mobile) */}
        <section className="relative md:hidden w-full flex flex-col items-center text-center px-6 mt space-y-3">
          <h1 className="text-2xl font-semibold text-zinc-800 dark:text-zinc-100">
            Share files instantly across devices.
          </h1>
          <h2 className="text-sm text-zinc-500 dark:text-zinc-400">
            Open the site on both devices — no signups, no uploads, just P2P.
          </h2>
        </section>

        {/* Nearby users + Ticket area */}
        <section
          aria-labelledby="nearby-users"
          className="flex relative items-center sm:items-start flex-col md:flex-row gap-2"
        >
          {/* Near-by users grid: only shown when not already in a flight */}
          {!flightId && (
            <div className="z-50 p-2 md:mt-6 gap-2 grid sm:absolute sm:-left-20 grid-flow-col auto-cols-max md:grid-flow-row md:grid-cols-1 max-w-screen">
              {nearByUsers.length === 0 && (
                <p className="text-sm animate-fadeIn md:-rotate-90 font-mono md:mt-10 md:h-5 dark:text-zinc-400">
                  No user nearby
                </p>
              )}

              {nearByUsers.map((m) => {
                const isDragOver = dragOverId === m.id;
                return (
                  <div
                    key={m.id}
                    className={`group animate-fadeIn w-16 h-16 origin-right bg-white/60 dark:bg-zinc-900/60 backdrop-blur-md border border-zinc-300 dark:border-zinc-700 rounded-xl shadow-sm overflow-hidden transition-all duration-300 ease-in-out cursor-pointer flex items-center justify-center drag-target relative hover:w-52 hover:h-24 hover:scale-110 hover:z-10 ${isDragOver ? 'w-52 h-24 scale-110 z-10' : ''}`}
                    onDragEnter={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOverId(m.id);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (dragOverId !== m.id) setDragOverId(m.id);
                    }}
                    onDragLeave={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverId(null);
                    }}
                    onClick={() => {
                      // Quick create flight and invite this user
                      socket?.emit('createFlight', (response: { code: string }) => {
                        connectToFlight(response.code);
                        inviteToFlight(m, response.code);
                        router.push(`/flight/${response.code}`);
                      });
                    }}
                    onDrop={async (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOverId(null);
                      if (!socket) return;
                      if (flightId) return;

                      // Create a flight and invite user
                      socket.emit('createFlight', (response: { code: string }) => {
                        connectToFlight(response.code);
                        inviteToFlight(m, response.code);
                      });

                      // Collect dropped files and forward to file handler
                      const items = e.dataTransfer.items;
                      const files: File[] = [];
                      for (let i = 0; i < items.length; i++) {
                        const item = items[i];
                        if (item.kind === 'file') {
                          const file = item.getAsFile();
                          if (file) files.push(file);
                        }
                      }

                      if (files.length === 0) return;
                      const dt = new DataTransfer();
                      files.forEach((file) => dt.items.add(file));
                      const fileList = dt.files;

                      handleFileSelect({
                        target: { files: fileList },
                      } as ChangeEvent<HTMLInputElement>);
                    }}
                  >
                    {/* Compact view */}
                    <div className="absolute inset-0 flex items-center justify-center text-center px-2 pointer-events-none">
                      <span className="text-sm font-semibold group-hover:opacity-0 text-zinc-800 dark:text-zinc-200 transition-opacity">
                        {m.name}
                      </span>
                    </div>

                    {/* Expanded view */}
                    <div
                      className={`absolute inset-0 flex flex-col items-center justify-center opacity-0 transition-opacity duration-200 px-2 group-hover:opacity-100 ${isDragOver ? 'opacity-100' : ''}`}
                    >
                      <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                        {m.name}
                      </span>
                      <code className="text-[0.7rem] text-zinc-800 dark:text-zinc-300 break-words text-center">
                        ID: {m.id ? m.id : 'Connecting...'}
                      </code>
                      <code className="mt-1 text-[0.7rem] text-zinc-700 dark:text-zinc-400 bg-white/70 dark:bg-zinc-800/70 border border-dotted border-black dark:border-white rounded-xl px-2 py-1">
                        Drop files to send
                      </code>
                      <span className="text-[0.7rem] dark:text-zinc-400">
                        click to quick create a flight
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Ticket + About column */}
          <div className="flex flex-col gap-10 max-w-84">
            <div className="relative flex flex-col items-center pt-24 rounded-3xl shadow-2xl text-zinc-900 bg-orange-600 min-h-[480px] w-full max-w-md transition-all overflow-hidden ticket-border">
              {/* Ticket header */}
              <div className="flex flex-col items-center mb-6">
                <span className="uppercase tracking-widest text-xs font-bold text-zinc-100 opacity-70">
                  airdelivery.site
                </span>
                <h2 className="text-3xl font-extrabold tracking-tight text-zinc-100 mt-2 mb-1">
                  {user.name}
                </h2>
                <span className="text-sm text-zinc-100 opacity-70">Your file transfer ticket</span>
              </div>

              {/* File & folder prompt (keeps original hidden button) */}
              <div className="flex flex-row space-x-4 w-full mb-2 px-8">
                <label className="flex flex-col flex-1 items-center text-zinc-700 px-8 py-3 rounded-xl bg-zinc-100 hover:bg-zinc-100 font-semibold shadow-lg transition-all transform hover:-translate-y-1 cursor-pointer ">
                  <span>
                    {flightId ? "You're currently in a flight...." : 'Tap to start sending'}
                  </span>
                  <button className="hidden" onClick={handleCreate} />
                </label>
              </div>

              <p className="text-xs text-zinc-50 mb-0 tracking-tight uppercase font-mono">
                Select files or folder to send
              </p>

              {/* Divider */}
              <div className="w-full flex justify-between items-center h-8">
                <div className="w-8 h-8 bg-zinc-300 dark:bg-zinc-800 rounded-full -ml-4"></div>
                <div className="flex-grow border-t-2 border-dashed border-zinc-200 dark:border-zinc-700" />
                <span className="mx-4 text-zinc-50 font-semibold px-2 bg-orange-600 tracking-widest uppercase text-xs">
                  or
                </span>
                <div className="flex-grow border-t-2 border-dashed border-zinc-200 dark:border-zinc-700" />
                <div className="w-8 h-8 bg-zinc-300 dark:bg-zinc-800 rounded-full -mr-4"></div>
              </div>

              {/* Receive section with permanent input */}
              <div className="flex items-center w-full px-8 gap-2 mb-2">
                <input
                  type="text"
                  value={flightCode}
                  readOnly={!!flightId}
                  onChange={(e) => setFlightCode(e.target.value)}
                  placeholder="Flight Id"
                  aria-label="Enter flight code"
                  className="px-6 py-3 rounded-2xl w-54 bg-zinc-100 dark:bg-zinc-200 outline-0 font-mono text-zinc-800 border border-zinc-300 dark:border-zinc-700"
                />
                <button
                  onClick={handleJoin}
                  aria-label="Launch or Send"
                  className="p-3 rounded-2xl shadow-lg bg-zinc-900 hover:bg-zinc-800 transition"
                >
                  <svg width="24" height="24" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" fill="#ffffff" />
                  </svg>
                </button>
              </div>

              <p className="text-xs text-zinc-50 tracking-tight uppercase font-mono mb-4">
                Enter your flight code to receive
              </p>

              <code className="text-xs absolute bottom-5 right-8 tracking-tight text-zinc-100 mt-2 -mb-3">
                ID:{user.id}
              </code>
            </div>

            <div className="bg-zinc-900 dark:bg-zinc-950 rounded-xl shadow-xl p-4 md:p-5 text-zinc-200 text-sm md:text-base max-w-md w-full space-y-3">
              <h2 className="text-2xl font-bold text-white tracking-tight">About</h2>
              <p className="leading-relaxed text-zinc-400">
                <span className="text-white font-medium">Airdelivery</span> lets you send files
                instantly, securely, and directly — no signups, no uploads, no limits.
              </p>
              <p className="text-zinc-500 text-xs dark:text-zinc-600">
                Peer-to-peer, encrypted, and works across all modern devices.
              </p>

              <div className="flex justify-between items-center mt-2">
                <AboutCard />

                <a
                  href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(
                    'Check out Airdelivery.io — fast, secure, unlimited P2P file sharing. No cloud, no signup. #Airdelivery #FileSharing',
                  )}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-zinc-50 hover:text-orange-400 transition"
                  title="Share on Twitter"
                >
                  <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M17.53 3H21l-7.19 8.21L22 21h-6.56l-5.18-6.44L4.47 21H1l7.64-8.73L2 3h6.68l4.74 5.91L17.53 3ZM16.3 19h2.13l-5.82-7.23-1.71 1.98L16.3 19ZM5.09 5l5.38 6.69 1.7-1.97L7.36 5H5.09Z" />
                  </svg>
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <InfoSection />
    </>
  );
}
