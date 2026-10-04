'use client';

import Link from 'next/link';
import { Github } from 'lucide-react';
import TermsModal from './terms';

const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL ?? 'https://github.com/GochiStuff/airdelivery';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://airdelivery.site';

export default function FooterStrip() {
  return (
    <footer className="w-full border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-zinc-600 dark:text-zinc-400 text-sm px-6 py-6">
      <div className="max-w-6xl mx-auto flex flex-col sm:flex-row flex-wrap justify-between items-center gap-4 text-center sm:text-left">
        <nav
          aria-label="Footer"
          className="flex flex-wrap justify-center items-center gap-x-6 gap-y-2"
        >
          <Link href="/" className="hover:text-orange-500 transition-colors">
            Home
          </Link>
          <Link href="/guide/p2p-file-sharing" className="hover:text-orange-500 transition-colors">
            How it works
          </Link>
          <a
            href={SITE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-orange-500 transition-colors"
          >
            Live site
          </a>
          <TermsModal />
          <a
            href={`${REPO_URL}/issues`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-orange-500 transition-colors"
          >
            Report an issue
          </a>
          <a
            href={`${REPO_URL}/blob/main/CONTRIBUTING.md`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-orange-500 transition-colors"
          >
            Contribute
          </a>
        </nav>

        <div className="flex items-center gap-4">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Source code on GitHub"
            className="hover:text-orange-500 transition-colors"
          >
            <Github className="w-5 h-5" aria-hidden="true" />
          </a>
          <p className="text-xs text-zinc-500 dark:text-zinc-500">
            Free and open source, MIT licensed.
          </p>
        </div>
      </div>
    </footer>
  );
}
