import { ArrowDown, ArrowUp, Download, Upload } from 'lucide-react';

export interface TransferMetrics {
  totalSent: number;
  totalReceived: number;
  sendSpeedBps: number;
  receiveSpeedBps: number;
}

function formatSpeed(bps: number): string {
  if (bps >= 1048576) return `${(bps / 1048576).toFixed(2)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(2)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  return `${(bytes / 1024).toFixed(2)} KiB`;
}

export function MetricsSection({ metrics }: { metrics: TransferMetrics }) {
  const cards = [
    {
      label: 'Sent',
      value: formatSize(metrics.totalSent),
      icon: Upload,
      tint: 'text-blue-500 bg-blue-400/20',
    },
    {
      label: 'Received',
      value: formatSize(metrics.totalReceived),
      icon: Download,
      tint: 'text-green-500 bg-green-400/20',
    },
    {
      label: 'Upload',
      value: formatSpeed(metrics.sendSpeedBps),
      icon: ArrowUp,
      tint: 'text-blue-600 bg-blue-500/10',
    },
    {
      label: 'Download',
      value: formatSpeed(metrics.receiveSpeedBps),
      icon: ArrowDown,
      tint: 'text-green-600 bg-green-500/10',
    },
  ];

  return (
    <dl className="grid grid-cols-2 lg:grid-cols-4 gap-3 p-4 sm:p-6 rounded-3xl">
      {cards.map(({ label, value, icon: Icon, tint }) => (
        <div
          key={label}
          className="rounded-2xl p-3 sm:p-4 flex flex-col justify-between shadow-sm border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900"
        >
          <div className="flex items-center justify-between mb-1">
            <dt className="text-[10px] sm:text-xs font-bold uppercase tracking-wider text-zinc-500">
              {label}
            </dt>
            <span className={`p-1.5 rounded-lg ${tint}`}>
              <Icon className="w-3.5 h-3.5" aria-hidden="true" />
            </span>
          </div>
          <dd className="text-sm sm:text-lg lg:text-xl font-black tabular-nums text-zinc-900 dark:text-zinc-100">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
