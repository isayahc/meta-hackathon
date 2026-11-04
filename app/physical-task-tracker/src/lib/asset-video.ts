/** Keep model/tool processing separate from the immutable asset publication boundary. */
import { join } from 'node:path';
import { assetConfig, retainGenerated, stageAsset, withAssetWorkspace } from './assets.js';
import type { ScanRunner } from './reconciliation-video.js';

/** Analyze one retained original and publish segment GIFs before recording their interpretation. */
export async function scanRetainedVideo(root:string,name:string,frames:number,prefix:string,run:ScanRunner,extra:string[]=[]):Promise<Record<string,unknown>> {
  if(!assetConfig(root))return await run('task-scan-video.js',[join(root,'media',name),'--frames',String(frames),'--gifs',join(root,'media'),'--gif-prefix',prefix,...extra]) as Record<string,unknown>;
  return withAssetWorkspace(root,async directory=>{
    const file=await stageAsset(root,name,directory);
    const raw=await run('task-scan-video.js',[file,'--frames',String(frames),'--gifs',directory,'--gif-prefix',prefix,...extra]) as Record<string,unknown>;
    const gifs=await retainGenerated(root,directory,[name]);
    raw.gifs=gifs;
    if(Array.isArray(raw.gif_segments))raw.gif_segments=raw.gif_segments.filter(s=>s&&typeof s==='object'&&gifs.includes(String((s as {file?:unknown}).file)));
    return raw;
  });
}
