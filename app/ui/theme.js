// Theme preference: 'system' (default), 'light' or 'dark'. CSS does the work (tokens.css); this only sets
// <html data-theme> and keeps the browser chrome colour (theme-color) in step.
const CHROME = { light: '#eff1ee', dark: '#1d1713' };

export function applyTheme(pref = 'system') {
  const root = document.documentElement;
  if (pref === 'light' || pref === 'dark') root.dataset.theme = pref; else delete root.dataset.theme;
  const metas = [...document.querySelectorAll('meta[name="theme-color"]')];
  for (const m of metas) {
    m.dataset.orig ??= m.content;
    m.content = pref === 'system' ? m.dataset.orig : CHROME[pref];
  }
}
