// Android launcher icons of MPI Remote from the editor's icon (build/icon.png): legacy square + round, adaptive
// foreground (the icon inside the 66% safe zone) on the icon's navy background. Run with Electron:
//   electron scripts/android-icons.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const RES = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.png')).toString('base64');
const BG = '#172139';
const SIZES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html,<canvas></canvas>');
  const render = (size, kind) =>
    w.webContents.executeJavaScript(`(async () => {
      const img = new Image(); img.src = 'data:image/png;base64,${SRC}'; await img.decode();
      const c = document.createElement('canvas'); c.width = c.height = ${size}; const g = c.getContext('2d');
      const kind = '${kind}', s = ${size};
      if (kind === 'square') g.drawImage(img, 0, 0, s, s);
      if (kind === 'round') { g.beginPath(); g.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2); g.clip(); g.fillStyle = '${BG}'; g.fillRect(0, 0, s, s); const k = 1.12; g.drawImage(img, s * (1 - k) / 2, s * (1 - k) / 2, s * k, s * k); }
      if (kind === 'fg') { const k = 0.74; g.drawImage(img, s * (1 - k) / 2, s * (1 - k) / 2, s * k, s * k); }
      return c.toDataURL('image/png').split(',')[1];
    })()`);
  for (const [d, px] of Object.entries(SIZES)) {
    const dir = path.join(RES, 'mipmap-' + d);
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), Buffer.from(await render(px, 'square'), 'base64'));
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), Buffer.from(await render(px, 'round'), 'base64'));
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), Buffer.from(await render(Math.round((px * 108) / 48), 'fg'), 'base64'));
  }
  const bgFile = path.join(RES, 'values', 'ic_launcher_background.xml');
  fs.writeFileSync(bgFile, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BG}</color>\n</resources>\n`);
  console.log('icons written');
  app.quit();
});
