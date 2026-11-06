// Renders the app's icons from SVG: the app icon (electron-builder makes the .ico from it), the tray icon, and the
// buttons shown under the taskbar thumbnail (previous, play, pause, next).
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const root = path.join(__dirname, '..');
const NOTE = 'M12 4.6v8.3c-.46-.27-1-.43-1.57-.43-1.74 0-3.15 1.41-3.15 3.15s1.41 3.15 3.15 3.15 3.15-1.41 3.15-3.15V7.75h3.15V4.6h-4.73z';
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11.5" fill="#1ED760"/><path fill="#0B0B0C" d="${NOTE}"/></svg>`;
const glyph = d => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#FFFFFF" d="${d}"/></svg>`;
const GLYPHS = {
  play: 'M7.05 3.606l13.49 7.788a.7.7 0 0 1 0 1.212L7.05 20.394A.7.7 0 0 1 6 19.788V4.212a.7.7 0 0 1 1.05-.606z',
  pause: 'M5.5 3.5h4.5v17H5.5zM14 3.5h4.5v17H14z',
  prev: 'M5 4.5h2.2v15H5zM20 5.6v12.8a.6.6 0 0 1-.93.5L9.6 12.5a.6.6 0 0 1 0-1L19.07 5.1a.6.6 0 0 1 .93.5z',
  next: 'M16.8 4.5H19v15h-2.2zM4 5.6v12.8a.6.6 0 0 0 .93.5l9.47-6.4a.6.6 0 0 0 0-1L4.93 5.1a.6.6 0 0 0-.93.5z',
};

function png(svg, size, out) {
  const data = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
}

png(logo, 512, path.join(root, 'build', 'icon.png'));
png(logo, 256, path.join(root, 'assets', 'icon.png'));
png(logo, 32, path.join(root, 'assets', 'tray.png'));
png(logo, 64, path.join(root, 'assets', 'tray@2x.png'));
for (const [name, d] of Object.entries(GLYPHS)) {
  png(glyph(d), 16, path.join(root, 'assets', `${name}.png`));
  png(glyph(d), 32, path.join(root, 'assets', `${name}@2x.png`));
}
console.log('icons rendered');
