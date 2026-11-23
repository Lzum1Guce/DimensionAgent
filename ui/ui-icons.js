// Unified 1.5px stroke monochrome SVG icon set for DimensionAgent 0.4.7 Studio Polish.
// Replaces inconsistent OS-dependent colorful Emojis with pixel-aligned vector icons.

const PATHS = {
  folder: '<path d="M2.25 4.5A1.5 1.5 0 0 1 3.75 3h2.6a1.5 1.5 0 0 1 1.15.54l.9 1.08h3.85a1.5 1.5 0 0 1 1.5 1.5v5.63a1.5 1.5 0 0 1-1.5 1.5h-8.5a1.5 1.5 0 0 1-1.5-1.5V4.5Z"/>',
  folderOpen: '<path d="M2.25 4.5A1.5 1.5 0 0 1 3.75 3h2.45a1.5 1.5 0 0 1 1.15.54l.85 1.01h3.8a1.5 1.5 0 0 1 1.5 1.5v.95"/><path d="M2.3 12.25 3.65 7.5A1.25 1.25 0 0 1 4.85 6.6h8.3a1 1 0 0 1 .96 1.27l-1.18 4.2a1.5 1.5 0 0 1-1.44 1.1H3.5a1.25 1.25 0 0 1-1.2-1.92Z"/>',
  box: '<path d="M8 1.85 13.5 4.9v6.2L8 14.15 2.5 11.1V4.9L8 1.85Z"/><path d="M2.5 4.9 8 7.95 13.5 4.9"/><path d="M8 7.95v6.2"/>',
  archive: '<rect x="2.25" y="2.75" width="11.5" height="3" rx="1"/><path d="M3.25 5.75v6.25a1.5 1.5 0 0 0 1.5 1.5h6.5a1.5 1.5 0 0 0 1.5-1.5V5.75"/><path d="M6.5 8.5h3"/>',
  eye: '<path d="M1.75 8s2.3-4.25 6.25-4.25S14.25 8 14.25 8s-2.3 4.25-6.25 4.25S1.75 8 1.75 8Z"/><circle cx="8" cy="8" r="1.85"/>',
  download: '<path d="M8 2.5v7.25"/><path d="m5.25 7.25 2.75 2.75 2.75-2.75"/><path d="M3 12.75h10"/>',
  file: '<path d="M4.25 2.25h4.8L12.25 5.4v8.35a1.25 1.25 0 0 1-1.25 1.25h-6.75A1.25 1.25 0 0 1 3 13.75v-10.25a1.25 1.25 0 0 1 1.25-1.25Z"/><path d="M8.75 2.25v3.25H12"/>',
  pin: '<path d="m9.8 2.4 3.8 3.8-1.4 1.4-1.05-.35-2.3 2.3.35 2.15-1.15 1.15-2.6-2.6-2.7 2.7m5.3-5.3-2.6-2.6 1.15-1.15 2.15.35 2.3-2.3-.35-1.05 1.4-1.4Z"/>',
  paperclip: '<path d="m13.1 7.35-5.2 5.2a3.25 3.25 0 0 1-4.6-4.6l5.45-5.45a2.15 2.15 0 1 1 3.05 3.05L6.55 10.8a1.05 1.05 0 0 1-1.5-1.5l4.65-4.65"/>',
  wrench: '<path d="M9.9 2.6a3.6 3.6 0 0 0-3.15 5.3L2.6 12.05a1.2 1.2 0 0 0 1.7 1.7L8.45 9.6a3.6 3.6 0 0 0 5.3-3.15l-2.1 2.1-1.9-.4-.4-1.9 2.1-2.1a3.6 3.6 0 0 0-1.55-.55Z"/>',
  sync: '<path d="M12.75 5.25H3.5m0 0L6 2.75M3.5 5.25 6 7.75"/><path d="M3.25 10.75h9.25m0 0L10 8.25m2.5 2.5L10 13.25"/>',
  sparkles: '<path d="M8 2.1 9.25 5.6 12.75 6.85 9.25 8.1 8 11.6 6.75 8.1 3.25 6.85 6.75 5.6 8 2.1Z"/><path d="M12.6 10.6 13.2 12.2 14.8 12.8 13.2 13.4 12.6 15 12 13.4 10.4 12.8 12 12.2 12.6 10.6Z"/>',
  chevronRight: '<path d="m6.25 3.75 4.25 4.25-4.25 4.25"/>',
  chevronDown: '<path d="m3.75 6.25 4.25 4.25 4.25-4.25"/>',
  plus: '<path d="M8 3.25v9.5M3.25 8h9.5"/>',
  check: '<path d="m3.25 8.25 3.1 3.1 6.4-6.7"/>',
  diff: '<path d="M5 3.25v5.5M2.25 6h5.5"/><path d="M8.5 11.5h5.25"/>',
  terminal: '<rect x="2" y="2.75" width="12" height="10.5" rx="1.75"/><path d="m5 6.25 2.25 2L5 10.25"/><path d="M8.5 10.25h2.5"/>',
};

export function svgIcon(name, size = 15) {
  const body = PATHS[name] || PATHS.file;
  return `<svg class="ui-svg-icon" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

export function iconNode(name, className = 'ui-icon-wrap', size = 15) {
  const span = document.createElement('span');
  if (className) span.className = className;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = svgIcon(name, size);
  return span;
}
