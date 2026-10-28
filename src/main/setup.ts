import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SetupItem } from '../shared/types';
import { authStatus } from './claude';
import { lastCache } from './cache';
import * as deploy from './deploy';
import { lastScan } from './keys';
import { stateFile } from './store';

const MODE_LABEL: Record<string, string> = {
  default: 'Спрашивать',
  acceptEdits: 'Правки без вопросов',
  auto: 'Авто',
  plan: 'План',
  bypassPermissions: 'Без ограничений',
};

/** `permissions.defaultMode` from Claude Code settings (project-local settings override user settings). */
function claudeDefaultMode(cwd?: string): string | undefined {
  const files = [
    ...(cwd ? [path.join(cwd, '.claude', 'settings.local.json'), path.join(cwd, '.claude', 'settings.json')] : []),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ];
  for (const f of files) {
    try {
      const mode = JSON.parse(fs.readFileSync(f, 'utf8'))?.permissions?.defaultMode;
      if (mode) return mode;
    } catch {
      /* missing or invalid settings file */
    }
  }
  return undefined;
}

const gb = (b: number) => (b / 1024 ** 3).toFixed(1) + ' ГБ';

/**
 * What the user should configure right now. Recomputed on demand, so every item reflects the live state
 * (an item disappears from "todo" as soon as the thing is set up).
 */
