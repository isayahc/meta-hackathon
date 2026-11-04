/** Retain compared source bytes and sampled frames so session evidence outlives temporary uploads. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
export interface RetainedVisit { identity: string; source: { media: string; checksum: string } | null; frames: Array<{ media: string; checksum: string }>; coverage: 'sampled'; note: string }
/** Content-address local media; a frame directory retains exactly the images actually compared. */
export async function retainVisitEvidence(root: string, original: string, dataUrls: string[]): Promise<RetainedVisit> {
  const dir = join(root, 'media'); await mkdir(dir, { recursive: true });
  async function save(bytes: Buffer, extension: string): Promise<{ media: string; checksum: string }> { const checksum = createHash('sha256').update(bytes).digest('hex'), media = `visit-${checksum}${extension}`; await writeFile(join(dir, media), bytes); return { media, checksum }; }
  const frames = [];
  for (const url of dataUrls) { const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(url); if (!m) throw new Error('Invalid sampled image data.'); frames.push(await save(Buffer.from(m[2], 'base64'), m[1] === 'jpeg' ? '.jpg' : `.${m[1]}`)); }
  const info = await stat(original); let source: RetainedVisit['source'] = null;
  if (info.isFile()) { const ext = extname(original).toLowerCase(); const safeExtension = ['.mp4', '.webm', '.mov', '.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.bin'; source = await save(await readFile(original), safeExtension); }
  return { identity: source ? `media:${source.checksum}` : `frames:${createHash('sha256').update(JSON.stringify(frames.map(f => f.checksum))).digest('hex')}`, source, frames, coverage: 'sampled', note: 'Compared samples retained. Sparse images do not establish continuous work duration or completion.' };
}
