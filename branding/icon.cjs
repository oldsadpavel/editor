// Renders src/renderer/assets/mpi-logo.svg to build/icon.png (1024×1024, transparent corners) — electron-builder makes
// the Windows .ico and the macOS .icns from it. Usage: npx electron branding/icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const SIZE = 1024;
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '../src/renderer/assets/mpi-logo.svg'), 'utf8');
  const html = `<html><body style="margin:0;background:transparent"><div style="width:${SIZE}px;height:${SIZE}px">${svg.replace('<svg ', `<svg width="${SIZE}" height="${SIZE}" `)}</div></body></html>`;
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, transparent: true, frame: false, backgroundColor: '#00000000', webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  // the logo's rounded square spans 24…232 of 256: crop the margin so the icon fills its tile like other apps
  const crop = img.crop({ x: Math.round((SIZE * 16) / 256), y: Math.round((SIZE * 16) / 256), width: Math.round((SIZE * 224) / 256), height: Math.round((SIZE * 224) / 256) }).resize({ width: SIZE, height: SIZE, quality: 'best' });
  fs.mkdirSync(path.join(__dirname, '../build'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '../build/icon.png'), crop.toPNG());
  fs.writeFileSync(path.join(__dirname, 'icon-preview-64.png'), crop.resize({ width: 64, height: 64, quality: 'best' }).toPNG());
  app.quit();
});
