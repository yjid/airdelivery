import { Download, File, FolderOpen, Pause, Play, X, ArrowDown, ArrowUp } from 'lucide-react';
import React, { useEffect, useState, memo } from 'react';
import { Switch } from '../ui/switch';
import {
  supportsFSAccess,
  requestSaveDirectory,
  clearSaveDirectory,
  hasSaveDirectory,
  saveDirectoryName,
} from '@/lib/fsAccess';

interface QueueTrayProp {
  title: string;
  items: any[];
  pauseTransfer?: (id: string) => void;
  fileDownload?: (file: any) => void;
  openfile?: (url: string) => void;
  autoDownload?: boolean;
  setAutoDownload?: (b: boolean) => void;
  resumeTransfer?: (id: string) => void;
  cancelTransfer?: (id: string) => void;
}

const statusLabels: Record<string, string> = {
  queued: 'Queued',
  sending: 'Sending',
  paused: 'Paused',
  done: 'Done',
  error: 'Error',
  canceled: 'Canceled',
  receiving: 'Receiving',
};

const TransferCard = memo(
  ({
    item,
    autoDownload,
    pauseTransfer,
    resumeTransfer,
    cancelTransfer,
    fileDownload,
  }: {
    item: any;
    autoDownload?: boolean;
    pauseTransfer?: (id: string) => void;
    resumeTransfer?: (id: string) => void;
    cancelTransfer?: (id: string) => void;
    fileDownload?: (file: any) => void;
  }) => {
    const isReceive = item.type === 'receive';
    const icon = isReceive ? (
      <ArrowDown className="w-4 h-4 text-green-500" />
    ) : (
      <ArrowUp className="w-4 h-4 text-blue-500" />
    );

    return (
      <div className="relative w-48 flex-shrink-0 rounded-2xl outline-1 outline-zinc-300 dark:outline-zinc-700 bg-white dark:bg-zinc-900 shadow-md hover:shadow-lg transition-all duration-200 flex flex-col overflow-hidden">
        <div className="absolute top-2 left-2 bg-white/80 dark:bg-zinc-800/80 p-1 rounded-full shadow-md">
          {icon}
        </div>

        {item.thumbnail ? (
          <div className="w-full h-32 bg-zinc-100 dark:bg-zinc-800">
            <img src={item.thumbnail} alt="Thumbnail" className="w-full h-full object-cover" />
          </div>
        ) : (
          <div className="w-full h-32 bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
            <div className="w-12 h-12 rounded-full bg-zinc-200 dark:bg-zinc-700 flex items-center justify-center shadow-inner">
              <File className="w-6 h-6 text-zinc-500 dark:text-zinc-400" />
            </div>
          </div>
        )}

        <div className="flex flex-col items-center text-center px-3 py-2 gap-1">
          <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100 truncate w-full">
            {item.file?.name || item.name || item.directoryPath}
          </span>
          <div className="w-full h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden shadow-inner">
            <div
              className="h-full bg-orange-500 transition-all duration-300"
              style={{ width: `${item.progress || 0}%` }}
            />
          </div>
          <div className="w-full flex justify-between text-[11px] text-zinc-500 dark:text-zinc-400 mt-1 font-medium">
            <span>{item.progress}%</span>
            <span>{statusLabels[item.status] || item.status}</span>
          </div>
        </div>

        <div className="w-full flex justify-center items-center gap-2 py-2 mb-1">
          {isReceive ? (
            <>
              {item.status !== 'done' && item.status !== 'canceled' && (
                <button
                  className="rounded-full p-1.5 bg-red-50 dark:bg-red-900/30 hover:bg-red-100 dark:hover:bg-red-900/50 text-red-500 dark:text-red-400 border border-red-200 dark:border-red-800 transition"
                  onClick={() => cancelTransfer?.(item.transferId)}
                  title="Cancel"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
              {item.status === 'done' && item.downloaded ? (
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400 font-semibold">
                  Downloaded
                </p>
              ) : (
                item.status === 'done' &&
                !autoDownload &&
                item.blobUrl && (
                  <button
                    className="rounded-full p-1.5 bg-blue-50 dark:bg-blue-900/30 hover:bg-blue-100 dark:hover:bg-blue-900/50 text-blue-500 dark:text-blue-400 border border-blue-200 dark:border-blue-800 transition"
                    onClick={() => fileDownload?.(item)}
                    title="Download"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                )
              )}
            </>
          ) : (
            <>
              {item.status === 'paused' && (
                <button
                  className="rounded-full p-1.5 bg-green-50 dark:bg-green-900/30 hover:bg-green-100 dark:hover:bg-green-900/50 text-green-600 dark:text-green-400 border border-green-200 dark:border-green-800 transition"
                  onClick={() => resumeTransfer?.(item.transferId)}
                  title="Resume"
                >
                  <Play className="w-4 h-4" />
                </button>
              )}
              {item.status === 'sending' && (
                <button
                  className="rounded-full p-1.5 bg-yellow-50 dark:bg-yellow-900/30 hover:bg-yellow-100 dark:hover:bg-yellow-900/50 text-yellow-600 dark:text-yellow-400 border border-yellow-200 dark:border-yellow-800 transition"
                  onClick={() => pauseTransfer?.(item.transferId)}
                  title="Pause"
                >
                  <Pause className="w-4 h-4" />
                </button>
              )}
              {item.status !== 'done' && item.status !== 'canceled' && (
                <button
                  className="rounded-full p-1.5 bg-red-50 dark:bg-red-900/30 hover:bg-red-100 dark:hover:bg-red-900/50 text-red-500 dark:text-red-400 border border-red-200 dark:border-red-800 transition"
                  onClick={() => cancelTransfer?.(item.transferId)}
                  title="Cancel"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </>
          )}
        </div>
      </div>
    );
  },
  (prev, next) => {
    // Only re-render if progress or status changes
    return (
      prev.item.progress === next.item.progress &&
      prev.item.status === next.item.status &&
      prev.item.downloaded === next.item.downloaded &&
      prev.autoDownload === next.autoDownload
    );
  },
);

TransferCard.displayName = 'TransferCard';

export function QueueTray({
  title,
  items,
  pauseTransfer,
  fileDownload,
  autoDownload,
  setAutoDownload,
  resumeTransfer,
  cancelTransfer,
}: QueueTrayProp) {
  const [show, setShow] = useState(false);
  const [fsSupported] = useState(() => supportsFSAccess());
  const [savedTo, setSavedTo] = useState<string | null>(
    hasSaveDirectory() ? saveDirectoryName() : null,
  );

  useEffect(() => {
    setSavedTo(hasSaveDirectory() ? saveDirectoryName() : null);
  }, [show]);

  return (
    <div className="bg-white dark:bg-zinc-900 relative rounded-2xl shadow-sm p-4 border dark:border-zinc-800">
      <h3 className="text-lg font-semibold mb-4 dark:text-zinc-100">{title}</h3>

      <div className="absolute top-3 right-4 flex gap-2">
        {typeof autoDownload !== 'undefined' && (
          <button className="text-xs font-medium text-orange-500" onClick={() => setShow(true)}>
            Auto Download?
          </button>
        )}
      </div>

      {show && typeof autoDownload !== 'undefined' && (
        <div className="absolute top-8 right-2 z-50 max-w-102 rounded-xl border dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 shadow-xl animate-fadeIn">
          <div className="flex justify-end mb-2">
            <button onClick={() => setShow(false)} className="dark:text-zinc-400">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center gap-2 mb-4">
            <Switch
              checked={autoDownload}
              onCheckedChange={setAutoDownload}
              id="auto-download-toggle"
            />
            <label htmlFor="auto-download-toggle" className="text-sm dark:text-zinc-200">
              Auto-download
            </label>
          </div>
          {!autoDownload && (
            <p className="text-sm text-orange-500 mb-2">
              Auto-download is off. Use download buttons below each file.
            </p>
          )}
          {fsSupported && (
            <div className="flex items-center gap-2 mb-4 pb-4 border-b dark:border-zinc-800">
              <button
                className="flex items-center gap-2 text-sm px-3 py-1.5 rounded-full border border-orange-400 text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-950/20 transition"
                onClick={async () => {
                  if (savedTo) {
                    clearSaveDirectory();
                    setSavedTo(null);
                  } else {
                    const name = await requestSaveDirectory();
                    setSavedTo(name);
                  }
                }}
              >
                <FolderOpen className="w-4 h-4" />
                {savedTo ? `Saving to: ${savedTo} (tap to unset)` : 'Save to folder'}
              </button>
            </div>
          )}
          <ul className="list-disc list-inside text-sm space-y-1 dark:text-zinc-400">
            <li>Use manual download if blocked.</li>
            <li className="text-orange-600">Use Opera if issue persists.</li>
            <li>Upload ZIPs for multiple small files.</li>
            <li>Start a fresh session if stuck.</li>
            <li>Large files (~500MB+) stream directly.</li>
          </ul>
        </div>
      )}

      <div className="flex gap-4 overflow-x-auto scrollbar-thin scrollbar-thumb-zinc-300 dark:scrollbar-thumb-zinc-700 p-2">
        {items.length === 0 ? (
          <div className="flex flex-col h-56 items-center justify-center w-full text-zinc-400 dark:text-zinc-600 py-8">
            <File className="w-8 h-8 mb-2" />
            <span className="text-sm">No transfers yet</span>
          </div>
        ) : (
          items.map((item) => (
            <TransferCard
              key={item.transferId}
              item={item}
              autoDownload={autoDownload}
              pauseTransfer={pauseTransfer}
              resumeTransfer={resumeTransfer}
              cancelTransfer={cancelTransfer}
              fileDownload={fileDownload}
            />
          ))
        )}
      </div>
    </div>
  );
}
