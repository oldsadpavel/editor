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
import { Compartment, EditorState, type Extension } from '@codemirror/state';
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
import { call } from '../api';
import { closeFile, editFile, get, reloadFile, saveFile, set, setUi, useStore, type OpenFile } from '../store';
import { basename, dirname } from '../util';
import { fileIcon } from './icons';
import { ImageTab } from './ImageViewer';
import { BlockHandle } from './Layout';
import { TabStrip, middleClose } from './Tabs';

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

/** Cursor and selection go to the main process (debounced), so Claude can ask what the user is looking at. */
let contextTimer: ReturnType<typeof setTimeout> | null = null;
function reportContext(path: string, st: EditorState) {
  if (contextTimer) clearTimeout(contextTimer);
  contextTimer = setTimeout(() => {
    const sel = st.selection.main;
    const line = st.doc.lineAt(sel.head);
    void call('editor:context', {
      activeFile: path,
      line: line.number,
      column: sel.head - line.from + 1,
      selection: sel.empty ? undefined : st.sliceDoc(sel.from, sel.to).slice(0, 20000),
      openFiles: get().files.map((f) => f.path),
    }).catch(() => {});
  }, 400);
}

const toggleWrap = () => setUi({ wordWrap: !get().app!.ui.wordWrap });

function CodeView({ file }: { file: OpenFile }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const wrap = useStore((s) => !!s.app?.ui.wordWrap);
  const wrapping = useRef(new Compartment());
  const reveal = useStore((s) => (s.reveal?.path === file.path ? s.reveal : undefined));

  useEffect(() => {
    const save = keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => (void saveFile(file.path), true) },
      { key: 'Alt-z', preventDefault: true, run: () => (toggleWrap(), true) },
    ]);
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
          wrapping.current.of(get().app?.ui.wordWrap ? EditorView.lineWrapping : []),
          keymap.of([indentWithTab, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap]),
          oneDark,
          theme,
          language(file.path),
          EditorView.updateListener.of((u) => {
            if (u.selectionSet || u.focusChanged) reportContext(file.path, u.state);
            if (u.docChanged) editFile(file.path, u.state.doc.toString());
          }),
        ],
      }),
    });
    return () => view.current?.destroy();
    // Recreated when the file is reloaded from disk (version) so undo history doesn't mix versions.
  }, [file.path, file.version]);

  useEffect(() => {
    view.current?.dispatch({ effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  useEffect(() => {
    const v = view.current;
    if (!v || !reveal?.line) return;
    const line = v.state.doc.line(Math.min(Math.max(1, reveal.line), v.state.doc.lines));
    v.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    v.focus();
  }, [reveal?.nonce]);

  return <div className="cm-host" ref={host} />;
}

function WrapToggle() {
  const on = useStore((s) => !!s.app?.ui.wordWrap);
  return (
    <button className={`wrap-toggle ${on ? 'on' : ''}`} title={`Перенос длинных строк по ширине окна (Alt+Z) — сейчас ${on ? 'включён' : 'выключен'}`} onClick={toggleWrap}>
      ↩ Перенос
    </button>
  );
}

export function EditorArea() {
  const files = useStore((s) => s.files);
  const active = useStore((s) => s.activeFile);
  const file = files.find((f) => f.path === active);

  return (
    <div className="editor-area">
      <TabStrip
        className="editor-tabs"
        activeKey={active}
        onPick={(p) => set({ activeFile: p })}
        lead={
          <span className="tabs-handle">
            <BlockHandle block="editor" />
          </span>
        }
      >
        {files.map((f) => {
          const dirty = f.text !== f.savedText;
          return (
            <div
              key={f.path}
              data-tab-key={f.path}
              data-tab-label={`${basename(f.path)}${dirty ? ' ●' : ''}${f.unseen ? '  — изменён' : ''}`}
              data-tab-sort={f.changedAt ?? 0}
              className={`tab ${f.path === active ? 'on' : ''} ${f.unseen ? 'unseen' : ''}`}
              title={`${f.path}${f.unseen ? '\nИзменён на диске — вы ещё не смотрели' : ''}\nСредняя кнопка мыши — закрыть`}
              onClick={() => set({ activeFile: f.path })}
              {...middleClose(() => closeFile(f.path))}
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
      </TabStrip>
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
      {file && (
        <div className="crumbs">
          <span className="crumbs-path">{dirname(file.path)}</span>
          {file.kind !== 'image' && <WrapToggle />}
        </div>
      )}
      <div className="editor-body">
        {file ? (
          file.kind === 'image' ? (
            <ImageTab path={file.path} version={file.version} size={file.size} />
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
