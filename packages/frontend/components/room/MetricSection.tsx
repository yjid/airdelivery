import { ArrowDown, ArrowUp, Gauge, Download, Upload } from 'lucide-react';

export function MetricsSection({ meta }: { meta: any }) {
  const formatSpeed = (bps: number) => {
    if (bps >= 1048576) return `${(bps / 1048576).toFixed(2)} MB/s`;
    if (bps >= 1024) return `${(bps / 1024).toFixed(2)} KB/s`;
    return `${bps} B/s`;
  };

  const formatSize = (bytes: number) => {
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(2)} GiB`;
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(2)} MiB`;
    return `${(bytes / 1024).toFixed(2)} KiB`;
  };

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 p-4 sm:p-6 rounded-3xl">
      <MetricCard
        label="Sent"
        value={formatSize(meta.totalSent)}
        icon={<Upload className="w-3.5 h-3.5 " />}
        iconBg="bg-blue-400/20 text-blue-600 dark:text-blue-400"
        cardBg="bg-white dark:bg-zinc-900"
      />
      <MetricCard
        label="Received"
        value={formatSize(meta.totalReceived)}
        icon={<Download className="w-3.5 h-3.5 " />}
        iconBg="bg-green-400/20 text-green-600 dark:text-green-400"
        cardBg="bg-white dark:bg-zinc-900"
      />
      <MetricCard
        label="Upload"
        value={formatSpeed(meta.sendSpeedBps)}
        icon={<ArrowUp className="w-3.5 h-3.5 " />}
        iconBg="bg-blue-500/10 text-blue-600 dark:text-blue-400"
        cardBg="bg-white dark:bg-zinc-900"
      />
      <MetricCard
        label="Download"
        value={formatSpeed(meta.receiveSpeedBps)}
        icon={<ArrowDown className="w-3.5 h-3.5 " />}
        iconBg="bg-green-500/10 text-green-600 dark:text-green-400"
        cardBg="bg-white dark:bg-zinc-900"
      />
    </div>
  );
}

function MetricCard({
  label,
  value,
  icon,
  iconBg,
  cardBg,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  iconBg: string;
  cardBg: string;
}) {
  return (
    <div
      className={`rounded-2xl p-3 sm:p-4 flex flex-col justify-between shadow-sm border border-zinc-200 dark:border-zinc-800 ${cardBg}`}
    >
      <div className="flex items-center justify-between mb-1 sm:mb-2">
        <span className="text-[10px] sm:text-xs text-zinc-500 dark:text-zinc-500 font-bold uppercase tracking-wider">
          {label}
        </span>
        <div className={`p-1.5 rounded-lg ${iconBg}`}>{icon}</div>
      </div>
      <span className="text-sm sm:text-lg lg:text-xl text-nowrap font-black text-zinc-900 dark:text-zinc-100 tabular-nums">
        {value}
      </span>
    </div>
  );
}
