// Floor-plan flow: image -> Meta model observations -> OI SpaceIR ->
// OI validate/compile/commit -> OI preview links + Field Ops links.
//
//   node dist/task-floorplan.js <image> --root <dir> [--spot <id>] [--goal <id>]
//     [--scene-name <n>] [--observations <file>] [--print-prompt] [--mock-oi]
//     [--benchmark] [--out <file>]
//
// stdout is pure JSON (the server parses it); notes go to stderr.
// Env: META_API_KEY/BASE/MODEL (model calls), OI_ROOT (live OI runs),
// OI_SCENE_DATA_DIR, OI_WORKBENCH_ORIGIN, OI_STRICT_PIN.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagValue } from './lib/args.js';
import { loadEnvSync } from './lib/env.js';
import {
  buildRequestBody,
  extractAnalysis,
  resolveApiKey,
  postApi,
  DEFAULT_MAX_TOKENS,
} from './lib/analyze-response.js';
import {
  OiError,
  OiMockTransport,
  OiRunnerTransport,
  buildSpaceIr,
  readOiIdentity,
  resolveOiRoot,
  runFloorPlanFlow,
  OI_DEFAULT_WORKBENCH_ORIGIN,
  OI_PIN_SHA,
  OI_REPO,
  type FloorPlanObservations,
  type FloorPlanFlowResult,
  type OiCompiled,
  type OiCommitted,
  type OiIdentity,
  type OiTransport,
  type OiValidation,
} from './lib/oi-connector.js';
import { linkOiEntities } from './lib/oi-links.js';

loadEnvSync();

const HERE = dirname(fileURLToPath(import.meta.url));
const API_BASE = process.env.META_API_BASE ?? 'https://api.meta.ai/v1';
const MODEL = process.env.MUSE_MODEL ?? 'muse-spark-1.1';

export const FLOORPLAN_PROMPT_VERSION = 'floorplan-v1';

export function buildFloorplanPrompt(): string {
  return `You are the vision layer of a Field Ops task tracker reading a floor-plan image.
Report ONLY what the drawing shows. Reply with strict JSON, no markdown fences:
{
  "site": {"width_m": 0, "depth_m": 0, "height_m": 0} or null,
  "siteEvidence": "where any dimensions came from, or why scale is unknown",
  "rooms": [{"label": "name", "kind": "room|zone|outdoor|volume", "polygon": [[0,0]] or null, "status": "observed|inferred"}],
  "walls": [{"label": "name", "kind": "wall|partition", "regions": ["room label", "optional second"], "path": [[[0,0],[1,1]]] or null, "thickness_m": 0 or null, "height_m": 0 or null, "status": "observed|inferred"}],
  "openings": [{"wall": 0, "kind": "door|passage|window|gate", "span": [0.4, 0.6], "traversable": true, "status": "observed|inferred"}],
  "equipment": [{"label": "name", "region": "room label", "polygon": [[0,0]] or null, "status": "observed|inferred"}],
  "unresolved": ["what you cannot tell: missing scale, unreadable labels, ambiguous connectivity"]
}
Rules: polygons/paths are normalized [0,1] plan coordinates with origin top-left. "wall" is a wall-array index. Spans are fractions along the wall within [0,1]. NEVER invent dimensions: site null when no scale bar or figured dimensions are visible; geometry null when unmeasurable; put every ambiguity in unresolved. Equipment is furniture/fixtures with visible footprints. Walls reference room labels exactly.`;
}

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(
    'Usage: node task-floorplan.js <image> --root <dir> [--spot <id>] [--goal <id>] [--scene-name <n>] [--observations <file>] [--print-prompt] [--mock-oi] [--benchmark] [--out <file>]'
  );
  process.exit(0);
}

if (args.includes('--print-prompt')) {
  console.log(buildFloorplanPrompt());
  process.exit(0);
}

function fail(message: string, code = 'FLOORPLAN_FAILED'): never {
  console.error(`ERROR [${code}]: ${message}`);
  process.exit(1);
}

const root = flagValue(args, '--root', null);
if (!root) fail('Pass --root <project dir>.', 'ARGS');
const projectRoot = resolve(root as string);
const mock = args.includes('--mock-oi');
const outFile = flagValue(args, '--out', null);

