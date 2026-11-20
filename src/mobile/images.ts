/**
 * Pictures on the phone: the editor shows local files as efile:///<path> (served by the PC's main process), which the
 * phone can't open. Every <img> with such a src (attachment previews, the lightbox, images in answers and the editor)
 * gets the picture from the PC instead (fs:image — scaled down, as a data URL), cached for the session.
 */

const cache = new Map<string, Promise<string>>();

export function startImages(invoke: (ch: string, ...args: unknown[]) => Promise<any>) {
  const fix = (img: HTMLImageElement) => {
    const src = img.getAttribute('src') ?? '';
    if (!src.startsWith('efile:')) return;
    const p = decodeURIComponent(src.replace(/^efile:\/*/, '').split('?')[0]);
    img.dataset.efile = p;
    img.removeAttribute('src'); // no broken-image flash while it loads
    let job = cache.get(p);
    if (!job) {
      job = invoke('fs:image', p, 1400);
      cache.set(p, job);
      job.catch(() => cache.delete(p));
    }
    job.then(
      (url: string) => img.dataset.efile === p && (img.src = url),
      () => (img.alt = img.alt || '🖼 ' + p.split(/[\\/]/).pop()),
    );
  };
  const scan = (root: ParentNode) => root.querySelectorAll?.('img[src^="efile:"]').forEach((i) => fix(i as HTMLImageElement));
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes' && r.target instanceof HTMLImageElement) fix(r.target);
      for (const n of Array.from(r.addedNodes)) {
        if (n instanceof HTMLImageElement) fix(n);
        else if (n instanceof Element) scan(n);
      }
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  scan(document);
}
