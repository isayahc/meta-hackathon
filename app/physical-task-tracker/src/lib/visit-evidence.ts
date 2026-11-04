/** Retain compared source bytes and sampled frames through the selected asset store. */
import { createHash } from 'node:crypto';
import { writeFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { hashAsset, putAsset, withAssetWorkspace, MAX_ASSET_BYTES, MAX_WORK_BYTES } from './assets.js';
export interface RetainedVisit { identity: string; source: { media: string; checksum: string } | null; frames: Array<{ media: string; checksum: string }>; coverage: 'sampled'; note: string }
/** Preserve each actually compared image and the original, with immutable content identities. */
export async function retainVisitEvidence(root:string,original:string,dataUrls:string[]):Promise<RetainedVisit>{
  return withAssetWorkspace(root,async directory=>{
    const frames:Array<{media:string;checksum:string}>=[];let total=0;
    for(const url of dataUrls){
      const m=/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(url);if(!m)throw new Error('Invalid sampled image data.');
      const bytes=Buffer.from(m[2],'base64'),checksum=createHash('sha256').update(bytes).digest('hex'),media=`visit-${checksum}.${m[1]==='jpeg'?'jpg':m[1]}`;
      total+=bytes.length;if(bytes.length>MAX_ASSET_BYTES||total>MAX_WORK_BYTES)throw new Error('Compared frames exceed the staging budget.');
      await writeFile(join(directory,media),bytes);await putAsset(root,join(directory,media),media,{source:'visit-frame',parents:[]});frames.push({media,checksum});
    }
    const info=await stat(original);let source:RetainedVisit['source']=null;
    if(info.isFile()){
      const ext=extname(original).toLowerCase(),extension=['.mp4','.webm','.mov','.jpg','.jpeg','.png','.webp'].includes(ext)?ext:'.bin';
      const {sha256:checksum}=await hashAsset(original),media=`visit-${checksum}${extension}`;
      await putAsset(root,original,media,{source:'visit-original',parents:[]});source={media,checksum};
    }
    return {identity:source?`media:${source.checksum}`:`frames:${createHash('sha256').update(JSON.stringify(frames.map(f=>f.checksum))).digest('hex')}`,source,frames,coverage:'sampled',note:'Compared samples retained. Sparse images do not establish continuous work duration or completion.'};
  });
}
