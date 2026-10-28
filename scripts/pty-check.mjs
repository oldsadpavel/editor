// Checks the hidden pseudo-terminal used by /RC (remote.ts ptyCommand) on this OS: the child must see a real TTY of
// 120 columns, get what we type into its stdin, and quoting must survive spaces and apostrophes. Used in CI on macOS.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pty-')), 'remote.mjs');
await build({ entryPoints: ['src/main/remote.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' });
const { ptyCommand } = await import(pathToFileURL(out).href);

const childScript = [
  "process.stdout.write('TTY ' + !!process.stdin.isTTY + ' ' + process.stdout.columns + ' ARG ' + process.argv[1] + '\\n');",
  "process.stdin.setRawMode && process.stdin.setRawMode(true);",
  "let buf = '';",
  "process.stdin.on('data', (d) => { buf += d; if (buf.includes('\\r')) { process.stdout.write('GOT ' + buf.trim() + '\\n'); process.exit(0); } });",
].join('\n');
const pty = ptyCommand(process.execPath, ['-e', childScript, "it's a test"]);
const child = spawn(pty.file, pty.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let text = '';
const collect = (d) => (text += d.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
child.stdout.on('data', collect);
child.stderr.on('data', collect);
setTimeout(() => child.stdin.write('hello'), 1500);
setTimeout(() => child.stdin.write('\r'), 1800);
const code = await new Promise((r) => {
  child.on('exit', r);
  setTimeout(() => (child.kill(), r('timeout')), 15000);
});
console.log(`${process.platform}: ${pty.file} ${pty.args.slice(0, 3).join(' ')} …`);
console.log('output:', JSON.stringify(text.slice(-400)));
const cols = process.platform === 'win32' ? '[0-9]+' : '120'; // winpty keeps its own 80 columns
const ok = new RegExp(`TTY true ${cols} ARG it's a test`).test(text) && /GOT hello/.test(text);
console.log(ok ? 'PTY OK' : `PTY FAILED (exit ${code})`);
// Visible in the run's public annotations (logs need a token).
if (process.env.GITHUB_ACTIONS) console.log(`::${ok ? 'notice' : 'error'}::pty ${process.platform} exit=${code} ${pty.file} :: ${JSON.stringify(text.slice(-700)).replace(/%/g, '%25')}`);
process.exit(ok ? 0 : 1);
