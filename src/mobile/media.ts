import { registerPlugin } from '@capacitor/core';
import { log } from './log';

/**
 * Pictures from the phone into a chat: the clipboard (native plugin Clip) and picked files. Photos are shrunk on the
 * phone (≤ 1600 px, JPEG) before they go to the PC — a 5 MB photo would be dozens of frames through Insider.
 */

const Clip = registerPlugin<{ readImage(): Promise<{ dataUrl: string }> }>('Clip');

const MAX_SIDE = 1600;

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

/** An image data URL made smaller (JPEG) when it is big; other data as is. */
export async function shrink(dataUrl: string): Promise<string> {
  if (!/^data:image\/(png|jpe?g|webp|bmp|heic|heif)/i.test(dataUrl)) return dataUrl;
  const img = new Image();
  img.src = dataUrl;
  await img.decode().catch(() => undefined);
  if (!img.naturalWidth) return dataUrl;
  const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  if (k === 1 && dataUrl.length < 600_000) return dataUrl;
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

/** attach:saveBlob of the editor (bytes) → attach:saveDataUrl on the PC. */
export async function saveBlob(rpc: (ch: string, args: unknown[]) => Promise<any>, bytes: Uint8Array, type: string) {
  const url = await shrink(await blobToDataUrl(new Blob([bytes as BlobPart], { type: type || 'application/octet-stream' })));
  return rpc('attach:saveDataUrl', [url]);
}

/** «📋 Картинка»: the clipboard image saved on the PC; returns its path. */
export async function pasteImage(rpc: (ch: string, args: unknown[]) => Promise<any>): Promise<string | null> {
  let dataUrl: string | null = null;
  const cap = (window as any).Capacitor;
  if (cap?.isNativePlatform?.()) dataUrl = (await Clip.readImage()).dataUrl;
  else {
    // a browser (tests): the async clipboard API
    for (const item of await navigator.clipboard.read()) {
      const t = item.types.find((x) => x.startsWith('image/'));
      if (t) {
        dataUrl = await blobToDataUrl(await item.getType(t));
        break;
      }
    }
  }
  if (!dataUrl) throw new Error('В буфере обмена нет картинки');
  try {
    return await rpc('attach:saveDataUrl', [await shrink(dataUrl)]);
  } catch (e: any) {
    log('error', 'Картинка из буфера: ' + e.message);
    throw e;
  }
}
