import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center px-4 bg-zinc-50 dark:bg-zinc-950">
      <div className="max-w-md w-full bg-white dark:bg-zinc-900 rounded-3xl shadow-xl border border-zinc-200 dark:border-zinc-800 p-8 text-center">
        <h1 className="text-2xl font-extrabold text-zinc-900 dark:text-zinc-100 mb-3">
          Page not found
        </h1>
        <p className="text-zinc-600 dark:text-zinc-400 mb-6">
          That link does not exist. If you were sent a flight code, open it from the home page
          instead — codes are not part of the page URL.
        </p>
        <Link
          href="/"
          className="inline-block px-5 py-2.5 rounded-full bg-orange-600 hover:bg-orange-700 text-white font-semibold transition"
        >
          Go home
        </Link>
      </div>
    </main>
  );
}
