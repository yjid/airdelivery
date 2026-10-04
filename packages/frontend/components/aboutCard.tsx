'use client';

/**
 * "What's new" modal.
 *
 * The previous version embedded an autoplaying, looping, muted YouTube iframe
 * inside a dialog. That is a surprising amount of third-party bandwidth to spend
 * on someone who has just opened a modal, it is a common accessibility problem,
 * and it is blocked outright by many ad blockers and corporate proxies.
 *
 * It now shows a poster and only loads the video after an explicit click.
 */

import { useState } from 'react';

const VIDEO_ID = 'l_YP2RgcyHY';
const THUMB = `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`;

const HIGHLIGHTS = [
  {
    title: 'Peer to peer',
    body: 'Files go straight between the two devices over WebRTC. The server introduces the devices and never sees the data.',
  },
  {
    title: 'No size limit',
    body: 'Transfers stream in chunks, so a 20 GB file is no harder to send than a 20 MB one.',
  },
  {
    title: 'Verified delivery',
    body: 'Every file is checked with SHA-256 after it arrives, so a corrupted transfer is caught rather than silently saved.',
  },
  {
    title: 'Resumable',
    body: 'Pause, resume, and cancel per file. Partial transfers are written straight to disk rather than held in memory.',
  },
];

export default function WhatsNewCard() {
  const [open, setOpen] = useState(false);
  const [playVideo, setPlayVideo] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="text-sm font-medium text-zinc-300 hover:text-orange-500 transition-colors"
      >
        What&apos;s New?
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[70] flex items-start justify-center bg-black/60 backdrop-blur-sm overflow-auto p-4"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="What's new in AirDelivery"
            onClick={(e) => e.stopPropagation()}
            className="bg-white dark:bg-zinc-900 rounded-2xl max-w-2xl w-full p-6 md:p-8 my-8 shadow-2xl relative"
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="absolute top-4 right-4 text-2xl text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-100"
            >
              &times;
            </button>

            <h2 className="text-2xl md:text-3xl font-bold mb-4 pr-8">What&apos;s new</h2>

            <div className="mb-6 rounded-xl overflow-hidden shadow aspect-video bg-zinc-900">
              {playVideo ? (
                <iframe
                  className="w-full h-full"
                  src={`https://www.youtube-nocookie.com/embed/${VIDEO_ID}?autoplay=1`}
                  title="AirDelivery demo"
                  allow="accelerometer; encrypted-media; picture-in-picture"
                  allowFullScreen
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setPlayVideo(true)}
                  className="w-full h-full flex flex-col items-center justify-center gap-2 text-white hover:bg-zinc-800 transition"
                >
                  <img
                    src={THUMB}
                    alt=""
                    className="absolute inset-0 w-full h-full object-cover opacity-60"
                  />
                  <span className="relative z-10 text-sm font-semibold">Play the demo</span>
                </button>
              )}
            </div>

            <ul className="space-y-4 text-sm md:text-base leading-relaxed">
              {HIGHLIGHTS.map((item) => (
                <li key={item.title}>
                  <h3 className="font-semibold text-zinc-800 dark:text-zinc-100">{item.title}</h3>
                  <p className="text-zinc-600 dark:text-zinc-400">{item.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
