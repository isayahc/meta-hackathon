/** Link, review and inspect process/video locations headlessly. JSON stdout; no server. */
import { readFile } from 'node:fs/promises';
import { flagValue } from './lib/args.js';
import { spatialCommand, spatialEvidenceView, inspectSpatialTarget } from './lib/spatial-evidence.js';
const args=process.argv.slice(2),root=flagValue(args,'--root',null),command=args[0];
try {
  if(!root)throw new Error('Pass --root <project directory>.');
  if(command==='view')console.log(JSON.stringify(await spatialEvidenceView(root),null,2));
  else if(command==='apply'){
    const file=flagValue(args,'--input',null);if(!file)throw new Error('Pass --input <JSON command file>.');
    console.log(JSON.stringify({association:await spatialCommand(root,JSON.parse(await readFile(file,'utf8')))},null,2));
  }else if(command==='inspect')console.log(JSON.stringify({inspection:await inspectSpatialTarget(root,{kind:'oi',scene_id:flagValue(args,'--scene',null),revision:Number(flagValue(args,'--revision',null)),entity_kind:'scene',entity_id:'scene'})},null,2));
  else throw new Error('Use view, apply --input <file>, or inspect --scene <id> --revision <n>.');
}catch(error){const e=error as Error & {code?:string};console.log(JSON.stringify({error:e.message,code:e.code??'SPATIAL_FAILED'}));process.exitCode=1;}
