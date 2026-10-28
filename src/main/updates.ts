import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { emit } from './bus';

/**
 * scripts/install-local.ps1 installs each build into its own folder and writes the new exe path to
 * <install root>/current.txt. A running editor (an older build) notices the change and offers a restart.
 */
const CHECK_MS = 30_000;
let pending: string | null = null;

/** current.txt sits next to the app-* folder this exe runs from (or in the same folder for an old flat install). */
function currentFile(): string {
  const exeDir = path.dirname(app.getPath('exe'));
  const parent = path.dirname(exeDir);
  return path.basename(exeDir).startsWith('app-') ? path.join(parent, 'current.txt') : path.join(exeDir, 'current.txt');
}

function check() {
  if (!app.isPackaged) return;
  let target: string;
  try {
    target = fs.readFileSync(currentFile(), 'utf8').replace(/^﻿/, '').trim();
  } catch {
    return;
  }
  if (!target || path.resolve(target).toLowerCase() === path.resolve(app.getPath('exe')).toLowerCase() || !fs.existsSync(target)) return;
  if (pending === target) return;
  pending = target;
  emit({ type: 'update', exe: target });
}

export function pendingUpdate() {
  return pending;
}

export function startUpdateWatch() {
  check();
  setInterval(check, CHECK_MS);
}

/** Starts the newly installed build and quits this one; everything open is restored from saved state. */
export function restartToUpdate() {
  if (!pending) throw new Error('Новой версии нет');
  app.relaunch({ execPath: pending });
  app.quit();
}
