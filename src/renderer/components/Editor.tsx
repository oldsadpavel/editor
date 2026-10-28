import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { php } from '@codemirror/lang-php';
import { python } from '@codemirror/lang-python';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { closeFile, editFile, reloadFile, saveFile, set, useStore, type OpenFile } from '../store';
import { basename, dirname } from '../util';
import { fileIcon } from './icons';

function language(path: string): Extension {
  const name = basename(path).toLowerCase();
  const ext = name.split('.').pop() ?? '';
  switch (ext) {
    case 'php':
    case 'phtml':
      return php();
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'ts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'py':
      return python();
    case 'html':
    case 'htm':
    case 'vue':
    case 'blade':
      return html();
    case 'css':
    case 'scss':
    case 'less':
      return css();
    case 'json':
      return json();
    case 'md':
      return markdown();
    case 'sql':
      return sql();
    case 'xml':
    case 'svg':
      return xml();
    case 'yml':
    case 'yaml':
      return yaml();
    default:
      return [];
  }
}

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13.5px' },
  '.cm-scroller': { fontFamily: 'JetBrains Mono, Consolas, monospace', lineHeight: '1.55' },
  '.cm-gutters': { background: '#1e1f22', borderRight: '1px solid #2b2d30' },
  '&.cm-editor': { background: '#1e1f22' },
});

function CodeView({ file }: { file: OpenFile }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const reveal = useStore((s) => (s.reveal?.path === file.path ? s.reveal : undefined));

  useEffect(() => {
    const save = keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => (void saveFile(file.path), true) }]);
    view.current = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: file.text,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          save,
          keymap.of([indentWithTab, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap]),
          oneDark,
          theme,
          language(file.path),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) editFile(file.path, u.state.doc.toString());
          }),
        ],
      }),
    });
    return () => view.current?.destroy();
    // Recreated when the file is reloaded from disk (version) so undo history doesn't mix versions.
  }, [file.path, file.version]);

  useEffect(() => {
    const v = view.current;
    if (!v || !reveal?.line) return;
    const line = v.state.doc.line(Math.min(Math.max(1, reveal.line), v.state.doc.lines));
    v.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    v.focus();
  }, [reveal?.nonce]);

  return <div className="cm-host" ref={host} />;
}

export function EditorArea() {
  const files = useStore((s) => s.files);
  const active = useStore((s) => s.activeFile);
  const file = files.find((f) => f.path === active);

  return (
    <div className="editor-area">
      <div className="tabs editor-tabs">
        {files.map((f) => {
          const dirty = f.text !== f.savedText;
          return (
            <div
              key={f.path}
              className={`tab ${f.path === active ? 'on' : ''}`}
              title={f.path}
              onClick={() => set({ activeFile: f.path })}
              onAuxClick={(e) => e.button === 1 && closeFile(f.path)}
            >
              <span className="ficon">{fileIcon(f.path)}</span>
              {basename(f.path)}
              {dirty && <span className="dirty">●</span>}
              <span className="x" onClick={(e) => (e.stopPropagation(), closeFile(f.path))}>
                ×
              </span>
            </div>
          );
        })}
      </div>
      {file?.changedOnDisk && (
        <div className="banner warn">
          Файл изменён на диске (возможно, ИИ). У вас есть несохранённые правки.
          <button className="btn" onClick={() => reloadFile(file.path)}>
            Загрузить с диска
          </button>
          <button className="btn" onClick={() => saveFile(file.path)}>
            Перезаписать моими
          </button>
        </div>
      )}
      {file && <div className="crumbs">{dirname(file.path)}</div>}
      <div className="editor-body">
        {file ? (
          file.binary ? (
            <div className="empty">Бинарный файл — не отображается.</div>
          ) : (
            <CodeView key={file.path} file={file} />
          )
        ) : (
          <div className="empty big">
            <div className="logo">✳</div>
            Откройте файл в дереве проекта или из ответа ИИ.
            <div className="hint">Ctrl+S — сохранить · Ctrl+F — поиск · двойной клик по вкладке чата — переименовать</div>
          </div>
        )}
      </div>
    </div>
  );
}
