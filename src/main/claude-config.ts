import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Claude Code keeps per-project data under ~/.claude/projects/<cwd with every non-alphanumeric char as '-'>. */
const projectDir = (cwd: string) => path.join(os.homedir(), '.claude', 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));

/**
 * Files behind Claude Code's /memory, /permissions, /hooks and /agents, so the editor can open them in tabs.
 * Project memory (CLAUDE.md) is created empty when missing; settings files are listed only when they exist, plus
 * the project's settings.local.json (created with {} so permissions/hooks can be added there).
 */
export function claudeConfigFiles(cwd: string, kind: 'memory' | 'settings' | 'agents'): { files: string[]; dirs: string[] } {
  const home = path.join(os.homedir(), '.claude');
  if (kind === 'memory') {
    const project = path.join(cwd, 'CLAUDE.md');
    if (!fs.existsSync(project)) fs.writeFileSync(project, '# Память проекта для Claude\n\n');
    const auto = path.join(projectDir(cwd), 'memory', 'MEMORY.md');
    return { files: [project, path.join(cwd, 'CLAUDE.local.md'), path.join(home, 'CLAUDE.md'), auto].filter((f) => fs.existsSync(f)), dirs: [] };
  }
  if (kind === 'settings') {
    const local = path.join(cwd, '.claude', 'settings.local.json');
    if (!fs.existsSync(local)) {
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, '{\n  "permissions": { "allow": [], "deny": [] },\n  "hooks": {}\n}\n');
    }
    return { files: [local, path.join(cwd, '.claude', 'settings.json'), path.join(home, 'settings.json')].filter((f) => fs.existsSync(f)), dirs: [] };
  }
  const dirs = [path.join(cwd, '.claude', 'agents'), path.join(home, 'agents')];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  const files = dirs.flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => path.join(d, f)));
  return { files, dirs };
}
