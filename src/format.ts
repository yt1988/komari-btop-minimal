export type MetricTone = 'normal' | 'warning';

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;
const SPEED_UNITS = ['KB', 'MB', 'GB', 'TB', 'PB'] as const;
const TRAFFIC_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;
const MIB = 1024 ** 2;

function finiteNonNegative(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function formatScaled(
  value: number | null | undefined,
  units: readonly string[],
  suffix: string,
): string {
  const safeValue = finiteNonNegative(value);
  if (safeValue === null) {
    return '--';
  }

  let scaled = safeValue;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }

  const unit = units[unitIndex] ?? units[0] ?? 'B';
  if (unitIndex === 0) {
    return `${Math.round(scaled)} ${unit}${suffix}`;
  }
  return `${scaled.toFixed(1)} ${unit}${suffix}`;
}

export function formatBytes(value: number | null | undefined): string {
  return formatScaled(value, BYTE_UNITS, '');
}

export function formatSpeed(value: number | null | undefined): string {
  const safeValue = finiteNonNegative(value);
  if (safeValue === null) {
    return '--';
  }

  let scaled = safeValue / 1024;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < SPEED_UNITS.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }

  const unit = SPEED_UNITS[unitIndex] ?? SPEED_UNITS[0];
  return `${scaled === 0 ? '0' : scaled.toFixed(1)} ${unit}/s`;
}

export function formatTraffic(value: number | null | undefined): string {
  const safeValue = finiteNonNegative(value);
  if (safeValue === null) {
    return '--';
  }

  let scaled = safeValue / 1024;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < TRAFFIC_UNITS.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }

  const unit = TRAFFIC_UNITS[unitIndex] ?? TRAFFIC_UNITS[0];
  return `${scaled === 0 ? '0' : scaled.toFixed(1)} ${unit}`;
}

export function formatPercent(value: number | null | undefined): string {
  const safeValue = finiteNonNegative(value);
  if (safeValue === null) {
    return '--';
  }
  return `${Math.round(Math.min(100, safeValue))}%`;
}

export function progressBar(valueOrRatio: number, totalOrWidth: number, width?: number): string {
  const resolvedWidth = width ?? totalOrWidth;
  if (!Number.isInteger(resolvedWidth) || resolvedWidth <= 0) {
    return '';
  }

  const ratio = width === undefined
    ? resolvedWidth > 0 ? valueOrRatio / resolvedWidth : 0
    : totalOrWidth > 0
      ? valueOrRatio / totalOrWidth
      : 0;
  const safeRatio = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  const filled = Math.round(safeRatio * resolvedWidth);
  return '█'.repeat(filled) + '░'.repeat(resolvedWidth - filled);
}

export function metricTone(value: number | null | undefined): MetricTone {
  return typeof value === 'number' && Number.isFinite(value) && value > 70 ? 'warning' : 'normal';
}

export function networkTone(bytesPerSecond: number | null | undefined): MetricTone {
  return typeof bytesPerSecond === 'number'
    && Number.isFinite(bytesPerSecond)
    && bytesPerSecond > MIB
    ? 'warning'
    : 'normal';
}

/** Compact duration: `47m`, `1h5m`, `2d3h`. */
export function formatDuration(milliseconds: number | null | undefined): string {
  const safeValue = finiteNonNegative(milliseconds);
  if (safeValue === null) {
    return '--';
  }
  const minutes = Math.max(1, Math.round(safeValue / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days}d` : `${days}d${rest}h`;
}

/** Wall-clock `HH:MM`. */
export function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatTimestamp(timestamp: number | null | undefined): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return '--:--:--';
  }
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

