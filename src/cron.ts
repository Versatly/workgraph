/**
 * Lightweight 5-field cron parsing and matching utilities.
 *
 * Supported field syntax:
 * - "*" (any value)
 * - step syntax (for example, star-slash-5 to mean every 5 units)
 * - "a,b,c" (list)
 * - "a-b" (range)
 * - "a-b/n" (range with step)
 * - "n" (single value)
 */

export interface CronField {
  all: boolean;
  values: Set<number>;
}

export interface CronSchedule {
  expression: string;
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

export function parseCronExpression(expression: string): CronSchedule {
  const normalized = String(expression ?? '').trim().replace(/\s+/g, ' ');
  const parts = normalized.split(' ');
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression "${expression}". Expected 5 fields.`);
  }

  return {
    expression: normalized,
    minute: parseField(parts[0], 0, 59, 'minute'),
    hour: parseField(parts[1], 0, 23, 'hour'),
    dayOfMonth: parseField(parts[2], 1, 31, 'day-of-month'),
    month: parseField(parts[3], 1, 12, 'month'),
    dayOfWeek: parseField(parts[4], 0, 7, 'day-of-week', (value) => (value === 7 ? 0 : value)),
  };
}

export function matchesCronSchedule(schedule: CronSchedule, date: Date): boolean {
  const minuteMatch = fieldMatches(schedule.minute, date.getMinutes());
  const hourMatch = fieldMatches(schedule.hour, date.getHours());
  const monthMatch = fieldMatches(schedule.month, date.getMonth() + 1);
  if (!minuteMatch || !hourMatch || !monthMatch) {
    return false;
  }

  const dayOfMonthMatch = fieldMatches(schedule.dayOfMonth, date.getDate());
  const dayOfWeekMatch = fieldMatches(schedule.dayOfWeek, date.getDay());

  // Cron semantics: when both DOM and DOW are restricted, either may match.
  if (schedule.dayOfMonth.all && schedule.dayOfWeek.all) {
    return true;
  }
  if (schedule.dayOfMonth.all) {
    return dayOfWeekMatch;
  }
  if (schedule.dayOfWeek.all) {
    return dayOfMonthMatch;
  }
  return dayOfMonthMatch || dayOfWeekMatch;
}

export function nextCronMatch(
  scheduleOrExpression: CronSchedule | string,
  after: Date,
  maxSearchMinutes: number = 366 * 24 * 60,
): Date | null {
  const schedule = typeof scheduleOrExpression === 'string'
    ? parseCronExpression(scheduleOrExpression)
    : scheduleOrExpression;

  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  for (let idx = 0; idx < maxSearchMinutes; idx += 1) {
    if (matchesCronSchedule(schedule, cursor)) {
      return new Date(cursor.getTime());
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

function fieldMatches(field: CronField, value: number): boolean {
  return field.all || field.values.has(value);
}

function parseField(
  rawField: string,
  min: number,
  max: number,
  fieldLabel: string,
  normalizeValue: (value: number) => number = (value) => value,
): CronField {
  const field = String(rawField ?? '').trim();
  if (!field) {
    throw new Error(`Invalid cron ${fieldLabel} field: empty value.`);
  }
  if (field === '*') {
    return {
      all: true,
      values: new Set(buildRange(min, max)),
    };
  }

  const values = new Set<number>();
  const segments = field.split(',');
  for (const segment of segments) {
    parseFieldSegment(segment.trim(), min, max, fieldLabel, values, normalizeValue);
  }

  if (values.size === 0) {
    throw new Error(`Invalid cron ${fieldLabel} field "${field}".`);
  }

  return { all: false, values };
}

function parseFieldSegment(
  rawSegment: string,
  min: number,
  max: number,
  fieldLabel: string,
  values: Set<number>,
  normalizeValue: (value: number) => number,
): void {
  if (!rawSegment) {
    throw new Error(`Invalid cron ${fieldLabel} field: empty segment.`);
  }

  const [base, stepRaw] = rawSegment.split('/');
  const step = stepRaw === undefined ? 1 : parseIntStrict(stepRaw, fieldLabel, rawSegment);
  if (step <= 0) {
    throw new Error(`Invalid cron ${fieldLabel} step "${stepRaw}" in segment "${rawSegment}".`);
  }

  if (base === '*') {
    for (let value = min; value <= max; value += step) {
      values.add(normalizeAndValidateValue(value, min, max, fieldLabel, normalizeValue));
    }
    return;
  }

  if (base.includes('-')) {
    const [startRaw, endRaw] = base.split('-');
    const start = parseIntStrict(startRaw, fieldLabel, rawSegment);
    const end = parseIntStrict(endRaw, fieldLabel, rawSegment);
    if (start > end) {
      throw new Error(`Invalid cron ${fieldLabel} range "${base}" in segment "${rawSegment}".`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(normalizeAndValidateValue(value, min, max, fieldLabel, normalizeValue));
    }
    return;
  }

  const value = parseIntStrict(base, fieldLabel, rawSegment);
  values.add(normalizeAndValidateValue(value, min, max, fieldLabel, normalizeValue));
}

function normalizeAndValidateValue(
  rawValue: number,
  min: number,
  max: number,
  fieldLabel: string,
  normalizeValue: (value: number) => number,
): number {
  if (rawValue < min || rawValue > max) {
    throw new Error(`Cron ${fieldLabel} value ${rawValue} out of range (${min}-${max}).`);
  }
  const normalized = normalizeValue(rawValue);
  if (normalized < min || normalized > max) {
    throw new Error(`Cron ${fieldLabel} normalized value ${normalized} out of range (${min}-${max}).`);
  }
  return normalized;
}

function parseIntStrict(raw: string, fieldLabel: string, segment: string): number {
  if (!/^-?\d+$/.test(String(raw))) {
    throw new Error(`Invalid cron ${fieldLabel} token "${raw}" in segment "${segment}".`);
  }
  return Number.parseInt(raw, 10);
}

function buildRange(min: number, max: number): number[] {
  const values: number[] = [];
  for (let value = min; value <= max; value += 1) {
    values.push(value);
  }
  return values;
}
