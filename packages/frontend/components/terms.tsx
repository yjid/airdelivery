'use client';

/**
 * Terms and privacy notice.
 *
 * Previously duplicated in two files (`terms.tsx` and `infoComponent.tsx`) with
 * slightly different wording, so the two copies had already drifted. There is
 * one copy now.
 *
 * Supports two usages: a self-contained trigger for the footer, and a
 * controlled variant for the home page, which must show it as a precondition
 * before creating a flight.
 *
 * `infoComponent.tsx` also imported a non-existent `icons` export from
 * lucide-react and referenced a `router` it never used. It was deleted.
 */

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

const SECTIONS: Array<{ heading: string; items: string[] }> = [
  {
    heading: '1. File transfers',
    items: [
      'AirDelivery transfers files directly between two browsers using a peer-to-peer WebRTC connection.',
      'The server facilitates the connection and nothing else. File data is never uploaded to, stored on, or routed through a server we operate.',
      'Transfers are ephemeral. Nothing is retained after you close the tab.',
    ],
  },
  {
    heading: '2. Privacy',
    items: [
      'No accounts. We do not ask for or store your name, email, or any identifier that follows you.',
      'Your IP address is used transiently to discover devices on your own local network, and is discarded when you disconnect. It is never written to logs in raw form.',
      'Aggregate counters — files transferred and total bytes, with no file names, contents, or addresses — are used to understand usage.',
    ],
  },
  {
    heading: '3. Acceptable use',
    items: [
      'Do not use AirDelivery to distribute unlawful, infringing, or harmful content. You are solely responsible for what you share.',
      'Automated abuse of the signaling server is not permitted.',
      'We may block traffic that is attacking the infrastructure or violating these terms.',
    ],
  },
  {
    heading: '4. Availability',
    items: [
      'The service is provided as-is, with no guarantee of uptime.',
      'Browser-to-browser connections can be blocked by a network. A relay has to be configured by whoever runs the server for restrictive corporate or campus networks to work; home and local networks are unaffected.',
      'Because the transfer is direct, throughput depends entirely on the two devices and the network between them.',
    ],
  },
  {
    heading: '5. Licence',
    items: [
      'AirDelivery is free and open source under the MIT licence. You may self-host it, inspect it, and modify it.',
    ],
  },
];

function useDismissable(show: boolean, onClose: () => void) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!show) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // Move focus into the dialog so keyboard and screen-reader users are not
    // left behind on the page underneath.
    panel.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [show, onClose]);

  return panel;
}

interface TermsProps {
  show: boolean;
  onClose: () => void;
  onAccept?: () => void;
}

function TermsPanel({ show, onClose, onAccept }: TermsProps) {
  const panel = useDismissable(show, onClose);
  if (!show) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/60 backdrop-blur-sm p-4 overflow-auto animate-fadeIn"
      onClick={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="terms-heading"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-zinc-900 rounded-2xl max-w-2xl w-full p-6 md:p-8 my-8 shadow-2xl text-zinc-800 dark:text-zinc-200 outline-none"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-100"
        >
          <X className="w-5 h-5" aria-hidden="true" />
        </button>

        <h2 id="terms-heading" className="text-2xl font-bold mb-4 pr-8">
          Terms &amp; privacy
        </h2>

        <div className="space-y-5 text-sm leading-relaxed max-h-[60vh] overflow-y-auto pr-2">
          {SECTIONS.map((section) => (
            <section key={section.heading}>
              <h3 className="font-semibold mb-1">{section.heading}</h3>
              <ul className="list-disc list-inside space-y-1 text-zinc-600 dark:text-zinc-400">
                {section.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="flex flex-wrap justify-end gap-3 mt-6">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2.5 rounded-full border border-zinc-300 dark:border-zinc-700 font-medium transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            Close
          </button>
          {onAccept && (
            <button
              type="button"
              onClick={onAccept}
              className="px-5 py-2.5 rounded-full bg-orange-600 hover:bg-orange-700 text-white font-semibold transition"
            >
              Accept and continue
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Controlled variant, used by the home page before creating a flight. */
export function TermsModal({ show, onClose, onAccept }: TermsProps) {
  return <TermsPanel show={show} onClose={onClose} onAccept={onAccept} />;
}

/** Self-contained variant, used in the footer. */
export default function TermsTrigger() {
  const [show, setShow] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setShow(true)}
        className="hover:text-orange-500 transition-colors"
      >
        Terms &amp; privacy
      </button>
      <TermsPanel show={show} onClose={() => setShow(false)} />
    </>
  );
}
