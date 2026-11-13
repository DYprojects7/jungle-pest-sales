/**
 * Web fonts are a nicety, never a dependency. The Google Fonts stylesheet is added by script once the page
 * has loaded and painted, so the calculator renders, runs and finishes loading with system fonts even when
 * the fonts host is slow, blocked or hanging. A <link rel="stylesheet"> in the HTML head would hold back the
 * first paint and this script until that host answered.
 */
const FONTS_URL =
  'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,400..800' +
  '&family=Inter:opsz,wght@14..32,400..700&display=swap';

function addStylesheet(): void {
  try {
    if (document.querySelector('link[data-web-fonts]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = FONTS_URL;
    link.setAttribute('data-web-fonts', 'pending');
    link.addEventListener('load', () => link.setAttribute('data-web-fonts', 'loaded'));
    link.addEventListener('error', () => link.setAttribute('data-web-fonts', 'failed'));
    document.head.appendChild(link);
  } catch {
    // The page keeps its system fonts.
  }
}

/** Ask for the web fonts without letting them hold anything up. Safe to call more than once. */
export function loadWebFonts(): void {
  // After the load event, so a host that never answers cannot keep the page "loading"; then one frame
  // later, so the first paint is never waiting on it either.
  const afterPaint = (): void => {
    const later = (): void => {
      window.setTimeout(addStylesheet, 0);
    };
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(later);
    else later();
  };
  if (document.readyState === 'complete') afterPaint();
  else window.addEventListener('load', afterPaint, { once: true });
}
