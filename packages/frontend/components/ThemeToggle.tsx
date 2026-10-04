'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';

const STORAGE_KEY = 'airdelivery:theme';
type Theme = 'light' | 'dark';

const subscribers = new Set<() => void>();

/**
 * Theme lives outside React — in `document.documentElement` and localStorage.
 *
 * The previous version called `setState` synchronously inside an effect, which
 * React flags because it forces an extra render pass on every mount, and it
 * defaulted to light unless the stored value was literally 'dark', so anyone
 * whose OS was in dark mode got a white flash on every load.
 *
 * `useSyncExternalStore` is the correct primitive for state owned outside React:
 * the server snapshot is 'light' for a stable hydration render, and the real
 * value is picked up immediately after without a cascading update.
 */

function emit() {
  for (const fn of subscribers) fn();
}

function apply(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
  localStorage.setItem(STORAGE_KEY, theme);
  emit();
}

function getSnapshot(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function getServerSnapshot(): Theme {
  // Stable across SSR and the first client render, so hydration never mismatches.
  return 'light';
}

function subscribe(onChange: () => void) {
  subscribers.add(onChange);
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystemChange = () => {
    // Follow the OS only while the user has not made an explicit choice.
    if (localStorage.getItem(STORAGE_KEY)) return;
    document.documentElement.classList.toggle('dark', media.matches);
    onChange();
  };
  media.addEventListener('change', onSystemChange);
  return () => {
    subscribers.delete(onChange);
    media.removeEventListener('change', onSystemChange);
  };
}

export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggle = useCallback(() => {
    apply(getSnapshot() === 'dark' ? 'light' : 'dark');
  }, []);

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      className="p-2 rounded-full text-zinc-800 dark:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors"
    >
      {theme === 'dark' ? (
        <Sun className="w-5 h-5" aria-hidden="true" />
      ) : (
        <Moon className="w-5 h-5" aria-hidden="true" />
      )}
    </button>
  );
}
