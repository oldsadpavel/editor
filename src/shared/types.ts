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

export interface TurnAttachment {
  kind: 'image' | 'file';
  /** File on disk (pasted/attached in this editor). */
  path?: string;
  /** Image stored only inside the transcript (e.g. pasted in the terminal): entry uuid + content block index. */
  ref?: { uuid: string; index: number };
  mediaType?: string;
}

export interface Turn {
  id: string;
  prompt: string;
  images: number;
  attachments?: TurnAttachment[];
  /** Further questions sent before Claude answered: Claude Code answers them together, so they share this turn. */
  more?: { prompt: string; at: number; attachments?: TurnAttachment[]; pending?: boolean }[];
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
  /** Tokens spent on this answer (all API calls of the turn). */
  tokens?: TurnTokens;
  /** Models that produced this answer (e.g. claude-fable-5-1), in order of first use. */
  models?: string[];
}

export interface TurnTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
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
  /** Model alias for this chat (fable/opus/sonnet/haiku); undefined = Claude Code default. */
  model?: string;
  /** Reasoning effort for this chat; undefined = Claude Code default. */
  effort?: string;
  /** Every permission request is approved automatically (and logged). */
  autoApprove?: boolean;
  /** Remote Control on: the session is reachable from claude.ai/code and the Claude app. */
  remote?: boolean;
  /** Claude in Chrome: the browser extension's tools (open pages, click, read, fill forms) — `claude --chrome`. */
  chrome?: boolean;
  /** Permission decisions in this chat, oldest first. */
  approvals: ApprovalEntry[];
  pending: PermissionRequest[];
}

export interface ApprovalEntry {
  at: number;
  sessionId: string;
  /** Turn (question) during which the permission was requested. */
  turnId?: string;
  tool: string;
  summary: string;
  /** auto — approved by the chat's auto-approve switch; allow/always/deny — the user's click. */
  decision: 'auto' | 'allow' | 'always' | 'deny';
}

/** Per-message options sent with a prompt. */
export interface SendOptions {
  permissionMode?: string;
  model?: string;
  effort?: string;
  attachments?: string[];
}

export type ColumnId = 'left' | 'center' | 'right';
export type MainBlock = 'tree' | 'chat' | 'editor';
export type Layout = Record<ColumnId, MainBlock>;

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

export interface ProjectRef {
  path: string;
  name: string;
  /** Production domains/servers pinged by the Ping panel. */
  domains?: ProdTarget[];
  /** Ping interval in minutes (default 5). */
  pingMinutes?: number;
}

export interface ProdTarget {
  id: string;
  /** https://site.ru (HTTP check + SSL expiry), host:port (TCP) or bare host/IP (ICMP ping). */
  target: string;
  name?: string;
}

export interface PingResult {
  targetId: string;
  project: string;
  target: string;
  name?: string;
  kind: 'http' | 'tcp' | 'icmp';
  ok: boolean;
  ms?: number;
  status?: number;
  detail?: string;
  at: number;
  /** Days until the HTTPS certificate expires. */
  certDays?: number;
  /** Recent results, oldest first (true = ok). */
  history: { ok: boolean; at: number; ms?: number }[];
  failStreak: number;
}

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

export type ProblemSource = 'chat' | 'deploy' | 'keys' | 'auth' | 'fs' | 'app' | 'tests' | 'cache' | 'ping';

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
  /** Claude Code itself is missing: the editor offers to install it. */
  notInstalled?: boolean;
}

/** A saved workspace: a set of related projects with the chats and files that were open in it. */
export interface ProjectGroup {
  id: string;
  name: string;
  projects: ProjectRef[];
  favorites: string[];
  openChats: string[];
  activeChat?: string;
  chatProject?: string;
  openFiles?: string[];
  activeFile?: string;
  treeOpen?: string[];
}

