import { expect, it } from 'vitest';
import { formatDate } from '../src/core/presentation.js';

it('uses Paris local dates on both sides of daylight saving without changing the instant', () => {
  const winter = new Date('2026-01-01T23:30:00Z'), summer = new Date('2026-07-01T23:30:00Z');
  expect(formatDate(winter)).toBe('02/01/2026 00:30 (Europe/Paris)');
  expect(formatDate(summer)).toBe('02/07/2026 01:30 (Europe/Paris)');
  expect(winter.toISOString()).toBe('2026-01-01T23:30:00.000Z');
  expect(summer.toISOString()).toBe('2026-07-01T23:30:00.000Z');
});
