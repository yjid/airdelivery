import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Offline' };

export default function OfflinePage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-4 bg-zinc-50 dark:bg-zinc-950">
      <div className="max-w-md w-full bg-white dark:bg-zinc-900 rounded-3xl shadow-xl border border-zinc-200 dark:border-zinc-800 p-8 text-center">
        <h1 className="text-2xl font-extrabold text-zinc-900 dark:text-zinc-100 mb-3">
          You are offline
        </h1>
        <p className="text-zinc-600 dark:text-zinc-400 mb-6">
          AirDelivery needs to reach the signaling server to introduce two devices to each other, so
          a transfer cannot start without a connection. Reconnect and reload to continue.
        </p>
        <a
          href="/"
          className="inline-block px-5 py-2.5 rounded-full bg-orange-600 hover:bg-orange-700 text-white font-semibold transition"
        >
          Try again
        </a>
      </div>
    </main>
  );
}
