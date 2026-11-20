import { useEffect, useRef, useState } from 'react';
import { Toast } from '../renderer/App';
import { ChatPanel } from '../renderer/components/ChatPanel';
import { EditorArea } from '../renderer/components/Editor';
import { GitDialogHost } from '../renderer/components/Git';
import { ImageLightbox } from '../renderer/components/ImageViewer';
import { StatusModal } from '../renderer/components/StatusModal';
import { TreePanel } from '../renderer/components/Tree';
import { init, useStore } from '../renderer/store';

import { startImages } from './images';

export const initMain = () => {
  startImages((ch, ...a) => (window as any).bridge.invoke(ch, ...a));
  return init();
};

type Tab = 'chats' | 'files' | 'editor';

/** One block at a time: chats, the project tree (folders load when opened), the editor. */
export function MobileMain() {
  const [tab, setTab] = useState<Tab>('chats');
  const activeFile = useStore((s) => s.activeFile);
  const activeChat = useStore((s) => s.app?.activeChat);
  const files = useStore((s) => s.files.length);
  const first = useRef(true);
  // opening a file in the tree shows the editor, opening a chat shows the chats
  useEffect(() => {
    if (first.current) return;
    if (activeFile) setTab('editor');
  }, [activeFile]);
  useEffect(() => {
    if (first.current) return;
    if (activeChat) setTab('chats');
  }, [activeChat]);
  useEffect(() => {
    first.current = false;
  }, []);
  return (
    <>
      <div className="m-body">
        <div className={`m-pane ${tab === 'chats' ? 'on' : ''}`}>
          <ChatPanel />
        </div>
        <div className={`m-pane ${tab === 'files' ? 'on' : ''}`}>
          <TreePanel />
        </div>
        <div className={`m-pane ${tab === 'editor' ? 'on' : ''}`}>
          <EditorArea />
        </div>
      </div>
      <div className="m-tabs">
        <button className={tab === 'chats' ? 'on' : ''} onClick={() => setTab('chats')}>
          💬 Чаты
        </button>
        <button className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>
          📁 Файлы
        </button>
        <button className={tab === 'editor' ? 'on' : ''} onClick={() => setTab('editor')}>
          📝 Редактор{files ? ` · ${files}` : ''}
        </button>
      </div>
      <GitDialogHost />
      <ImageLightbox />
      <StatusModal />
      <Toast />
    </>
  );
}
