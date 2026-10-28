const BY_EXT: Record<string, string> = {
  php: '🐘',
  js: '🟨',
  mjs: '🟨',
  cjs: '🟨',
  jsx: '⚛',
  ts: '🔷',
  tsx: '⚛',
  py: '🐍',
  json: '{}',
  md: '📝',
  html: '🌐',
  htm: '🌐',
  css: '🎨',
  scss: '🎨',
  sql: '🗄',
  yml: '⚙',
  yaml: '⚙',
  env: '🔑',
  pem: '🔑',
  sh: '▶',
  ps1: '▶',
  png: '🖼',
  jpg: '🖼',
  svg: '🖼',
  txt: '📄',
};

export function fileIcon(name: string) {
  if (name.startsWith('.env')) return '🔑';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return BY_EXT[ext] ?? '📄';
}