export async function setupStatus(): Promise<SetupItem[]> {
  const st = stateFile.data;
  const items: SetupItem[] = [];

  const auth = await authStatus();
  items.push(
    auth.loggedIn
      ? { id: 'auth', level: 'ok', group: 'Claude', title: `Вход в Claude: ${auth.email}`, detail: auth.orgName }
      : { id: 'auth', level: 'todo', group: 'Claude', title: 'Войдите в Claude', detail: auth.error ?? 'Без входа чаты не работают.', action: { kind: 'login' } },
  );

  const fromClaude = claudeDefaultMode(st.chatProject ?? st.projects[0]?.path);
  const effective = st.defaultPermissionMode ?? fromClaude;
  items.push({
    id: 'mode',
    level: !st.defaultPermissionMode && fromClaude === 'plan' ? 'todo' : 'ok',
    group: 'Claude',
    title: `Режим новых чатов: ${MODE_LABEL[effective ?? ''] ?? 'как решит Claude'}`,
    detail:
      !st.defaultPermissionMode && fromClaude === 'plan'
        ? 'В настройках Claude Code стоит «План»: каждый новый чат сначала пишет план и ждёт подтверждения. Выберите режим для редактора или оставьте как есть.'
        : st.defaultPermissionMode
          ? 'Задано в редакторе. Можно поменять в любом чате под полем ввода.'
          : 'Берётся из настроек Claude Code.',
    action: { kind: 'permissionMode', current: st.defaultPermissionMode, fromClaude },
    dismissable: true,
  });

  if (!st.projects.length) {
    items.push({ id: 'projects', level: 'todo', group: 'Проекты', title: 'Добавьте папку проекта', action: { kind: 'addProject' } });
  } else {
    items.push({ id: 'projects', level: 'ok', group: 'Проекты', title: `Открыто проектов: ${st.projects.length}`, detail: st.projects.map((p) => p.name).join(', ') });
    for (const p of st.projects) {
      const n = p.domains?.length ?? 0;
      items.push(
        n
          ? { id: `domains:${p.path}`, level: 'ok', group: `Пинг: ${p.name}`, title: `Продакшен-адресов: ${n}, проверка раз в ${p.pingMinutes ?? 5} мин`, action: { kind: 'projectSettings', project: p.path } }
          : {
              id: `domains:${p.path}`,
              level: 'todo',
              group: `Пинг: ${p.name}`,
              title: 'Укажите продакшен-домены и серверы',
              detail: 'Они будут пинговаться по расписанию; если сервер упал — кнопка «Пинг» загорится красным.',
              action: { kind: 'projectSettings', project: p.path },
              dismissable: true,
            },
      );
    }
  }

  for (const r of await deploy.repoInfo()) {
    const name = path.basename(r.root);
    const group = `Деплой: ${name}`;
    if (r.github) {
      if (r.ci === 'denied')
        items.push({
          id: `gh:${r.root}`,
          level: 'todo',
          group,
          title: `Нет доступа к CI ${r.github}`,
          detail: 'Репозиторий приватный: статус сборки GitHub Actions после push не виден. Нужен токен с правом чтения (repo или Checks: read).',
          action: { kind: 'githubAccess', repo: r.root, github: r.github },
          dismissable: true,
        });
      else if (r.ci === 'ok') items.push({ id: `gh:${r.root}`, level: 'ok', group, title: `CI ${r.github} доступен` });
      else items.push({ id: `gh:${r.root}`, level: 'info', group, title: `GitHub сейчас недоступен — CI ${r.github} проверю позже` });
    } else {
      items.push({ id: `gh:${r.root}`, level: 'info', group, title: 'Репозиторий не на GitHub — статус CI не отслеживается' });
    }

    const target = st.deployTargets[r.root.toLowerCase()];
    // The project's own production site (deploy target, else its first https domain) is what Claude can wire up.
    const project = st.projects.find((p) => p.path.toLowerCase() === r.root.toLowerCase() || p.path.toLowerCase().startsWith(r.root.toLowerCase() + path.sep));
    const site = target?.url || project?.domains?.find((d) => /^https?:\/\//.test(d.target))?.target;
    if (!target?.url && !site)
      items.push({
        id: `site:${r.root}`,
        level: 'todo',
        group,
        title: 'Какой сайт обновляется после push?',
        detail: `Без адреса не видно, что новая версия реально выкатилась.${r.pushes ? ` Пушей уже было: ${r.pushes}.` : ''} Если сайта нет — «Не нужно».`,
        action: { kind: 'deployTarget', repo: r.root },
        dismissable: true,
      });
    else if (target?.mode !== 'sha')
      items.push({
        id: `autodeploy:${r.root}`,
        level: 'todo',
        group,
        title: 'Проверка деплоя не автоматическая',
        detail: `${target?.url ? `Сейчас: ${target.url} — «изменение страницы», это неточно.` : `Сайт: ${site}.`} Claude может сам добавить в проект маркер версии (адрес, который отдаёт хэш коммита), привязать его и проверить первый деплой.`,
        action: { kind: 'autoDeploySetup', repo: r.root, site: site!, project: project?.path ?? r.root },
        dismissable: true,
      });
    else items.push({ id: `site:${r.root}`, level: 'ok', group, title: `Проверка деплоя: ${target.url}`, detail: 'ждём хэш запушенного коммита — проверка автоматическая', action: { kind: 'probeDeploy', repo: r.root } });

    if (target?.url && !target.tests?.length)
      items.push({
        id: `tests:${r.root}`,
        level: 'todo',
        group,
        title: 'Нет ни одного теста после деплоя',
        detail: 'Хотя бы один: главная страница отдаёт 200 и содержит ожидаемый текст.',
        action: { kind: 'addTest', repo: r.root },
        dismissable: true,
      });
    else if (target?.tests?.length) items.push({ id: `tests:${r.root}`, level: 'ok', group, title: `Тестов после деплоя: ${target.tests.length}` });
  }

  const keys = lastScan();
  if (keys) {
    const bad = keys.keys.filter((k) => k.status === 'expired' || k.status === 'invalid' || k.status === 'expiring');
    items.push({
      id: 'keys',
      level: bad.length ? 'todo' : 'ok',
      group: 'Ключи',
      title: bad.length ? `Ключи требуют внимания: ${bad.length}` : `Ключей найдено: ${keys.keys.length}, просроченных нет`,
      detail: bad.length ? bad.map((k) => `${k.name} (${k.kind}) — ${k.status === 'expiring' ? 'скоро истекает' : 'просрочен/недействителен'}`).join('\n') : `Файлов с ключами: ${keys.filesScanned.length}`,
      action: { kind: 'openPanel', panel: 'keys', label: 'Открыть «Ключи»' },
    });
  }

  const cache = lastCache();
  if (cache) {
    const safe = cache.categories.filter((c) => c.safety === 'safe').reduce((s, c) => s + c.cleanableBytes, 0);
    const lowDisk = cache.disk && cache.disk.free / cache.disk.total < 0.1;
    items.push({
      id: 'cache',
      level: safe > 500 * 1024 ** 2 || lowDisk ? 'todo' : 'ok',
      group: 'Диск',
      title: safe > 500 * 1024 ** 2 ? `Можно освободить ${gb(safe)} мусора ИИ` : 'Мусора ИИ немного',
      detail: cache.disk ? `Свободно на ${cache.disk.path} ${gb(cache.disk.free)} из ${gb(cache.disk.total)}` : undefined,
      action: { kind: 'openPanel', panel: 'cache', label: 'Открыть «Кеш ИИ»' },
    });
  }

  items.push({
    id: 'limits',
    level: 'info',
    group: 'Ограничения',
    title: 'Правки субагентов не попадают в списки файлов',
    detail: 'Если Claude поручил правку субагенту (инструмент Agent), такой файл не появится в «✎ N файлов» и во вкладке «Файлы».',
  });

  const dismissed = new Set(st.setupDismissed ?? []);
  return items.map((i) => (i.level === 'todo' && dismissed.has(i.id) ? { ...i, level: 'info' as const, detail: `Отмечено «не нужно». ${i.detail ?? ''}` } : i));
}
