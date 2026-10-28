import { randomUUID } from 'node:crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { emit } from './bus';
import * as deploy from './deploy';
import * as keys from './keys';
import * as ping from './ping';
import * as problems from './problems';
import { stateFile } from './store';

/**
 * Appended to every chat's system prompt so each Claude session knows the editor's panels
 * and reports into them instead of only writing to the chat.
 */
export const EDITOR_INSTRUCTIONS = `
# Редактор Claude Editor

Ты работаешь внутри редактора Claude Editor. Пользователь видит не только чат, но и панели редактора.
Панели переключаются кнопками на верхней панели; когда в панели есть проблема, её кнопка подсвечивается.
Настраивай панели и отчитывайся в них через MCP-инструменты сервера \`editor\`:

- **Ошибки** — \`mcp__editor__report_problem\`: важные проблемы, которые пользователь не должен пропустить
  (сломанная сборка, упавший сервис, нехватка доступа, ручное действие для пользователя). Не дублируй туда мелочи.
  Когда проблема устранена — \`mcp__editor__resolve_problem\`.
- **Деплои** — пуши отслеживаются автоматически (по смене remote-ref после \`git push\`).
  Надёжная проверка — **маркер версии**: сайт отдаёт хэш коммита, из которого собран (по соглашению
  \`https://<домен>/version.json\` → \`{"commit":"<полный sha>","builtAt":"<ISO>"}\`). Хэш попадает туда при сборке/деплое
  (git rev-parse HEAD в CI, build-arg, файл, записанный скриптом деплоя), а не из рабочей папки сервера.
  Привязка — \`mcp__editor__set_deploy_target\` (url адреса версии, mode="sha"; без маркера — url сайта и mode="change").
  Что сайт отдаёт сейчас и совпадает ли с HEAD — \`mcp__editor__check_deploy_target\`.
  После пуша статус — \`mcp__editor__get_editor_state\`.
- **Тесты** — smoke-тесты после деплоя: \`mcp__editor__add_smoke_test\` (url, ожидаемый статус, текст в ответе, лимит времени).
  Запуск вручную — \`mcp__editor__run_tests\`. Падение теста попадает в «Ошибки».
- **Ключи** — редактор ищет ключи по шаблонам путей. Если хранишь ключ в новом месте, добавь шаблон
  \`mcp__editor__add_key_pattern\`. Записывая ключ с ограниченным сроком, ставь рядом строку «expires YYYY-MM-DD».
- **Пинг** — продакшен-домены и серверы проекта проверяются по расписанию. Узнал новый прод-адрес — добавь
  \`mcp__editor__add_prod_domain\`.
- **Открыть файл** у пользователя в редакторе — \`mcp__editor__open_file\`.

Каждый чат в этом проекте ведёт свою историю, но память (memory, CLAUDE.md) общая для всех чатов проекта —
записывай туда факты, полезные другим чатам.
`;

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });

