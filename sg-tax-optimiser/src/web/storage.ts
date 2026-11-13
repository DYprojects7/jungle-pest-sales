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

/** Returns false when the browser would not keep it (private window, blocked site data, full quota). */
export function writeStored(text: string): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, text);
    return true;
  } catch {
    // The calculator still works; it just forgets when the page is closed.
    return false;
  }
}

type HostTheme = 'light' | 'dark' | null;

function readThemeAttribute(): HostTheme {
  try {
    const value = document.documentElement.getAttribute('data-theme');
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

/**
 * The theme the page was given from outside: a host that embeds the calculator may put data-theme on <html>
 * itself. It is read before the calculator writes anything, and kept up to date if the host changes it later.
 */
let hostTheme: HostTheme = readThemeAttribute();
/** What the calculator last wrote, so its own writes are not mistaken for the host's. */
let ownTheme: HostTheme | undefined;

try {
  new MutationObserver(() => {
    const now = readThemeAttribute();
    if (ownTheme !== undefined && now === ownTheme) return;
    hostTheme = now;
    ownTheme = undefined;
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
} catch {
  // No observer: the theme found at start-up is used.
}

/**
 * The browser's own chrome (the address bar on a phone) is tinted by the theme-color metas in the page head,
 * one per colour scheme. When Light or Dark is chosen by hand, both are set to the page background of that
 * theme; on System each goes back to the value it was written with. A host page without these metas (the
 * artifact fragment) has nothing to update.
 */
function syncThemeColor(choice: ThemeChoice): void {
  try {
    const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
    if (metas.length === 0) return;
    const ground = choice === 'system' ? '' : getComputedStyle(document.documentElement).getPropertyValue('--ground').trim();
    metas.forEach((meta) => {
      if (!meta.dataset.default) meta.dataset.default = meta.content;
      meta.content = ground || meta.dataset.default || meta.content;
    });
  } catch {
    // The tint is a nicety.
  }
}

/**
 * Light and Dark set data-theme on <html>. System hands the attribute back to whoever had it before: it
 * restores the host's value when there was one, and removes the attribute otherwise so the device decides.
 */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  const want: HostTheme = choice === 'light' || choice === 'dark' ? choice : hostTheme;
  if (choice === 'system' && ownTheme === undefined) return; // nothing of ours to undo
  ownTheme = choice === 'system' ? undefined : want;
  if (readThemeAttribute() !== want) {
    if (want) root.setAttribute('data-theme', want);
    else root.removeAttribute('data-theme');
  }
  syncThemeColor(choice);
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
