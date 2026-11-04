/** Exercise the existing optimizer -> saved review -> farmer decision flow without a model or socket. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyCorrection, buildProcessFromScan, saveRevision, type BuildProcessInput } from './lib/processes.js';
import { getDoc } from './lib/records.js';
import type { ImprovementCandidate, ImprovementReview, WorkflowContext } from './lib/improvements.js';

const exec = promisify(execFile);
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'improvement-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = JSON.parse(await readFile(new URL('./samples/workflow-improvements.json', import.meta.url), 'utf8')) as {
    scan: BuildProcessInput; context: WorkflowContext; candidates: ImprovementCandidate[];
  };
  const original = buildProcessFromScan(data.scan);
  await saveRevision(root, original);
  await applyCorrection(root, original.id, { steps: Object.fromEntries(original.steps.map((s) => [s.id, { requires_unknown: false }])) }, 'Synthetic farmer review.');
  await writeFile(join(root, 'context.json'), JSON.stringify(data.context));
  await writeFile(join(root, 'candidates.json'), JSON.stringify(data.candidates));
  return { root, data };
}
async function cli(root: string, name: string, args: string[]): Promise<string> {
  const { stdout } = await exec(process.execPath, [fileURLToPath(new URL(`./${name}.js`, import.meta.url)), ...args], {
    cwd: root, env: { ...process.env, META_API_KEY: '', META_API_BASE: 'https://must-not-be-called.invalid', OI_ROOT: '' },
  });
  return stdout;
}

test('offline replay produces a checked plan; decisions persist through the actual CLI', async (t) => {
  const { root, data } = await fixture(t);
  const output = JSON.parse(await cli(root, 'task-optimize', [root, '--workflow-context', join(root, 'context.json'), '--workflow-candidates', join(root, 'candidates.json')]));
  const review = output.improvements as ImprovementReview;
  assert.equal(review.source, 'replay');
  assert.equal(review.stale, false);
  assert.equal(output.plan.ranked_actions.length, 1);
  assert.equal(review.assessments[0].comparisons[0].status, 'projection');
  assert.equal(output.model_narrative.improvements[0].id, data.candidates[0].id);
  const saved = (await getDoc(root, 'plan')) as { improvement_review_id: string };
  assert.equal(saved.improvement_review_id, review.id);
  const accepted = JSON.parse(await cli(root, 'task-improvements', ['decide', '--root', root, '--id', review.id,
    '--candidate', data.candidates[0].id, '--status', 'accepted', '--rationale', 'Try ten trays first.'])) as ImprovementReview;
  assert.equal(accepted.assessments[0].actionable, true);
  const reopened = JSON.parse(await cli(root, 'task-improvements', ['show', '--root', root, '--id', review.id])) as ImprovementReview;
  assert.equal(reopened.assessments[0].decisions[0].rationale, 'Try ten trays first.');
  // A normal refresh prompt reuses persisted operator evidence and constraints.
  const prompt = await cli(root, 'task-optimize', [root, '--offline']);
  assert.match(prompt, /baseline-time/);
  assert.match(prompt, /"budget_usd":25/);
  assert.match(prompt, /never invent measurements/i);
});

test('constraint conflict is deferred in the real optimizer plan, not just annotated', async (t) => {
  const { root, data } = await fixture(t);
  data.context.measurements[0].value = 100;
  await writeFile(join(root, 'context.json'), JSON.stringify(data.context));
  const output = JSON.parse(await cli(root, 'task-optimize', [root, '--workflow-context', join(root, 'context.json'), '--workflow-candidates', join(root, 'candidates.json')]));
  assert.equal(output.plan.ranked_actions.length, 0);
  assert.match(output.plan.deferred[0].why, /budget/);
  await assert.rejects(() => cli(root, 'task-improvements', ['decide', '--root', root, '--id', output.improvement_review_id,
    '--candidate', data.candidates[0].id, '--status', 'accepted', '--rationale', 'Ignore budget']), /Blocked or unvalidated/);
});

test('stubbed provider narrative cannot bypass checks; input changes during generation mark the plan stale', async (t) => {
  const { root, data } = await fixture(t);
  const stub = join(root, 'fetch-stub.mjs');
  const updatedContext = structuredClone(data.context);
  updatedContext.constraints.budget_usd = 0;
  // Changing an operator input in flight makes the result stale even when
  // the process version is unchanged. The request still used the old input.
  await writeFile(stub, `
    import { writeFile } from 'node:fs/promises';
    import { writeWorkflowContext } from ${JSON.stringify(new URL('./lib/improvements.js', import.meta.url).href)};
    globalThis.fetch = async (_url, init) => {
      await writeFile(${JSON.stringify(join(root, 'request.json'))}, init.body);
      writeWorkflowContext(${JSON.stringify(root)}, ${JSON.stringify(updatedContext)});
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        ranked_actions: [{action: 'MODEL CLAIM: do everything now'}],
        improvements: ${JSON.stringify(data.candidates)}
      }) } }] }), { status: 200 });
    };
  `);
  const { stdout } = await exec(process.execPath, ['--import', pathToFileURL(stub).href,
    fileURLToPath(new URL('./task-optimize.js', import.meta.url)), root,
    '--workflow-context', join(root, 'context.json')], {
    cwd: root, env: { ...process.env, META_API_KEY: 'test-key', META_API_BASE: 'https://must-not-be-called.invalid', OI_ROOT: '' },
  });
  const result = JSON.parse(stdout);
  assert.equal(result.improvements.source, 'model');
  assert.equal(result.stale, true);
  assert.match(result.stale_reason, /constraints or evidence/);
  assert.equal(result.plan.ranked_actions.length, 0);
  assert.equal(result.model_narrative.ranked_actions[0].action, 'MODEL CLAIM: do everything now');
  const request = JSON.parse(await readFile(join(root, 'request.json'), 'utf8'));
  assert.match(request.messages[0].content[0].text, /"budget_usd":25/);
});