export function editorMcp(sessionId: string, cwd: string) {
  return createSdkMcpServer({
    name: 'editor',
    version: '1.0.0',
    tools: [
      tool(
        'report_problem',
        'Показать важную проблему в панели «Ошибки» редактора (кнопка панели подсветится).',
        {
          title: z.string().describe('Коротко, что сломалось'),
          detail: z.string().optional().describe('Подробности и что делать'),
          severity: z.enum(['error', 'warning']).default('error'),
          path: z.string().optional().describe('Файл, к которому относится проблема'),
        },
        async (a) => {
          const key = `chat|ai|${randomUUID()}`;
          problems.report({ source: 'chat', severity: a.severity, title: a.title, detail: a.detail, path: a.path, sessionId, key });
          return ok(`Проблема добавлена, id=${key}`);
        },
      ),
      tool(
        'resolve_problem',
        'Убрать проблему из панели «Ошибки», когда она устранена. Без id — убирает все проблемы этого чата.',
        { id: z.string().optional() },
        async (a) => {
          if (a.id) problems.remove(a.id);
          else for (const p of problems.list().filter((x) => x.sessionId === sessionId)) problems.remove(p.id);
          return ok('Готово');
        },
      ),
      tool(
        'set_deploy_target',
        'Связать git-репозиторий с сайтом, чтобы после push следить, что новая версия реально выкатилась.',
        {
          repo: z.string().optional().describe('Путь к репозиторию; по умолчанию текущий проект'),
          url: z.string().url(),
          mode: z.enum(['sha', 'change']).default('change'),
        },
        async (a) => {
          const root = (await deploy.gitRoot(a.repo ?? cwd)) ?? a.repo ?? cwd;
          const prev = stateFile.data.deployTargets[root.toLowerCase()];
          deploy.setTarget(root, { url: a.url, mode: a.mode, tests: prev?.tests ?? [] });
          await deploy.watchPath(root);
          return ok(`Сайт ${a.url} привязан к ${root}`);
        },
      ),
      tool(
        'add_smoke_test',
        'Добавить smoke-тест, который запускается после каждого успешного деплоя репозитория.',
        {
          repo: z.string().optional(),
          name: z.string(),
          url: z.string().url(),
          expectStatus: z.number().int().default(200),
          contains: z.string().optional(),
          maxMs: z.number().int().optional(),
        },
        async (a) => {
          const root = (await deploy.gitRoot(a.repo ?? cwd)) ?? a.repo ?? cwd;
          const key = root.toLowerCase();
          const t = stateFile.data.deployTargets[key] ?? { url: '', mode: 'change' as const, tests: [] };
          t.tests = [...t.tests.filter((x) => x.name !== a.name), { id: randomUUID(), name: a.name, url: a.url, expectStatus: a.expectStatus, contains: a.contains, maxMs: a.maxMs }];
          deploy.setTarget(root, t);
          return ok(`Тест «${a.name}» добавлен (${t.tests.length} всего)`);
        },
      ),
      tool(
        'check_deploy_target',
        'Что сейчас отдаёт адрес проверки деплоя репозитория и совпадает ли найденный хэш коммита с локальным HEAD (или запушенной веткой).',
        { repo: z.string().optional().describe('Путь к репозиторию; по умолчанию текущий проект') },
        async (a) => {
          const r = await deploy.probeTarget(a.repo ?? cwd);
          return ok(
            r.error
              ? `${r.url}: ошибка ${r.error}. HEAD ${r.headSha?.slice(0, 7) ?? '?'}`
              : `${r.url}: HTTP ${r.status}. Хэши на странице: ${r.found.join(', ') || 'нет'}. HEAD ${r.headSha?.slice(0, 7) ?? '?'}. ${r.matchesHead ? 'СОВПАДАЕТ — сайт работает на этом коммите' : 'НЕ совпадает'}.\nНачало ответа: ${r.snippet}`,
          );
        },
      ),
      tool(
        'run_tests',
        'Запустить smoke-тесты репозитория сейчас и вернуть результат.',
        { repo: z.string().optional() },
        async (a) => {
          const root = (await deploy.gitRoot(a.repo ?? cwd)) ?? a.repo ?? cwd;
          const res = await deploy.runTests(root);
          if (!res.length) return ok('Тестов нет. Добавьте через add_smoke_test.');
          return ok(res.map((r) => `${r.ok ? 'OK ' : 'FAIL'} ${r.name} ${r.status ?? ''} ${r.ms ?? ''}ms ${r.detail ?? ''}`).join('\n'));
        },
      ),
      tool(
        'add_key_pattern',
        'Добавить шаблон пути (glob относительно корня проекта), где лежат ключи, чтобы панель «Ключи» следила за их сроком.',
        { pattern: z.string() },
        async (a) => {
          if (!stateFile.data.keyPatterns.includes(a.pattern)) keys.setPatterns([...stateFile.data.keyPatterns, a.pattern]);
          const r = await keys.scanKeys();
          return ok(`Шаблон добавлен. Найдено ключей: ${r.keys.length}, проблемных: ${r.keys.filter((k) => k.status !== 'valid' && k.status !== 'unknown').length}`);
        },
      ),
      tool(
        'add_prod_domain',
        'Добавить продакшен-домен или сервер проекта в блок «Пинг» (проверяется по расписанию, при падении подсвечивается). target: https://site.ru, host:port или IP.',
        { target: z.string(), name: z.string().optional(), project: z.string().optional().describe('Путь проекта; по умолчанию текущий') },
        async (a) => {
          const dir = (a.project ?? cwd).toLowerCase();
          const p =
            stateFile.data.projects.find((x) => x.path.toLowerCase() === dir) ??
            stateFile.data.projects.find((x) => dir.startsWith(x.path.toLowerCase()));
          if (!p) return ok('Проект не открыт в редакторе — пользователь должен сначала добавить его.');
          if (!(p.domains ?? []).some((d) => d.target === a.target)) p.domains = [...(p.domains ?? []), { id: randomUUID(), target: a.target, name: a.name }];
          stateFile.save();
          emit({ type: 'appState', state: stateFile.data });
          const res = await ping.pingNow(p.path);
          const r = res.find((x) => x.target === a.target);
          return ok(`Добавлено в «Пинг» проекта ${p.name}. Сейчас: ${r?.ok ? 'OK' : 'НЕ ОТВЕЧАЕТ'} ${r?.ms ?? ''} мс ${r?.detail ?? ''}`);
        },
      ),
      tool(
        'open_file',
        'Открыть файл у пользователя в редакторе (опционально на строке).',
        { path: z.string(), line: z.number().int().optional() },
        async (a) => {
          emit({ type: 'openFile', path: a.path, line: a.line });
          return ok('Открыто');
        },
      ),
      tool(
        'get_editor_state',
        'Текущее состояние панелей: проблемы, последние деплои, результаты тестов, привязки сайтов.',
        {},
        async () =>
          ok(
            JSON.stringify(
              {
                problems: problems.list().slice(0, 20),
                deploys: deploy.listDeploys().slice(0, 10),
                tests: deploy.listTests().slice(0, 20),
                deployTargets: stateFile.data.deployTargets,
                keyPatterns: stateFile.data.keyPatterns,
              },
              null,
              1,
            ),
          ),
      ),
    ],
  });
}
