// Launches the packaged app (release/win-unpacked) with an isolated data dir and prints the top bar.
// Usage: node scripts/packaged-check.mjs <dataDir>
import { _electron as electron } from 'playwright';
const dir = process.argv[2];
const app = await electron.launch({ executablePath: 'release/win-unpacked/Claude Editor.exe', env: { ...process.env, CLAUDE_EDITOR_DATA: dir } });
const win = await app.firstWindow();
await win.waitForSelector('.topbar', { timeout: 30000 });
await win.waitForTimeout(3000);
const auth = await win.$eval('.topbar', (e) => e.innerText.replace(/\n/g, ' '));
console.log('packaged ok:', auth);
await app.close();