async function makeTransport(): Promise<{ transport: OiTransport; oiRoot: string; identity: OiIdentity }> {
  if (mock) {
    return {
      transport: new OiMockTransport(),
      oiRoot: '<mock>',
      identity: {
        repo: OI_REPO, pinnedSha: OI_PIN_SHA, actualSha: null, version: null, pinned: false,
        markers: { spaceIr: false, compiler: false, planViewport: false, localBackend: false },
      },
    };
  }
  let oiRoot: string;
  try {
    oiRoot = resolveOiRoot();
  } catch (e) {
    fail((e as Error).message, (e as OiError).code ?? 'OI_ROOT_NOT_FOUND');
  }
  const identity = await readOiIdentity(oiRoot);
  if (!identity.pinned) {
    const msg = `OI checkout ${identity.actualSha ?? 'unknown'} does not match pin ${OI_PIN_SHA.slice(0, 12)}.`;
    if (process.env.OI_STRICT_PIN === 'true') fail(msg, 'OI_PIN_MISMATCH');
    console.error(`Warning: ${msg} Continuing (set OI_STRICT_PIN=true to fail).`);
  }
  return { transport: new OiRunnerTransport(oiRoot), oiRoot, identity };
}

function oiDataDir(): string {
  return process.env.OI_SCENE_DATA_DIR ? resolve(process.env.OI_SCENE_DATA_DIR) : join(projectRoot, 'oi-scenes');
}
function workbenchOrigin(): string {
  return process.env.OI_WORKBENCH_ORIGIN ?? OI_DEFAULT_WORKBENCH_ORIGIN;
}

function understandingOf(obs: FloorPlanObservations): Record<string, unknown> {
  const nullGeo =
    obs.rooms.filter((r) => !r.polygon).length +
    obs.walls.filter((w) => !w.path).length +
    obs.equipment.filter((e) => !e.polygon).length;
  return {
    rooms: obs.rooms.length,
    walls: obs.walls.length,
    openings: obs.openings.length,
    equipment: obs.equipment.length,
    unresolved: obs.unresolved.length,
    nullGeometry: nullGeo,
    scaled: obs.site !== null,
  };
}

async function writeEvidence(flow: FloorPlanFlowResult, extra: Record<string, unknown>): Promise<string> {
  const dir = join(projectRoot, 'oi-evidence', flow.committed.scene_id);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(join(dir, 'space-ir.json'), JSON.stringify(flow.spaceIr, null, 2));
  const run = {
    ...extra,
    mock: flow.mock,
    oiIdentity: flow.oiIdentity,
    validation: flow.validation,
    compiled: {
      source_sha256: flow.compiled.source_sha256,
      bindings: flow.compiled.bindings,
      diagnostics: flow.compiled.diagnostics,
    },
    committed: flow.committed,
  };
  const runPath = join(dir, `run-${stamp}.json`);
  await writeFile(runPath, JSON.stringify(run, null, 2));
  return dir;
}

async function linkResult(flow: FloorPlanFlowResult, spot: string | null, goal: string | null): Promise<Record<string, unknown>> {
  const links = [
    { scene_id: flow.committed.scene_id, revision: flow.committed.revision, oi_entity_id: 'scene', oi_revision: flow.spaceIr.revision, role: 'space' },
    ...flow.spaceIr.regions.map((r) => ({
      scene_id: flow.committed.scene_id, revision: flow.committed.revision, oi_entity_id: String(r.id), oi_revision: flow.spaceIr.revision, role: 'region',
    })),
    ...flow.spaceIr.boundaries.map((b) => ({
      scene_id: flow.committed.scene_id, revision: flow.committed.revision, oi_entity_id: String(b.id), oi_revision: flow.spaceIr.revision, role: 'boundary',
    })),
    ...flow.spaceIr.occupancies.map((o) => ({
      scene_id: flow.committed.scene_id, revision: flow.committed.revision, oi_entity_id: String(o.id), oi_revision: flow.spaceIr.revision, role: 'occupancy',
    })),
  ];
  const linked: Record<string, unknown> = {};
  if (spot) linked.spot = await linkOiEntities(projectRoot, 'spot', spot, links);
  if (goal) linked.goal = await linkOiEntities(projectRoot, 'goal', goal, links);
  return linked;
}

