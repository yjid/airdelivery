'use client';

/**
 * Flight invitation popup.
 *
 * This was a hook that *returned JSX*, which breaks the rules of hooks: it
 * cannot be called conditionally, it defeats Fast Refresh, and it forces every
 * consumer to render a value that looks like a component. It is a component now.
 *
 * It also used `z-500`, which is not a Tailwind class, so the popup had no
 * z-index at all and rendered underneath the sticky header.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EV } from '@airdelivery/protocol';
import { useSocket } from '@/context/socketContext';

interface Invitation {
  flightCode: string;
  fromId: string;
  fromName: string;
}

const TIMEOUT_SECONDS = 60;

export function InvitationToJoin() {
  const { socket } = useSocket();
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [remaining, setRemaining] = useState(TIMEOUT_SECONDS);
  const closeButton = useRef<HTMLButtonElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!socket) return;

    // Registered with an explicit reference so `off` removes only this one.
    const onInvited = (payload: Invitation) => {
      setInvitation(payload);
      setRemaining(TIMEOUT_SECONDS);
      closeButton.current?.focus();
    };

    socket.on(EV.invitedToFlight, onInvited);
    return () => {
      socket.off(EV.invitedToFlight, onInvited);
    };
  }, [socket]);

  // Escape dismisses, which is expected of any dialog.
  useEffect(() => {
    if (!invitation) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setInvitation(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [invitation]);

  useEffect(() => {
    if (!invitation) return;
    const timer = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          setInvitation(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [invitation]);

  const accept = useCallback(() => {
    if (!invitation) return;
    router.push(`/flight/${invitation.flightCode}`);
    setInvitation(null);
  }, [invitation, router]);

  if (!invitation) return null;

  return (
    <div
      role="dialog"
      aria-labelledby="invite-title"
      className="fixed top-20 right-4 z-[60] animate-fadeIn"
    >
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xl rounded-2xl w-72 sm:w-96 overflow-hidden">
        <div className="p-4">
          <h2 id="invite-title" className="text-lg font-bold text-zinc-800 dark:text-zinc-100 mb-1">
            Join flight{' '}
            <span className="font-mono font-extrabold text-orange-600">
              {invitation.flightCode}
            </span>
            ?
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
            <span className="font-medium">{invitation.fromName}</span> wants to send you files.
          </p>
          <div className="flex justify-end gap-2">
            <button
              ref={closeButton}
              type="button"
              onClick={() => setInvitation(null)}
              className="px-3 py-1.5 rounded-lg bg-zinc-200 hover:bg-zinc-300 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-200 text-sm"
            >
              Decline
            </button>
            <button
              type="button"
              onClick={accept}
              className="px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-700 text-white text-sm font-medium"
            >
              Accept
            </button>
          </div>
        </div>
        <div className="h-1 w-full bg-zinc-200 dark:bg-zinc-800 relative overflow-hidden">
          <div
            aria-hidden="true"
            className="absolute inset-y-0 left-0 bg-orange-500 transition-all duration-1000"
            style={{ width: `${(remaining / TIMEOUT_SECONDS) * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
