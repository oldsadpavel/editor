// Splash screens of MPI Remote: the editor's icon in the middle of its navy background (replaces Capacitor's logo).
//   electron scripts/android-splash.cjs
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const RES = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.png')).toString('base64');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html,<canvas></canvas>');
  let n = 0;
  for (const d of fs.readdirSync(RES).filter((x) => x.startsWith('drawable'))) {
    const f = path.join(RES, d, 'splash.png');
    if (!fs.existsSync(f)) continue;
    const { width, height } = nativeImage.createFromPath(f).getSize();
    const b64 = await w.webContents.executeJavaScript(`(async () => {
      const img = new Image(); img.src = 'data:image/png;base64,${SRC}'; await img.decode();
      const c = document.createElement('canvas'); c.width = ${width}; c.height = ${height}; const g = c.getContext('2d');
      g.fillStyle = '#172139'; g.fillRect(0, 0, c.width, c.height);
      const s = Math.min(c.width, c.height) * 0.42; g.drawImage(img, (c.width - s) / 2, (c.height - s) / 2, s, s);
      return c.toDataURL('image/png').split(',')[1];
    })()`);
    fs.writeFileSync(f, Buffer.from(b64, 'base64'));
    n++;
  }
  console.log('splash written', n);
  app.quit();
});
