import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import type { RefObject } from 'preact';

/** Tracks a media query. Falls back to `initial` where matchMedia is unavailable. */
export function useMediaQuery(query: string, initial = false): boolean {
  const read = (): boolean => {
    try {
      return window.matchMedia(query).matches;
    } catch {
      return initial;
    }
  };
  const [matches, setMatches] = useState<boolean>(read);
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(query);
    } catch {
      return undefined;
    }
    const onChange = (): void => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** The rendered width of an element in CSS pixels, so the chart can be drawn at 1 unit = 1px. */
export function useElementWidth(ref: RefObject<HTMLElement | null>, fallback: number): number {
  const [width, setWidth] = useState<number>(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = (): void => {
      const w = el.clientWidth;
      if (w > 0) setWidth((prev) => (Math.abs(prev - w) >= 1 ? w : prev));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, fallback]);
  return width;
}

/** A value that only changes after it has been stable for `delay` ms (keeps announcements calm). */
export function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState<T>(value);
  useEffect(() => {
    const id = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return settled;
}
