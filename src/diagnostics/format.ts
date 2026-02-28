const ANSI = {
  reset: '\u001B[0m',
  dim: '\u001B[2m',
  red: '\u001B[31m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  blue: '\u001B[34m',
  magenta: '\u001B[35m',
  cyan: '\u001B[36m',
  gray: '\u001B[90m',
} as const;

export type AnsiColor = keyof typeof ANSI;

export function supportsColor(enabledByOption: boolean): boolean {
  if (!enabledByOption) return false;
  if (process.env.NO_COLOR) return false;
  return process.stdout.isTTY === true;
}

export function colorize(text: string, color: AnsiColor, enabled: boolean): string {
  if (!enabled) return text;
  if (!ANSI[color]) return text;
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

export function dim(text: string, enabled: boolean): string {
  return colorize(text, 'dim', enabled);
}

export function parseDateToTimestamp(value: string, optionName: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${optionName} value "${value}". Expected an ISO-8601 date/time.`);
  }
  return parsed;
}

export function parsePositiveInt(rawValue: string | undefined, fallback: number, optionName: string): number {
  if (rawValue === undefined) return fallback;
  const parsed = Number.parseInt(String(rawValue), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${optionName} value "${rawValue}". Expected a positive integer.`);
  }
  return parsed;
}

export function formatDurationHours(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return '0h';
  if (hours < 1) {
    const minutes = Math.round(hours * 60);
    return `${minutes}m`;
  }
  if (hours < 24) {
    return `${hours.toFixed(2)}h`;
  }
  return `${(hours / 24).toFixed(2)}d`;
}

export function inferPrimitiveTypeFromPath(targetPath: string): string | null {
  const normalized = String(targetPath).replace(/\\/g, '/');
  const segment = normalized.split('/')[0]?.trim();
  if (!segment) return null;
  if (!normalized.endsWith('.md')) return null;
  const singular = segment.endsWith('s') ? segment.slice(0, -1) : segment;
  return singular || null;
}
