'use client';

/**
 * Route-level error boundary.
 *
 * The app had no error boundary anywhere, so any render throw produced a blank
 * white page. On a P2P app that is especially bad: the user has usually just
 * started a transfer, so a crash loses their place with no explanation and no
 * way back except a manual refresh.
 */

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[app] render error', error);
  }, [error]);

  return (
    <main className="min-h-screen flex items-center justify-center px-4 bg-zinc-50 dark:bg-zinc-950">
      <div className="max-w-md w-full bg-white dark:bg-zinc-900 rounded-3xl shadow-xl border border-zinc-200 dark:border-zinc-800 p-8 text-center">
        <h1 className="text-2xl font-extrabold text-orange-600 mb-3">Something went wrong</h1>
        <p className="text-zinc-600 dark:text-zinc-400 mb-6">
          The page hit an unexpected error. Any transfer in progress has been stopped.
        </p>
        {error.digest && (
          <p className="text-xs font-mono text-zinc-400 mb-4">Reference: {error.digest}</p>
        )}
        <div className="flex gap-3 justify-center">
          <button
            type="button"
            onClick={reset}
            className="px-5 py-2.5 rounded-full bg-orange-600 hover:bg-orange-700 text-white font-semibold transition"
          >
            Try again
          </button>
          <a
            href="/"
            className="px-5 py-2.5 rounded-full bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-900 dark:text-zinc-100 font-semibold transition"
          >
            Go home
          </a>
        </div>
      </div>
    </main>
  );
}
