/**
 * Browser-only helpers: localStorage (always inside try/catch; the page works when it throws),
 * the theme attribute, and the clipboard.
 */
import { STORAGE_KEY } from './state';
import type { ThemeChoice } from './state';

export function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeStored(text: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, text);
  } catch {
    // Private window, blocked site data or a full quota: the calculator still works, it just forgets.
  }
}

/** "system" removes the attribute so the device setting decides; otherwise the choice wins both ways. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'light' || choice === 'dark') root.setAttribute('data-theme', choice);
  else root.removeAttribute('data-theme');
}

/**
 * Copy text from inside a click handler. Resolves false when the browser refuses, so the caller can
 * show the text selected for a manual copy.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Scroll a section into view and move keyboard focus to it. */
export function goTo(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  if (el instanceof HTMLDetailsElement) el.open = true;
  el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
}
