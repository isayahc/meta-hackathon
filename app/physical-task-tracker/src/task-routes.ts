/** Read-only route queries, JSON in/out. No server, models or automatic scene adoption. */
import { readFile } from 'node:fs/promises';
import { flagValue } from './lib/args.js';
import { routeAssessmentCommand } from './lib/route-assessment.js';
const args=process.argv.slice(2);
try{
  const action=args[0],input=flagValue(args,'--input',null);
  if(!['capabilities','assess','compare'].includes(action))throw new Error('Use capabilities, assess or compare --input <JSON file>.');
  if(action!=='capabilities'&&!input)throw new Error('Pass --input.');
  console.log(JSON.stringify(await routeAssessmentCommand(action as 'capabilities'|'assess'|'compare',input?JSON.parse(await readFile(input,'utf8')):{}),null,2));
}catch(error){const e=error as Error&{code?:string};console.log(JSON.stringify({error:e.message,code:e.code??'ROUTE_ASSESSMENT_FAILED'}));process.exitCode=1;}
