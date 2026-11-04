/** Read and decide workflow improvements saved by task-optimize. JSON stdout only. */
import { flagValue } from './lib/args.js';
import { decideImprovement, listImprovementReviews, readImprovementReview } from './lib/improvements.js';

const args = process.argv.slice(2);
try {
  const root = flagValue(args, '--root', null);
  if (!root) throw new Error('Pass --root <project directory>.');
  const id = flagValue(args, '--id', null);
  let result: unknown;
  if (args[0] === 'list') result = listImprovementReviews(root);
  else if (args[0] === 'show' && id) result = readImprovementReview(root, id);
  else if (args[0] === 'decide' && id) {
    const candidate = flagValue(args, '--candidate', null);
    if (!candidate) throw new Error('Pass --candidate <candidate ID>.');
    result = decideImprovement(root, id, candidate, flagValue(args, '--status', null), flagValue(args, '--rationale', null));
  } else throw new Error('Use list, show --id, or decide --id --candidate --status accepted|rejected|deferred --rationale.');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`ERROR [IMPROVEMENTS]: ${(error as Error).message}`);
  process.exitCode = 1;
}
