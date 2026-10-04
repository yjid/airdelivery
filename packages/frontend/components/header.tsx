'use client';

import Image from 'next/image';
import Link from 'next/link';
import { Github } from 'lucide-react';
import ThemeToggle from './ThemeToggle';

const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL ?? 'https://github.com/GochiStuff/airdelivery';

export default function Header() {
  return (
    <header className="sticky top-0 z-50 w-full h-16 flex items-center justify-between px-4 md:px-10 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-md border-b border-zinc-200 dark:border-zinc-800">
      <Link
        href="/"
        className="flex items-center gap-2.5 active:scale-95 transition-transform"
        aria-label="AirDelivery home"
      >
        <Image
          src="/icons/logo.png"
          alt=""
          width={36}
          height={36}
          className="object-contain"
          priority
        />
        <span className="text-lg sm:text-xl font-bold tracking-tighter text-zinc-900 dark:text-zinc-100 uppercase select-none">
          Air Delivery
        </span>
      </Link>

      <nav aria-label="Main" className="flex items-center gap-1 sm:gap-4">
        <div className="hidden md:flex items-center gap-4">
          <ThemeToggle />
        </div>

        <Link
          href="/guide/p2p-file-sharing"
          className="hidden sm:inline text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 transition-colors"
        >
          How it works
        </Link>

        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="p-2 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
          aria-label="Source code on GitHub"
          title="Source code on GitHub"
        >
          <Github className="w-5 h-5" aria-hidden="true" />
        </a>
      </nav>
    </header>
  );
}
