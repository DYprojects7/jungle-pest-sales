import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import { localIsoDate } from './format';

/**
 * The device's local date (YYYY-MM-DD), kept current while the page stays open. A tab left open over the last
 * fortnight of the year must not go on showing an old countdown, or a live instruction after the deadline. The
 * date is read again whenever the page comes back into view or takes focus, and once a minute; the value only
 * changes when the calendar day does, so nothing is recalculated in between.
 */
export function useToday(): string {
  const [today, setToday] = useState<string>(() => localIsoDate());
  useEffect(() => {
    const check = (): void => {
      const now = localIsoDate();
      setToday((prev) => (prev === now ? prev : now));
    };
    check();
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    window.addEventListener('pageshow', check);
    const timer = window.setInterval(check, 60_000);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
      window.removeEventListener('pageshow', check);
      window.clearInterval(timer);
    };
  }, []);
  return today;
}

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

/**
 * Keeps one line of text inside its box. The CSS sizes the text for the fonts the page asks for; when a wider
 * fallback is in use and the line would spill out, the font size is scaled down until it fits. Runs again when
 * the box changes width, when web fonts arrive, and whenever `key` (the text) changes.
 */
export function useFitText(ref: RefObject<HTMLElement | null>, key: string): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    let lastWidth = -1;
    const fit = (): void => {
      el.style.fontSize = '';
      const room = el.clientWidth;
      const need = el.scrollWidth;
      if (room > 0 && need > room + 0.5) {
        const size = Number.parseFloat(window.getComputedStyle(el).fontSize);
        if (Number.isFinite(size) && size > 0) el.style.fontSize = `${Math.floor(((size * room) / need) * 10) / 10}px`;
      }
    };
    fit();
    const cleanups: (() => void)[] = [];
    const box = el.parentElement;
    if (box && typeof ResizeObserver !== 'undefined') {
      let frame = 0;
      const observer = new ResizeObserver((entries) => {
        const width = Math.round(entries[0]?.contentRect.width ?? 0);
        if (width === lastWidth) return; // only a change of width can change the fit
        lastWidth = width;
        // Refit on the next frame: resizing text inside the observer's own callback changes the box it is
        // watching, which browsers report as a ResizeObserver loop.
        window.cancelAnimationFrame(frame);
        frame = window.requestAnimationFrame(fit);
      });
      observer.observe(box);
      cleanups.push(() => {
        observer.disconnect();
        window.cancelAnimationFrame(frame);
      });
    } else {
      window.addEventListener('resize', fit);
      cleanups.push(() => window.removeEventListener('resize', fit));
    }
    try {
      const fonts = document.fonts;
      fonts.addEventListener('loadingdone', fit);
      cleanups.push(() => fonts.removeEventListener('loadingdone', fit));
    } catch {
      // No font loading events: the size found at start-up stands.
    }
    return () => cleanups.forEach((stop) => stop());
  }, [ref, key]);
}

/** Which sides of a sideways-scrolling box still have content out of view. Both false when everything fits. */
export interface ScrollEdges {
  left: boolean;
  right: boolean;
}

/**
 * Tracks whether a box scrolls sideways and which way there is more to see, so the page can show a cue on that
 * side. Updates when the box or its content changes size and as the box is scrolled.
 */
export function useScrollEdges(ref: RefObject<HTMLElement | null>): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ left: false, right: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = (): void => {
      const spare = el.scrollWidth - el.clientWidth;
      const left = spare > 1 && el.scrollLeft > 1;
      const right = spare > 1 && el.scrollLeft < spare - 1;
      setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    let stop: () => void;
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      stop = () => window.removeEventListener('resize', measure);
    } else {
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      if (el.firstElementChild) observer.observe(el.firstElementChild);
      stop = () => observer.disconnect();
    }
    return () => {
      el.removeEventListener('scroll', measure);
      stop();
    };
  }, [ref]);
  return edges;
}

/**
 * Whether an element is on screen, ignoring a strip of `bottomInset` pixels at the bottom edge (the space a
 * fixed bar covers). null until it is known, or where the browser cannot tell.
 */
export function useOnScreen(ref: RefObject<HTMLElement | null>, bottomInset: number): boolean | null {
  const [seen, setSeen] = useState<boolean | null>(null);
  const watched = useRef<HTMLElement | null>(null);
  const stop = useRef<(() => void) | null>(null);
  // No dependency list: the element can be replaced between renders, so check on each one.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === watched.current) return;
    stop.current?.();
    stop.current = null;
    watched.current = el;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setSeen(null);
      return;
    }
    const box = el.getBoundingClientRect();
    setSeen(box.bottom > 0 && box.top < window.innerHeight - bottomInset);
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        if (last) setSeen(last.isIntersecting);
      },
      { rootMargin: `0px 0px -${bottomInset}px 0px` },
    );
    observer.observe(el);
    stop.current = () => observer.disconnect();
  });
  useEffect(() => () => stop.current?.(), []);
  return seen;
}
