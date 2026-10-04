'use client';

/**
 * Install and share prompt.
 *
 * The old copy said "Use Opera (suggested) or a different browser if site isn't
 * working" and "Avoid refreshing after connection is established". Both are
 * symptoms of bugs that have now actually been fixed, so telling users to work
 * around them is worse than useless. The advice is replaced with something true.
 */

import { useEffect, useState } from 'react';
import { Download, Heart, Share2, Wifi } from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function AskToShareSection() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [canInstall, setCanInstall] = useState(false);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
      setCanInstall(true);
    };
    const onInstalled = () => {
      setDeferred(null);
      setCanInstall(false);
    };

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
    setCanInstall(false);
  };

  const share = async () => {
    const url = window.location.origin;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'AirDelivery', text: 'Send files peer to peer', url });
        return;
      }
      await navigator.clipboard.writeText(url);
    } catch {
      // The user dismissed the share sheet, or clipboard access was denied.
      // Neither is worth an error dialog.
    }
  };

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-3xl shadow-sm p-5 sm:p-6 flex flex-col gap-5 border border-zinc-200 dark:border-zinc-800">
      <div>
        <h2 className="flex items-center gap-3 text-xl sm:text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
          <Heart className="w-6 h-6 text-red-500 fill-red-500" aria-hidden="true" />
          Send this on
        </h2>
        <ul className="mt-3 list-disc list-inside text-zinc-600 dark:text-zinc-500 text-sm space-y-2">
          <li>
            <Wifi className="inline w-4 h-4 mr-1 -mt-0.5" aria-hidden="true" />
            <strong className="text-zinc-800 dark:text-zinc-300">Tip:</strong> Both devices on the
            same Wi-Fi is much faster, because the connection never leaves your network.
          </li>
          <li>
            <strong className="text-zinc-800 dark:text-zinc-300">Private:</strong> Files go straight
            between the two devices. Nothing is uploaded.
          </li>
          <li>
            <strong className="text-zinc-800 dark:text-zinc-300">Free:</strong> No account, no size
            limit, and the source is open.
          </li>
        </ul>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <button
          type="button"
          onClick={() => void share()}
          className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl font-medium transition"
        >
          <Share2 className="w-5 h-5" aria-hidden="true" />
          Share
        </button>
        <button
          type="button"
          onClick={() => void install()}
          disabled={!canInstall}
          className={`flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-2xl font-medium transition ${
            canInstall
              ? 'bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700'
              : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed'
          }`}
        >
          <Download className="w-5 h-5" aria-hidden="true" />
          Install
        </button>
      </div>
    </div>
  );
}

export default AskToShareSection;