async function emit(obj: unknown): Promise<void> {
  const text = JSON.stringify(obj, null, 2);
  if (outFile) await writeFile(outFile as string, text);
  console.log(text);
}

// Benchmark: fixtures through OI, no model calls. Understanding metrics
// (entity counts, uncertainty) stay separate from integration verdicts
// (OI valid/flags, bindings, diagnostics).
function oiFailure(e: unknown): Record<string, unknown> {
  if (e instanceof OiError) return { error: e.code, message: e.message.slice(0, 300), upstream: e.upstream };
  return { error: 'UNKNOWN', message: String(e).slice(0, 300) };
}
async function runBenchmark(): Promise<void> {
  const { transport, identity } = await makeTransport();
  const samplesDir = join(HERE, 'samples');
  const files = (await readdir(samplesDir)).filter((f) => f.startsWith('floorplan-') && f.endsWith('-observations.json')).sort();
  if (!files.length) fail(`No floorplan fixtures in ${samplesDir}.`, 'BENCHMARK');
  const fixtures = [];
  for (const file of files) {
    const raw = await readFile(join(samplesDir, file), 'utf8');
    const obs = JSON.parse(raw) as FloorPlanObservations;
    const digest = createHash('sha256').update(raw).digest('hex');
    // Per-stage capture: an OI verdict at any stage (e.g. UNSCALED_SITE on
    // the unscaled fixture) is recorded, never fatal to the report.
    const spaceIr = buildSpaceIr(obs, { sourceId: file, digestSha256: digest });
    const integration: Record<string, unknown> = {};
    let evidenceDir: string | null = null;
    try {
      const validation = await transport.request<OiValidation>('validate', { spaceIr });
      integration.validate = { valid: validation.valid, findingCodes: validation.findings.map((f) => `${f.code}:${f.severity}`) };
      if (!validation.valid) {
        integration.compile = { skipped: 'space rejected by OI validation' };
        integration.commit = { skipped: 'no compiled workspace' };
      } else {
        try {
          const compiled = await transport.request<OiCompiled>('compile', { spaceIr });
          integration.compile = { bindings: compiled.bindings.length, diagnostics: compiled.diagnostics.map((d) => d.code), source_sha256: compiled.source_sha256 };
          try {
            const committed = await transport.request<OiCommitted>('commit', {
              workspace: compiled.workspace,
              name: `benchmark-${basename(file, '-observations.json')}`,
              sceneId: randomUUID(),
              baseRevision: 0,
              requestId: randomUUID(),
              dataDir: join(projectRoot, 'oi-scenes'),
              workbenchOrigin: workbenchOrigin(),
              agent: 'fieldops-benchmark',
            });
            integration.commit = { scene_id: committed.scene_id, revision: committed.revision, preview: committed.revision_url };
            evidenceDir = join(projectRoot, 'oi-evidence', committed.scene_id);
            await mkdir(evidenceDir, { recursive: true });
            await writeFile(join(evidenceDir, 'space-ir.json'), JSON.stringify(spaceIr, null, 2));
          } catch (e) {
            integration.commit = oiFailure(e);
          }
        } catch (e) {
          integration.compile = oiFailure(e);
          integration.commit = { skipped: 'no compiled workspace' };
        }
      }
    } catch (e) {
      integration.validate = oiFailure(e);
      integration.compile = { skipped: 'no validated document' };
      integration.commit = { skipped: 'no compiled workspace' };
    }
    fixtures.push({ fixture: file, understanding: understandingOf(obs), integration, evidence: evidenceDir });
  }
  await emit({ ok: true, benchmark: true, mock, oiIdentity: identity, fixtures });
}

