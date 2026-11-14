// Inline SVG icons (stroke style, 24px grid). Paths are static strings written here, never user data.
const P = {
  home: '<path d="M4 11.2 12 4l8 7.2V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>',
  brew: '<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H15.6"/><path d="M9 3.5c-.8 1 .8 1.6 0 2.8M12.5 3.5c-.8 1 .8 1.6 0 2.8"/>',
  journal: '<path d="M6 4h11a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6z"/><path d="M6 4v16M9.5 8.5H15M9.5 12H15"/>',
  learn: '<path d="M12 3.5a6 6 0 0 0-3.4 10.9c.6.5.9 1 .9 1.7V17h5v-.9c0-.7.3-1.2.9-1.7A6 6 0 0 0 12 3.5z"/><path d="M10 20h4"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  bolt: '<path d="m13 3-7 10h5l-1 8 7-10h-5z"/>',
  battery: '<rect x="3" y="8" width="16" height="8" rx="2"/><path d="M21 11v2"/>',
  bluetooth: '<path d="m7 7 10 10-5 4V3l5 4L7 17"/>',
  // methods
  espresso: '<path d="M5 10h12v3.5a5.5 5.5 0 0 1-5.5 5.5h-1A5.5 5.5 0 0 1 5 13.5z"/><path d="M17 11.5h1.2a2.3 2.3 0 0 1 0 4.6H16.6"/><path d="M4 21h14"/>',
  'pour-over': '<path d="M5 5h14l-5 7v3h-4v-3z"/><path d="M7 20h10M12 15v5"/>',
  'french-press': '<rect x="6" y="8" width="10" height="12" rx="1.5"/><path d="M11 3v8M8.5 3h5M16 11h2.5a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5H16"/>',
  aeropress: '<path d="M9 3h6v8H9zM8 11h8v10H8z"/><path d="M8 15h8"/>',
  moka: '<path d="m8 4 1 4h6l1-4zM9 8l-2 12h10L15 8z"/><path d="M12 12v4"/>',
  prestina: '<path d="M7 20h10M8 20V8h8v12M10 8V4h4v4"/><path d="M8 13h8"/>',
};
export function icon(name, { size = 24, label } = {}) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ${label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"'}>${P[name] ?? ''}</svg>`;
  return span;
}
