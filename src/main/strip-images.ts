import fs from 'node:fs';
import readline from 'node:readline';

/**
 * Pictures out of a chat's history (the Claude Code transcript): every image block — pasted screenshots, Read of an
 * image, Claude in Chrome screenshots inside tool results — becomes a short text note. A model without image input
 * (via OpenRouter) is sent the whole history each time, so one picture made every later question fail with
 * «No endpoints found that support image input». The original is kept next to it as <file>.images.bak.
 * Returns how many pictures were replaced.
 */
export async function stripImages(file: string): Promise<number> {
  const backup = file + '.images.bak';
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  const tmp = file + '.strip.tmp';
  const out = fs.createWriteStream(tmp);
  let replaced = 0;
  const strip = (v: any): any => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      if (v.type === 'image' && v.source) {
        replaced++;
        return { type: 'text', text: '[картинка убрана из истории: текущая модель не принимает изображения]' };
      }
      for (const k of Object.keys(v)) if (typeof v[k] === 'object' && v[k] !== null) v[k] = strip(v[k]);
    }
    return v;
  };
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    let outLine = line;
    // only lines that can carry an image are parsed (the file can be hundreds of MB)
    if (line.includes('"type":"image"')) {
      try {
        const entry = JSON.parse(line);
        if (entry.message?.content) entry.message.content = strip(entry.message.content);
        if (entry.attachment?.prompt) entry.attachment.prompt = strip(entry.attachment.prompt);
        outLine = JSON.stringify(entry);
      } catch {
        /* a broken line stays as is */
      }
    }
    if (!out.write(outLine + '\n')) await new Promise((r) => out.once('drain', r));
  }
  await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  fs.renameSync(tmp, file);
  return replaced;
}