async function runFlow(): Promise<void> {
  const valueFlags = new Set(['--root', '--spot', '--goal', '--scene-name', '--observations', '--out']);
  let image: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith('--')) continue;
    if (i > 0 && valueFlags.has(args[i - 1] as string)) continue;
    image = a;
    break;
  }
  const observationsFile = flagValue(args, '--observations', null);
  if (!image && !observationsFile) fail('Pass <image> or --observations <file>.', 'ARGS');
  const spot = flagValue(args, '--spot', null);
  const goal = flagValue(args, '--goal', null);
  const sceneName = flagValue(args, '--scene-name', null) ?? undefined;

  const { transport } = await makeTransport();

  let observations: FloorPlanObservations;
  let sourceId: string;
  let digest: string;
  let model = MODEL;
  if (observationsFile) {
    const raw = await readFile(resolve(observationsFile as string), 'utf8');
    observations = JSON.parse(raw) as FloorPlanObservations;
    sourceId = `replay-${basename(observationsFile as string)}`;
    digest = createHash('sha256').update(raw).digest('hex');
    model = 'replay';
    console.error(`Replaying observations from ${observationsFile} (no model call).`);
  } else {
    const input = image as string;
    let imageUrl: string;
    if (/^https?:\/\//i.test(input)) {
      imageUrl = input;
      sourceId = input;
      digest = createHash('sha256').update(`url:${input}`).digest('hex');
    } else {
      const bytes = await readFile(input);
      const ext = input.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
      imageUrl = `data:image/${ext};base64,${bytes.toString('base64')}`;
      sourceId = basename(input);
      digest = createHash('sha256').update(bytes).digest('hex');
    }
    const key = await resolveApiKey();
    const maxTokens = Number.parseInt(process.env.MAX_TOKENS ?? '', 10) || DEFAULT_MAX_TOKENS;
    const body = buildRequestBody({ model: MODEL, prompt: buildFloorplanPrompt(), imageUrl, maxTokens, reasoningEffort: process.env.REASONING_EFFORT ?? null });
    const res = await postApi(`${API_BASE}/chat/completions`, key, body);
    if (!res.ok) fail(`API error ${res.status}: ${(await res.text()).slice(0, 500)}`, 'MODEL_API');
    const result = extractAnalysis(await res.json());
    if (!result.ok) {
      console.error(`Model analysis failed [${result.code}]: ${result.error}`);
      if (result.raw) console.error(`--- raw model output ---\n${result.raw}`);
      process.exit(1);
    }
    const analysis = result.analysis as unknown;
    observations = (typeof analysis === 'string' ? JSON.parse(analysis) : analysis) as FloorPlanObservations;
  }

  // Builder errors are actionable (bad model JSON shape); OI verdicts pass through.
  let spaceCheck;
  try {
    spaceCheck = buildSpaceIr(observations, { sourceId, digestSha256: digest });
    void spaceCheck;
  } catch (e) {
    if (e instanceof OiError) fail(`${e.message} (model output shape)`, e.code);
    throw e;
  }

  const flow = await runFloorPlanFlow({
    observations,
    source: { sourceId, digestSha256: digest },
    run: { model, promptVersion: FLOORPLAN_PROMPT_VERSION, mock },
    oi: {
      root: mock ? '<mock>' : resolveOiRoot(),
      dataDir: oiDataDir(),
      workbenchOrigin: workbenchOrigin(),
      sceneName: sceneName ?? `fieldops-${sourceId}-${new Date().toISOString().slice(0, 10)}`,
      requestId: randomUUID(),
    },
    transport,
  });
  const evidenceDir = await writeEvidence(flow, { source: { sourceId, digestSha256: digest }, model, promptVersion: FLOORPLAN_PROMPT_VERSION });
  const linked = await linkResult(flow, spot, goal);
  await emit({
    ok: true,
    mock,
    scene_id: flow.committed.scene_id,
    revision: flow.committed.revision,
    name: flow.committed.name,
    head_url: flow.committed.head_url,
    revision_url: flow.committed.revision_url,
    bindings: flow.compiled.bindings,
    diagnostics: flow.compiled.diagnostics,
    findings: flow.validation.findings,
    oiIdentity: flow.oiIdentity,
    understanding: understandingOf(observations),
    linked,
    evidence: evidenceDir,
  });
}

try {
  if (args.includes('--benchmark')) await runBenchmark();
  else await runFlow();
} catch (e) {
  if (e instanceof OiError) {
    console.error(`ERROR [${e.code}]: ${e.message}`);
    if (e.details) console.error(`--- detail ---\n${JSON.stringify(e.details).slice(0, 2000)}`);
    process.exit(1);
  }
  throw e;
}
