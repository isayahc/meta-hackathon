/** Explicit asset activation, recovery and offline staging maintenance. JSON stdout only. */
import { resolve, join } from 'node:path';
import { rm } from 'node:fs/promises';
import { activateAssets, auditAssets, repairAsset } from './lib/assets.js';
/** Execute the requested asset administration operation. */
async function main():Promise<void>{
  const [command,rootArg,...args]=process.argv.slice(2);if(!rootArg)throw new Error('Usage: task-assets init|import|audit|repair|cleanup-staging PROJECT_ROOT [ASSET_NAME] [--offline]');const root=resolve(rootArg);
  if(['init','import','cleanup-staging'].includes(command)&&!args.includes('--offline'))throw new Error('Stop every project writer, then supply --offline.');
  if(command==='init'||command==='import'){await activateAssets(root,command);console.log(JSON.stringify({backend:'s3',active:true}));}
  else if(command==='audit')console.log(JSON.stringify(await auditAssets(root)));
  else if(command==='repair'){if(!args[0])throw new Error('Provide the reserved asset name.');console.log(JSON.stringify(await repairAsset(root,args[0])));}
  else if(command==='cleanup-staging'){await rm(join(root,'asset-staging','active'),{recursive:true,force:true});console.log(JSON.stringify({staging_cleared:true,objects_deleted:false}));}
  else throw new Error('Unknown asset command.');
}
main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
