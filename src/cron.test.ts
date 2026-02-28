import { describe, it, expect } from 'vitest';
import { parseCronExpression, matchesCronSchedule, nextCronMatch } from './cron.js';

describe('cron parser', () => {
  it('parses 5-field cron expressions and matches date values', () => {
    const schedule = parseCronExpression('*/15 9-17 * * 1-5');
    const matching = new Date('2026-03-02T09:30:00.000Z'); // Monday
    const notMatchingMinute = new Date('2026-03-02T09:31:00.000Z');
    const notMatchingDow = new Date('2026-03-01T09:30:00.000Z'); // Sunday

    expect(matchesCronSchedule(schedule, matching)).toBe(true);
    expect(matchesCronSchedule(schedule, notMatchingMinute)).toBe(false);
    expect(matchesCronSchedule(schedule, notMatchingDow)).toBe(false);
  });

  it('supports Sunday as 0 or 7 and computes next match', () => {
    const schedule = parseCronExpression('0 0 * * 7');
    const sunday = new Date('2026-03-01T00:00:00.000Z');
    expect(matchesCronSchedule(schedule, sunday)).toBe(true);

    const next = nextCronMatch(schedule, new Date('2026-03-01T00:00:00.000Z'));
    expect(next).toBeDefined();
    expect(next?.toISOString().startsWith('2026-03-08T00:00:00.000Z')).toBe(true);
  });

  it('rejects malformed expressions', () => {
    expect(() => parseCronExpression('* * * *')).toThrow('Expected 5 fields');
    expect(() => parseCronExpression('61 * * * *')).toThrow('out of range');
    expect(() => parseCronExpression('*/0 * * * *')).toThrow('step');
  });
});
