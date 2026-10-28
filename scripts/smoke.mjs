// Launches the built app with an isolated data dir and takes screenshots of the main flows.
// Usage: node scripts/smoke.mjs <outDir> [step...]
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const out = process.argv[2] ?? 'shots';
const dataDir = path.join(out, 'data');
fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(path.join(dataDir, 'state.json'))) {
  fs.writeFileSync(
    path.join(dataDir, 'state.json'),
    JSON.stringify({
      projects: [
        { path: path.resolve('E:/sites/insider'), name: 'insider' },
        { path: path.resolve('E:/sites/editor'), name: 'editor' },
      ],
      chatProject: path.resolve('E:/sites/insider'),
    }),
  );
}

const app = await electron.launch({ args: ['.'], env: { ...process.env, CLAUDE_EDITOR_DATA: path.resolve(dataDir), CLAUDE_EDITOR_TRACE: path.resolve(out, 'trace.log') } });
const win = await app.firstWindow();
const logs = [];
win.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await win.setViewportSize({ width: 1600, height: 950 }).catch(() => {});
await win.waitForSelector('.topbar', { timeout: 20000 });
await win.waitForTimeout(1500);
const shot = (n) => win.screenshot({ path: path.join(out, n + '.png') });
await shot('01-start');

const steps = process.argv.slice(3);
globalThis.win = win;
for (const s of steps) {
  const mod = await import(pathToFileURL(path.resolve(s)).href);
  await mod.default(win, shot, app);
}
fs.writeFileSync(path.join(out, 'console.log'), logs.join('\n'));
await app.close();
console.log('done', logs.filter((l) => /error/i.test(l)).slice(0, 20).join('\n'));
