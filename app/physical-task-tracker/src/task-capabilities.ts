/** Discover and exercise capabilities without starting the dashboard. JSON stdout. */
import { CAPABILITIES, testCapabilities } from './lib/capabilities.js';
const args = process.argv.slice(2);
try {
  if (args.length === 1 && args[0] === 'list') {
    console.log(JSON.stringify({ schema: 'fieldops-capabilities/1', capabilities: CAPABILITIES }, null, 2));
  } else if (args.length === 4 && args[0] === 'test' && args[2] === '--out') {
    const report = await testCapabilities(args[1], args[3]);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'failed' ? 1 : report.status === 'blocked' ? 2 : 0;
  } else throw new Error('Use list OR test outcomes|reconciliation|planning|process|improvements|floorplan|walkthrough|all --out <new absolute directory>.');
} catch (error) {
  console.log(JSON.stringify({ status: 'failed', error: (error as Error).message })); process.exitCode = 1;
}
