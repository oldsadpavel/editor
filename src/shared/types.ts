// Types shared between the Electron main process and the renderer.

export type ChatStatus = 'idle' | 'running' | 'waiting' | 'error';

export interface FileEdit {
  path: string;
  /** Number of individual replacements (MultiEdit counts every edit). */
  count: number;
  /** Whole-file writes (Write tool). */
  writes: number;
  firstAt: number;
  lastAt: number;
}

export interface TurnItemText { kind: 'text'; text: string }
export interface TurnItemTool {
  kind: 'tool';
  id: string;
  name: string;
  summary: string;
  path?: string;
  error?: boolean;
  done?: boolean;
}
export type TurnItem = TurnItemText | TurnItemTool;

export interface Turn {
  id: string;
  prompt: string;
  images: number;
  startedAt: number;
  /** Time of the last assistant output in this turn. */
  answeredAt?: number;
  items: TurnItem[];
  edits: FileEdit[];
  /** Files the assistant only read (shown as secondary links). */
  reads: string[];
  /** Turn is still being produced by a running query. */
  live?: boolean;
  error?: string;
  costUsd?: number;
}

export interface ChatSnapshot {
  sessionId: string;
  cwd: string;
  title: string;
  status: ChatStatus;
  turns: Turn[];
  /** Streaming text not yet committed into a turn item. */
  partial?: string;
  permissionMode?: string;
  pending: PermissionRequest[];
}

export interface PermissionRequest {
  id: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  hasSuggestions: boolean;
}

export interface PermissionAnswer {
  behavior: 'allow' | 'deny';
  always?: boolean;
  updatedInput?: Record<string, unknown>;
  message?: string;
}

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  title: string;
  lastModified: number;
  createdAt?: number;
  gitBranch?: string;
}

export interface ChatMeta {
  seenAt?: number;
  completedAt?: number;
  lastError?: string;
}

export interface ProjectRef { path: string; name: string }

export interface DeployTarget {
  /** Site URL that should change after a push. */
  url: string;
  /** 'sha' — page must contain the pushed commit hash; 'change' — any content change counts. */
  mode: 'sha' | 'change';
  /** Smoke tests that run after the deploy is live. */
  tests: SmokeTest[];
}

export interface SmokeTest {
  id: string;
  name: string;
  url: string;
  expectStatus: number;
  /** Text the response body must contain (optional). */
  contains?: string;
  /** Max response time in ms (optional). */
  maxMs?: number;
}

export interface TestResult {
  testId: string;
  repo: string;
  name: string;
  url: string;
  ok: boolean;
  status?: number;
  ms?: number;
  detail?: string;
  at: number;
  deployId?: string;
}

export type DeployState = 'pushed' | 'building' | 'deploying' | 'live' | 'failed' | 'stuck';

export interface DeployEvent {
  id: string;
  repo: string;
  branch: string;
  sha: string;
  pushedAt: number;
  sessionId?: string;
  state: DeployState;
  ci?: { state: 'pending' | 'success' | 'failure' | 'none'; url?: string; detail?: string };
  site?: { state: 'waiting' | 'updated' | 'unreachable' | 'none'; url?: string; checkedAt?: number; detail?: string };
  /** CI check runs (GitHub Actions jobs, including test jobs). */
  checks?: { name: string; state: 'pending' | 'success' | 'failure'; url?: string }[];
  tests?: { passed: number; failed: number; at: number };
  updatedAt: number;
}

export type ProblemSource = 'chat' | 'deploy' | 'keys' | 'auth' | 'fs' | 'app' | 'tests' | 'cache';

export interface Problem {
  id: string;
  source: ProblemSource;
  severity: 'error' | 'warning';
  title: string;
  detail?: string;
  at: number;
  sessionId?: string;
  path?: string;
  acknowledged?: boolean;
}

export type KeyStatus = 'expired' | 'expiring' | 'valid' | 'invalid' | 'unknown';

export interface FoundKey {
  id: string;
  file: string;
  line: number;
  name: string;
  kind: string;
  masked: string;
  status: KeyStatus;
  expiresAt?: number;
  note?: string;
}

export interface KeyScanResult {
  scannedAt: number;
  patterns: string[];
  roots: string[];
  filesScanned: string[];
  keys: FoundKey[];
}

export interface AuthStatus {
  loggedIn: boolean;
  email?: string;
  method?: string;
  orgName?: string;
  error?: string;
  cliPath?: string;
}

export interface AppState {
  projects: ProjectRef[];
  favorites: string[];
  openChats: string[];
  activeChat?: string;
  chatProject?: string;
  chatMeta: Record<string, ChatMeta>;
  deployTargets: Record<string, DeployTarget>;
  githubToken?: string;
  /** Opt-in: use the github.com credential git already stores (Credential Manager) for CI status. */
  githubFromGit?: boolean;
  keyPatterns: string[];
  /** Files older than this many days count as cleanable AI cache (chat transcripts use cacheChatDays). */
  cacheDays?: number;
  cacheChatDays?: number;
  /** Permission mode for new chats; undefined = whatever Claude Code settings say. */
  defaultPermissionMode?: string;
  /** Setup checklist items the user marked as not needed. */
  setupDismissed?: string[];
  ui: {
    leftWidth: number;
    rightWidth: number;
    bottomHeight: number;
    leftTab?: string;
    visible: Record<PanelId, boolean>;
  };
}

export type PanelId = 'setup' | 'tree' | 'chat' | 'problems' | 'keys' | 'deploys' | 'tests' | 'cache';

export interface DirEntry{ name: string; path: string; dir: boolean }

export type MainEvent =
  | { type: 'chat'; snapshot: ChatSnapshot }
  | { type: 'chatMeta'; sessionId: string; meta: ChatMeta }
  | { type: 'problems'; problems: Problem[] }
  | { type: 'deploys'; deploys: DeployEvent[] }
  | { type: 'keys'; result: KeyScanResult }
  | { type: 'tests'; results: TestResult[] }
  | { type: 'cache'; report: CacheReport }
  | { type: 'fileChanged'; path: string }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'sessionsChanged'; cwd: string };

export interface CacheCategory {
  id: string;
  title: string;
  paths: string[];
  /** safe — only regenerable/temporary data; caution — deleting loses history (chats, rewind). */
  safety: 'safe' | 'caution';
  note: string;
  files: number;
  bytes: number;
  cleanableFiles: number;
  cleanableBytes: number;
  /** Age threshold in days used for "cleanable"; 0 = rule is not age based (e.g. old versions). */
  days: number;
}

export interface CacheFile {
  path: string;
  bytes: number;
  mtime: number;
  category: string;
  cleanable: boolean;
}

export interface CacheReport {
  scannedAt: number;
  disk?: { path: string; free: number; total: number };
  categories: CacheCategory[];
  biggest: CacheFile[];
}

export type SetupAction =
  | { kind: 'login' }
  | { kind: 'addProject' }
  | { kind: 'githubAccess'; repo: string; github: string }
  | { kind: 'deployTarget'; repo: string }
  | { kind: 'addTest'; repo: string }
  | { kind: 'permissionMode'; current?: string; fromClaude?: string }
  | { kind: 'openPanel'; panel: PanelId; label: string };

export interface SetupItem {
  id: string;
  /** todo — needs your action now; ok — done; info — FYI. */
  level: 'todo' | 'ok' | 'info';
  group: string;
  title: string;
  detail?: string;
  action?: SetupAction;
  dismissable?: boolean;
}
