'use client';

/**
 * Transfer list.
 *
 * Every control is a real `<button type="button">` with an accessible name.
 * Previously the icon-only buttons relied on `title` alone, which screen
 * readers do not reliably announce, and the cards were memoised on a comparator
 * that ignored `blobUrl`, so a finished download could render stale.
 *
 * Progress is exposed through `aria-valuenow` on a `progressbar` role so the
 * state is not conveyed by a coloured bar alone.
 */

import { memo } from 'react';
import { ArrowDown, ArrowUp, Download, File, Pause, Play, X } from 'lucide-react';
import { formatBytes } from '@/utils/flattenFilelist';

export interface TrayItem {
  transferId: string;
  directoryPath?: string;
  file?: { name: string; size: number };
  progress?: number;
  status: string;
  type?: 'send' | 'receive';
  url?: string | null;
  downloaded?: boolean;
  error?: string;
}

interface QueueTrayProps {
  title: string;
  items: TrayItem[];
  onPause?: (id: string) => void;
  onResume?: (id: string) => void;
  onCancel?: (id: string, kind: 'send' | 'receive') => void;
  onDownload?: (item: TrayItem) => void;
}

const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  sending: 'Sending',
  paused: 'Paused',
  done: 'Done',
  error: 'Failed',
  canceled: 'Canceled',
  receiving: 'Receiving',
  verifying: 'Verifying',
};

const nameOf = (item: TrayItem) =>
  item.file?.name ?? item.directoryPath?.split('/').pop() ?? 'file';

const sizeOf = (item: TrayItem) =>
  item.file?.size ?? (item.progress !== undefined ? undefined : undefined);

const TransferCard = memo(
  function TransferCard({
    item,
    onPause,
    onResume,
    onCancel,
    onDownload,
  }: {
    item: TrayItem;
    onPause?: (id: string) => void;
    onResume?: (id: string) => void;
    onCancel?: (id: string, kind: 'send' | 'receive') => void;
    onDownload?: (item: TrayItem) => void;
  }) {
    const isReceive = item.type === 'receive';
    const progress = Math.min(100, Math.max(0, item.progress ?? 0));
    const finished = item.status === 'done';
    const dead = finished || item.status === 'canceled';

    return (
      <li className="relative w-52 shrink-0 rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm flex flex-col overflow-hidden">
        <span
          className={`absolute top-2 left-2 p-1 rounded-full bg-zinc-100 dark:bg-zinc-800 ${
            isReceive ? 'text-green-600' : 'text-blue-600'
          }`}
        >
          {isReceive ? (
            <ArrowDown className="w-4 h-4" aria-hidden="true" />
          ) : (
            <ArrowUp className="w-4 h-4" aria-hidden="true" />
          )}
        </span>
        <span className="sr-only">{isReceive ? 'Receiving' : 'Sending'}</span>

        <div className="w-full h-28 bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
          <File className="w-10 h-10 text-zinc-400" aria-hidden="true" />
        </div>

        <div className="flex flex-col items-center px-3 py-2 gap-1">
          <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100 truncate w-full text-center">
            {nameOf(item)}
          </span>
          {sizeOf(item) !== undefined && (
            <span className="text-[11px] text-zinc-500">{formatBytes(sizeOf(item)!)}</span>
          )}

          <div
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Transfer progress for ${nameOf(item)}`}
            className="w-full h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden"
          >
            <div
              className={`h-full transition-all duration-300 ${
                item.status === 'error' ? 'bg-red-500' : 'bg-orange-500'
              }`}
              style={{ width: `${progress}%` }}
            />
          </div>

          <div className="w-full flex justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
            <span>{progress}%</span>
            <span>{STATUS_LABELS[item.status] ?? item.status}</span>
          </div>

          {item.error && (
            <p role="alert" className="text-[11px] text-red-600 dark:text-red-400 text-center">
              {item.error}
            </p>
          )}
        </div>

        <div className="w-full flex justify-center items-center gap-2 py-2">
          {!isReceive && item.status === 'sending' && (
            <IconButton label={`Pause ${nameOf(item)}`} onClick={() => onPause?.(item.transferId)}>
              <Pause className="w-4 h-4" aria-hidden="true" />
            </IconButton>
          )}
          {!isReceive && item.status === 'paused' && (
            <IconButton
              label={`Resume ${nameOf(item)}`}
              onClick={() => onResume?.(item.transferId)}
            >
              <Play className="w-4 h-4" aria-hidden="true" />
            </IconButton>
          )}
          {!dead && (
            <IconButton
              label={`Cancel ${nameOf(item)}`}
              tone="danger"
              onClick={() => onCancel?.(item.transferId, isReceive ? 'receive' : 'send')}
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </IconButton>
          )}
          {isReceive && finished && item.downloaded && (
            <span className="text-[11px] text-zinc-500 font-semibold">Saved</span>
          )}
          {isReceive && finished && !item.downloaded && item.url && (
            <IconButton
              label={`Download ${nameOf(item)}`}
              tone="info"
              onClick={() => onDownload?.(item)}
            >
              <Download className="w-4 h-4" aria-hidden="true" />
            </IconButton>
          )}
        </div>
      </li>
    );
  },
  (prev, next) =>
    prev.item.progress === next.item.progress &&
    prev.item.status === next.item.status &&
    prev.item.downloaded === next.item.downloaded &&
    prev.item.url === next.item.url &&
    prev.item.error === next.item.error,
);

function IconButton({
  label,
  onClick,
  tone = 'neutral',
  children,
}: {
  label: string;
  onClick: () => void;
  tone?: 'neutral' | 'danger' | 'info';
  children: React.ReactNode;
}) {
  const tones = {
    neutral: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300',
    danger: 'bg-red-50 dark:bg-red-900/30 text-red-500',
    info: 'bg-blue-50 dark:bg-blue-900/30 text-blue-500',
  } as const;

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`rounded-full p-1.5 border border-zinc-200 dark:border-zinc-700 transition hover:brightness-95 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

export function QueueTray({
  title,
  items,
  onPause,
  onResume,
  onCancel,
  onDownload,
}: QueueTrayProps) {
  return (
    <section
      aria-label={title}
      className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm p-4 border border-zinc-200 dark:border-zinc-800"
    >
      <h2 className="text-lg font-semibold mb-4 dark:text-zinc-100">
        {title}
        <span className="ml-2 text-sm font-normal text-zinc-500">{items.length}</span>
      </h2>

      {items.length === 0 ? (
        <p className="flex flex-col items-center justify-center py-10 text-zinc-400 dark:text-zinc-500 text-sm">
          <File className="w-8 h-8 mb-2" aria-hidden="true" />
          No transfers yet
        </p>
      ) : (
        <ul className="flex gap-4 overflow-x-auto pb-2">
          {items.map((item) => (
            <TransferCard
              key={`${item.type ?? 'send'}:${item.transferId}`}
              item={item}
              onPause={onPause}
              onResume={onResume}
              onCancel={onCancel}
              onDownload={onDownload}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
