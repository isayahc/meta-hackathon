import { assetInfo, assetConfig, withAssetWorkspace, stageAsset, retainGenerated } from './assets.js';
import { createHash } from 'node:crypto';
import { join, basename, resolve } from 'node:path';
import { getDoc, setDoc } from './records.js';
import { reconciliationView } from './reconciliation.js';
import { generateSegmentGifs, type VideoSegment } from './video-segments.js';
const pending = new Map<string, Promise<VideoSegment[]>>();
/** Check both metadata and retained files before using a cached visual derivative. */
async function usable(root: string, value: unknown, count: number): Promise<VideoSegment[] | null> {
  if (!Array.isArray(value) || value.length !== count) return null;
  const segments = value as VideoSegment[];
  if (new Set(segments.map(s=>s.frame)).size !== count || segments.some(s=>!Number.isInteger(s.frame)||s.frame<0||s.frame>=count||typeof s.file!=='string'||!/^[a-zA-Z0-9_.-]+\.gif$/.test(s.file)||!Number.isFinite(s.start_s)||!Number.isFinite(s.end_s)||s.start_s<0||s.end_s<=s.start_s)) return null;
  for (const s of segments) { try { if (!(await assetInfo(root,s.file)).size) return null; } catch { return null; } }
  return segments;
}
/** Backfill previews for one immutable interpretation without changing evidence or human review. */
export async function ensureReviewPreviews(root: string, sourceId: string, interpretationId: string): Promise<VideoSegment[]> {
  const source = (await reconciliationView(root)).sources.find(s=>s.id===sourceId);
  const interpretation = source?.interpretations.find(i=>i.id===interpretationId);
  if (!source?.media || !interpretation || basename(source.media)!==source.media || source.media.includes('\\')) throw new Error('Retained recording or interpretation not found.');
  const raw = (interpretation.raw || {}) as Record<string, unknown>;
  const count = Array.isArray(raw.frame_times_s) ? raw.frame_times_s.length : Array.isArray(raw.per_frame) ? raw.per_frame.length : 0;
  const duration = typeof raw.video_duration_s==='number' ? raw.video_duration_s : source.duration_s;
  if (count<1||count>24||!duration||!Number.isFinite(duration)||duration<=0) throw new Error('This recording has no reliable frame count or duration for segment previews.');
  const digest=createHash('sha256').update(JSON.stringify([source.id,source.checksum,interpretationId,count,duration])).digest('hex').slice(0,32);
  const key=`review-previews:${digest}`, requestKey=resolve(root)+':'+key;
  const active=pending.get(requestKey);if(active)return active;
  const work=(async()=>{
    const cached=await usable(root,await getDoc(root,key),count) || await usable(root,raw.gif_segments,count);
    if(cached)return cached;
    const segments=assetConfig(root) ? await withAssetWorkspace(root,async directory=>{
      const input=await stageAsset(root,source.media!,directory);
      const generated=await generateSegmentGifs(input,directory,`preview-${digest}`,count,duration);
      await retainGenerated(root,directory,[source.media!]);return generated;
    }) : await generateSegmentGifs(join(root,'media',source.media!),join(root,'media'),`preview-${digest}`,count,duration);
    if(!segments.length)throw new Error('Could not generate segment GIFs. Check FFmpeg and the retained recording, then retry previews.');
    await setDoc(root,key,segments);return segments;
  })();
  pending.set(requestKey,work);
  try{return await work;}finally{pending.delete(requestKey);}
}
