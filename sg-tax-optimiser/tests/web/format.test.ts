import { describe, expect, it } from 'vitest';
import {
  cents,
  centsPerDollar,
  countOf,
  dollars,
  finite,
  isBlank,
  listOf,
  localIsoDate,
  longDate,
  monthLabel,
  parseAmount,
  pct,
  plain,
  shortDate,
} from '../../src/web/format';

describe('money formatting', () => {
  it('writes whole dollars with thousands separators', () => {
    expect(dollars(23300)).toBe('S$23,300');
    expect(dollars(0)).toBe('S$0');
    expect(dollars(1234567)).toBe('S$1,234,567');
    expect(plain(15300)).toBe('15,300');
  });

  it('writes tax amounts with cents', () => {
    expect(cents(2679.5)).toBe('S$2,679.50');
    expect(cents(6639)).toBe('S$6,639.00');
    expect(cents(0)).toBe('S$0.00');
  });

  it('never shows NaN or Infinity', () => {
    expect(dollars(Number.NaN)).toBe('S$0');
    expect(cents(Number.POSITIVE_INFINITY)).toBe('S$0.00');
    expect(pct(Number.NaN)).toBe('0%');
    expect(finite(undefined)).toBe(0);
  });
});

describe('rates', () => {
  it('writes percentages without trailing zeros', () => {
    expect(pct(0.115)).toBe('11.5%');
    expect(pct(0.07)).toBe('7%');
    expect(pct(0.035)).toBe('3.5%');
    expect(pct(389 / 15400)).toBe('2.53%');
    expect(pct(2.5)).toBe('250%');
  });

  it('writes cents per dollar', () => {
    expect(centsPerDollar(0.115)).toBe('11.5 cents');
    expect(centsPerDollar(0.07)).toBe('7 cents');
    expect(centsPerDollar(0.01)).toBe('1 cent');
    expect(centsPerDollar(0)).toBe('0 cents');
  });
});

describe('parseAmount', () => {
  it('accepts digits and commas', () => {
    expect(parseAmount('10,000')).toBe(10000);
    expect(parseAmount('15300')).toBe(15300);
    expect(parseAmount(' 1,2,3 ')).toBe(123);
  });

  it('treats empty or unreadable text as 0 and drops cents', () => {
    expect(parseAmount('')).toBe(0);
    expect(parseAmount('abc')).toBe(0);
    expect(parseAmount('1,234.56')).toBe(1234);
    expect(parseAmount('-500')).toBe(500);
    expect(isBlank('  ,')).toBe(true);
    expect(isBlank('0')).toBe(false);
  });
});

describe('dates and lists', () => {
  it('formats ISO dates without a time zone shift', () => {
    expect(shortDate('2026-12-31')).toBe('31 Dec 2026');
    expect(longDate('2026-12-31')).toBe('31 December 2026');
    expect(monthLabel('2026-11')).toBe('Nov 2026');
    expect(localIsoDate(new Date(2026, 10, 3))).toBe('2026-11-03');
  });

  it('joins and counts', () => {
    expect(listOf(['a'])).toBe('a');
    expect(listOf(['a', 'b'])).toBe('a and b');
    expect(listOf(['a', 'b', 'c'])).toBe('a, b and c');
    expect(countOf(1, 'day')).toBe('1 day');
    expect(countOf(48, 'day')).toBe('48 days');
  });
});