export interface AppState {
  /** Project groups; the active one's fields are mirrored into the top-level projects/openChats/… */
  groups?: ProjectGroup[];
  activeGroup?: string;
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
  /** Model and effort for new chats; undefined = Claude Code default. */
  defaultModel?: string;
  defaultEffort?: string;
  defaultAutoApprove?: boolean;
  /** One-time data repairs already applied. */
  repairs?: string[];
  /** Per-chat model/effort chosen in the composer (remembered across restarts). */
  /** Cloud settings storage; the tokens themselves live encrypted in cloud-auth.bin, not here. */
  cloud?: { server: string; auto: boolean; email?: string; name?: string; lastSyncAt?: number; hash?: string; choiceMade?: boolean };
  chatModels?: Record<string, { model?: string; effort?: string; autoApprove?: boolean; remote?: boolean; chrome?: boolean }>;
  /** Claude in Chrome for new chats (default on). */
  defaultChrome?: boolean;
  /** Unsent text and attachments per chat. */
  drafts?: Record<string, { text: string; attachments: string[] }>;
  /** Files open in the editor and the active one, restored on start. */
  openFiles?: string[];
  activeFile?: string;
  /** Main window position/size, restored on start. */
  window?: { x?: number; y?: number; width: number; height: number; maximized?: boolean };
  ui: {
    layout: Layout;
    /** Relative widths of the bottom blocks shown side by side. */
    bottomFlex?: Record<string, number>;
    /** Bottom blocks take the whole center column (the center block is collapsed). */
    bottomMax?: boolean;
    /** Where the tool blocks (Настройка, Ошибки, Пинг…) live; on the right only one is open at a time. */
    toolDock?: 'bottom' | 'right';
    toolWidth?: number;
    /** Sort order of the project tree: per folder, with a default for the rest. */
    treeSort?: Record<string, TreeSort>;
    treeSortDefault?: TreeSort;
    /** Expanded tree folders (lower-case paths), restored on start. */
    treeOpen?: string[];
    leftWidth: number;
    rightWidth: number;
    bottomHeight: number;
    leftTab?: string;
    visible: Record<PanelId, boolean>;
  };
}

export type PanelId = 'setup' | 'tree' | 'chat' | 'problems' | 'keys' | 'deploys' | 'tests' | 'cache' | 'ping';

export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
  size?: number;
  mtime?: number;
}

export type TreeSortBy = 'name' | 'mtime' | 'size' | 'type';
export interface TreeSort {
  by: TreeSortBy;
  desc: boolean;
}

export type MainEvent =
  | { type: 'chat'; snapshot: ChatSnapshot }
  | { type: 'chatMeta'; sessionId: string; meta: ChatMeta }
  | { type: 'problems'; problems: Problem[] }
  | { type: 'deploys'; deploys: DeployEvent[] }
  | { type: 'keys'; result: KeyScanResult }
  | { type: 'tests'; results: TestResult[] }
  | { type: 'cache'; report: CacheReport }
  | { type: 'ping'; results: PingResult[] }
  | { type: 'appState'; state: AppState }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'update'; exe: string }
  | { type: 'fileChanged'; path: string }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'sessionsChanged'; cwd: string }
  | { type: 'cloud'; status: CloudStatus };

/** One saved copy of the settings in the cloud. */
export interface CloudVersion {
  id: number | string;
  created_at: string | null;
  size: number;
  device?: string | null;
  app_version?: string | null;
}

/** Cloud settings storage (Insider or a self-hosted server/): who is signed in and how syncing goes. */
export interface CloudStatus {
  /** Base URL of the storage, e.g. https://parts.mrkt.ru (Insider) or your own server. */
  server: string;
  signedIn: boolean;
  email?: string;
  name?: string;
  /** Upload automatically after every settings change. */
  auto: boolean;
  lastSyncAt?: number;
  lastError?: string;
  /** Signed in on a machine that never synced while the cloud already has settings: the user picks a direction. */
  needsChoice?: boolean;
  remote?: CloudVersion | null;
  busy?: string;
}

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
  | { kind: 'installClaude' }
  | { kind: 'addProject' }
  | { kind: 'githubAccess'; repo: string; github: string }
  | { kind: 'deployTarget'; repo: string }
  | { kind: 'addTest'; repo: string }
  | { kind: 'autoDeploySetup'; repo: string; site: string; project: string }
  | { kind: 'probeDeploy'; repo: string }
  | { kind: 'permissionMode'; current?: string; fromClaude?: string }
  | { kind: 'openPanel'; panel: PanelId; label: string }
  | { kind: 'projectSettings'; project: string };

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

export interface UsageWindow {
  /** Percent of the window already used, 0-100. */
  percent: number;
  resetsAt?: number;
}

/** claude.ai plan limits: the 5-hour session window and the weekly window (plus per-model weekly windows). */
export interface UsageInfo {
  available: boolean;
  plan?: string;
  session?: UsageWindow;
  week?: UsageWindow;
  models?: (UsageWindow & { name: string })[];
  extra?: { percent?: number; used?: number; limit?: number; currency?: string };
  checkedAt?: number;
  error?: string;
}
