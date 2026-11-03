// Renders branding/logos.html to branding/logos.png with Electron (offscreen). Usage: npx electron branding/render.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 300, show: false, webPreferences: { offscreen: true } });
  await win.loadFile(path.join(__dirname, process.argv[2] || 'logos.html'));
  await new Promise((r) => setTimeout(r, 600));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, process.argv[3] || 'logos.png'), img.toPNG());
  app.quit();
});
