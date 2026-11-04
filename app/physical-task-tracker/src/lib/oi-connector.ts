// Thin OpenIndustries connector for Field Ops floor plans.
//
// Import boundary (see doc/oi-boundary.md): OI is an external runtime, not
// an npm dependency. The connector shapes Meta model observations into a
// SpaceIR v0.1 document and runs OI's own implementation — validate, compile,
// local commit — inside the pinned OI checkout via oi-runner.mjs. OI stays
// authoritative for spatial validation, geometry, persistence, and preview;
// this module never copies SpaceIR, never second-guesses OI verdicts, and
// stores only OI references (scene/revision/entity ids) plus run evidence.
//
// Zero dependencies beyond node builtins. Transport is injectable so tests
// run offline against OiMockTransport; live runs use OiRunnerTransport.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pinned upstream. Bump only with a verified checkout + doc update.
export const OI_REPO = 'Mapped-Assembly/OpenIndustries';
export const OI_PIN_SHA = '50f78e0bef23c5a6958d80c50e9232066ecc11d2';
export const OI_SPACE_IR_SCHEMA = 'mapped-assembly.space-ir';
export const OI_SPACE_IR_VERSION = '0.1.0';
export const OI_DEFAULT_WORKBENCH_ORIGIN = 'http://127.0.0.1:5173';
export const OI_RUNNER_TIMEOUT_MS = 180000;
export const OI_RUNNER_MAX_BYTES = 64 * 1024 * 1024;

export class OiError extends Error {
  readonly code: string;
  readonly upstream: boolean;
  readonly details: unknown;
  constructor(code: string, message: string, opts: { upstream?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = 'OiError';
    this.code = code;
    this.upstream = opts.upstream ?? false;
    this.details = opts.details ?? null;
  }
}

export type EvidenceStatus = 'observed' | 'inferred' | 'confirmed';
export type Point2 = [number, number];

// Model-facing observations. Polygons/paths are normalized [0,1] plan
// coordinates over the site footprint when scaled; the builder converts to
// OI world meters. Unscaled runs carry null geometry plus unresolved notes.
export interface ObservedSite {
  width_m: number;
  depth_m: number;
  height_m?: number | null; // null = unknown vertical extent; width/depth stay metric
}
export interface ObservedRoom {
  label: string;
  kind?: 'room' | 'zone' | 'outdoor' | 'volume';
  polygon: Point2[] | null;
  status?: EvidenceStatus;
}
export interface ObservedWall {
  label?: string;
  kind?: 'wall' | 'partition';
  regions: [string] | [string, string];
  path: [Point2, Point2] | null;
  thickness_m?: number | null;
  height_m?: number | null;
  status?: EvidenceStatus;
}
export interface ObservedOpening {
  wall: number;
  kind: 'door' | 'passage' | 'window' | 'gate';
  span: [number, number];
  traversable?: boolean;
  status?: EvidenceStatus;
}
export interface ObservedEquipment {
  label: string;
  region: string;
  polygon: Point2[] | null;
  status?: EvidenceStatus;
}
export interface FloorPlanObservations {
  site: ObservedSite | null;
  siteEvidence?: string;
  rooms: ObservedRoom[];
  walls: ObservedWall[];
  openings: ObservedOpening[];
  equipment: ObservedEquipment[];
  unresolved: string[];
}

export interface OiSource {
  sourceId: string;
  digestSha256: string;
  capturedAt?: string;
}

// SpaceIR v0.1 document shape as produced for OI. This is a request-shaping
// type only; OI's parseSpaceIR is the authoritative validator.
export interface OiSpaceIrDoc {
  schema_id: string;
  schema_version: string;
  id: string;
  revision: string;
  site: { frame_id: string; width_m: number; depth_m: number; height_m: number } | null;
  frames: Array<{ id: string; units: 'm' | 'px'; axes: 'XZ' | 'image_xy'; to_world?: number[] }>;
  regions: Array<Record<string, unknown>>;
  boundaries: Array<Record<string, unknown>>;
  portals: Array<Record<string, unknown>>;
  spatial_relations: Array<Record<string, unknown>>;
  occupancies: Array<Record<string, unknown>>;
  constraints: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  unresolved: string[];
}

export interface OiFinding {
  code: string;
  path: string;
  message: string;
  severity: 'error' | 'unresolved';
}
export interface OiValidation {
  valid: boolean;
  findings: OiFinding[];
}
export interface OiBinding {
  instance_id: string;
  entity_id: string;
  source_revision: string;
}
export interface OiDiagnostic {
  code: string;
  entity_id: string;
  message: string;
}
export interface OiCompiled {
  workspace: Record<string, unknown>;
  source_sha256: string;
  bindings: OiBinding[];
  diagnostics: OiDiagnostic[];
}
export interface OiCommitted {
  scene_id: string;
  revision: number;
  name: string;
  head_url: string;
  revision_url: string;
}
export interface OiIdentity {
  repo: string;
  pinnedSha: string;
  actualSha: string | null;
  version: string | null;
  pinned: boolean;
  markers: { spaceIr: boolean; compiler: boolean; planViewport: boolean; localBackend: boolean };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isPoint2(v: unknown): v is Point2 {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    v.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}
function slugify(label: string, fallback: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

function obsError(code: string, message: string): OiError {
  return new OiError(code, message);
}

// Value/type rendering for shape errors: bounded, JSON-free for numbers
// (JSON turns NaN into null), single-line.
function describeValue(v: unknown): string {
  if (v === undefined) return 'missing';
  if (v === null) return 'null';
  if (typeof v === 'number') return `number ${String(v)}`;
  if (typeof v === 'string') return `string ${JSON.stringify(v).slice(0, 60)}`;
  if (typeof v !== 'object') return `${typeof v} ${String(v).slice(0, 60)}`;
  if (Array.isArray(v)) return `array[${v.length}]`;
  return `object {${Object.keys(v).slice(0, 5).join(', ')}}`;
}

function checkObservations(obs: unknown): asserts obs is FloorPlanObservations {
  if (!isRecord(obs)) throw obsError('OBS_BAD_SHAPE', 'Observations must be an object.');
  if (obs.site !== null && !isRecord(obs.site)) {
    throw obsError('OBS_BAD_SHAPE', 'observations.site must be an object or null.');
  }
  if (isRecord(obs.site)) {
    for (const k of ['width_m', 'depth_m']) {
      if (typeof obs.site[k] !== 'number' || !Number.isFinite(obs.site[k])) {
        throw obsError('OBS_BAD_SHAPE', `observations.site.${k} must be a finite number (got ${describeValue(obs.site[k])}).`);
      }
    }
    const height = obs.site.height_m;
    if (height !== null && height !== undefined && (typeof height !== 'number' || !Number.isFinite(height))) {
      throw obsError('OBS_BAD_SHAPE', `observations.site.height_m must be a finite number or null (got ${describeValue(height)}).`);
    }
  }
  for (const k of ['rooms', 'walls', 'openings', 'equipment', 'unresolved']) {
    if (!Array.isArray(obs[k])) throw obsError('OBS_BAD_SHAPE', `observations.${k} must be an array.`);
  }
}

// Normalized [0,1] plan coordinate -> world meters, centered on the site.
function toMeters(p: Point2, site: ObservedSite): Point2 {
  return [(p[0] - 0.5) * site.width_m, (p[1] - 0.5) * site.depth_m];
}

// Explicit footprint assumption for scale-less plans: fills a null site
// with user-supplied meters (height stays unknown) and records provenance
// in siteEvidence, which the builder carries into unresolved notes.
// Observed sites pass through untouched.
export function applySizeAssumption(obs: FloorPlanObservations, widthM: number, depthM: number): FloorPlanObservations {
  if (obs.site !== null) return obs;
  const prior = typeof obs.siteEvidence === 'string' && obs.siteEvidence ? ` ${obs.siteEvidence}` : '';
  return {
    ...obs,
    site: { width_m: widthM, depth_m: depthM, height_m: null },
    siteEvidence: `User-assumed footprint ${widthM}x${depthM} m (explicit --assume-size; not observed).${prior}`,
  };
}

export function buildSpaceIr(
  obs: FloorPlanObservations,
  source: OiSource,
  opts: { docId?: string; revision?: string; assumedHeightM?: number } = {}
): OiSpaceIrDoc {
  checkObservations(obs);
  const docId = opts.docId ?? `fieldops-${source.sourceId}`;
  const revision = opts.revision ?? 'r1';
  const capturedAt = source.capturedAt ?? new Date().toISOString();
  const scaled = obs.site !== null;

  const siteHeightM = obs.site?.height_m ?? null;
  const assumedHeightM = opts.assumedHeightM ?? null;
  if (scaled && siteHeightM === null && assumedHeightM === null) {
    throw obsError(
      'OBS_MISSING_HEIGHT',
      'Site width/depth are known but height_m is unknown: pass --assume-height <meters> to record an explicit assumption, or supply site.height_m.'
    );
  }
  if (assumedHeightM !== null && (!Number.isFinite(assumedHeightM) || assumedHeightM <= 0)) {
    throw obsError('OBS_BAD_SHAPE', `assumedHeightM must be a positive finite number (got ${describeValue(assumedHeightM)}).`);
  }

  const evidence: Array<Record<string, unknown>> = [];
  const evIdFor = (entityId: string): string => {
    const evId = `ev-${entityId}`;
    return evId;
  };
  const addEvidence = (entityId: string, status: EvidenceStatus): string => {
    const evId = evIdFor(entityId);
    evidence.push({
      id: evId,
      source_id: source.sourceId,
      digest_sha256: source.digestSha256,
      status,
      captured_at: capturedAt,
    });
    return evId;
  };

  // Deterministic entity ids from labels; counter suffix on collision.
  const used = new Set<string>();
  const takeId = (prefix: string, label: string): string => {
    let id = `${prefix}-${slugify(label, prefix)}`;
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
    let n = 2;
    while (used.has(`${id}-${n}`)) n++;
    id = `${id}-${n}`;
    used.add(id);
    return id;
  };

  const regions: Array<Record<string, unknown>> = [];
  const regionIdByLabel = new Map<string, string>();
  for (const room of obs.rooms) {
    if (!isRecord(room) || typeof room.label !== 'string' || !room.label.trim()) {
      throw obsError('OBS_BAD_SHAPE', 'Every room needs a non-empty label.');
    }
    if (room.polygon !== null && (!Array.isArray(room.polygon) || !room.polygon.every(isPoint2))) {
      throw obsError('OBS_BAD_SHAPE', `Room "${room.label}" has an invalid polygon.`);
    }
    const id = takeId('room', room.label);
    regionIdByLabel.set(room.label, id);
    const status: EvidenceStatus = room.status ?? 'observed';
    regions.push({
      id,
      kind: room.kind ?? 'room',
      label: room.label,
      frame_id: 'world',
      polygon: scaled && room.polygon ? room.polygon.map((p) => toMeters(p, obs.site as ObservedSite)) : null,
      evidence_ids: [addEvidence(id, status)],
    });
  }

  const boundaries: Array<Record<string, unknown>> = [];
  const boundaryIds: string[] = [];
  obs.walls.forEach((wall, i) => {
    if (!isRecord(wall) || !Array.isArray(wall.regions) || wall.regions.length < 1 || wall.regions.length > 2) {
      throw obsError('OBS_BAD_SHAPE', `Wall ${i} must reference one or two regions.`);
    }
    const regionIds = wall.regions.map((label) => {
      const id = typeof label === 'string' ? regionIdByLabel.get(label) : undefined;
      if (!id) throw obsError('OBS_UNRESOLVED_REFERENCE', `Wall ${i} references unknown room "${String(label)}".`);
      return id;
    });
    if (wall.path !== null && (!Array.isArray(wall.path) || wall.path.length !== 2 || !wall.path.every(isPoint2))) {
      throw obsError('OBS_BAD_SHAPE', `Wall ${i} has an invalid path.`);
    }
    const id = takeId('wall', typeof wall.label === 'string' && wall.label ? wall.label : `w${i + 1}`);
    boundaryIds.push(id);
    const status: EvidenceStatus = (wall as ObservedWall).status ?? 'observed';
    boundaries.push({
      id,
      kind: (wall as ObservedWall).kind ?? 'wall',
      region_ids: regionIds,
      frame_id: 'world',
      path: scaled && wall.path ? (wall.path as [Point2, Point2]).map((p) => toMeters(p, obs.site as ObservedSite)) : null,
      thickness_m: (wall as ObservedWall).thickness_m ?? null,
      height_m: (wall as ObservedWall).height_m ?? null,
      evidence_ids: [addEvidence(id, status)],
    });
  });

  const portals: Array<Record<string, unknown>> = [];
  obs.openings.forEach((opening, i) => {
    if (!isRecord(opening) || typeof opening.wall !== 'number' || !boundaryIds[opening.wall]) {
      throw obsError('OBS_BAD_SHAPE', `Opening ${i} must reference a wall index.`);
    }
    const span = opening.span as unknown;
    if (!Array.isArray(span) || span.length !== 2 || !span.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw obsError('OBS_BAD_SHAPE', `Opening ${i} needs a numeric span pair.`);
    }
    const kind = (opening as ObservedOpening).kind;
    const traversable = (opening as ObservedOpening).traversable ?? (kind === 'door' || kind === 'passage' || kind === 'gate');
    const boundaryId = boundaryIds[opening.wall] as string;
    const parent = boundaries[opening.wall] as { region_ids: string[] };
    const id = `portal-${i + 1}`;
    if (used.has(id)) throw obsError('OBS_BAD_SHAPE', `Duplicate portal id ${id}.`);
    used.add(id);
    const status: EvidenceStatus = (opening as ObservedOpening).status ?? 'observed';
    portals.push({
      id,
      kind,
      boundary_id: boundaryId,
      connects: [...parent.region_ids],
      span,
      traversable,
      evidence_ids: [addEvidence(id, status)],
    });
  });

  const occupancies: Array<Record<string, unknown>> = [];
  for (const item of obs.equipment) {
    if (!isRecord(item) || typeof item.label !== 'string' || !item.label.trim()) {
      throw obsError('OBS_BAD_SHAPE', 'Every equipment entry needs a non-empty label.');
    }
    const regionId = typeof item.region === 'string' ? regionIdByLabel.get(item.region) : undefined;
    if (!regionId) throw obsError('OBS_UNRESOLVED_REFERENCE', `Equipment "${item.label}" references unknown room "${String(item.region)}".`);
    if (item.polygon !== null && (!Array.isArray(item.polygon) || !(item.polygon as unknown[]).every(isPoint2))) {
      throw obsError('OBS_BAD_SHAPE', `Equipment "${item.label}" has an invalid polygon.`);
    }
    const id = takeId('equip', item.label);
    const status: EvidenceStatus = (item.status as EvidenceStatus) ?? 'observed';
    occupancies.push({
      id,
      region_id: regionId,
      frame_id: 'world',
      polygon: scaled && item.polygon ? (item.polygon as Point2[]).map((p) => toMeters(p, obs.site as ObservedSite)) : null,
      evidence_ids: [addEvidence(id, status)],
    });
  }

  const unresolved = obs.unresolved.filter((u): u is string => typeof u === 'string' && !!u.trim());
  if (!scaled) {
    unresolved.push('Site has no metric scale: geometry omitted, topology retained.');
  }
  if (scaled && siteHeightM === null && assumedHeightM !== null) {
    unresolved.push(`Site height assumed: ${assumedHeightM} m via explicit user assumption (not observed).`);
  }
  if (obs.siteEvidence) unresolved.push(`Scale provenance: ${obs.siteEvidence}`);

  return {
    schema_id: OI_SPACE_IR_SCHEMA,
    schema_version: OI_SPACE_IR_VERSION,
    id: docId,
    revision,
    site: scaled
      ? {
          frame_id: 'world',
          width_m: (obs.site as ObservedSite).width_m,
          depth_m: (obs.site as ObservedSite).depth_m,
          height_m: ((obs.site as ObservedSite).height_m ?? assumedHeightM) as number,
        }
      : null,
    frames: [{ id: 'world', units: 'm', axes: 'XZ' }],
    regions,
    boundaries,
    portals,
    spatial_relations: [],
    occupancies,
    constraints: [],
    evidence,
    unresolved,
  };
}

// Resolve + inspect the OI runtime checkout. Throws OiError when the
// checkout is missing or lacks the pinned interface files.
export function resolveOiRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OI_ROOT?.trim();
  if (!raw) {
    throw new OiError(
      'OI_ROOT_NOT_FOUND',
      'OI_ROOT is not set. Clone Mapped-Assembly/OpenIndustries at the pinned commit and set OI_ROOT to the checkout (see doc/oi-boundary.md).'
    );
  }
  const root = resolve(raw);
  let st;
  try {
    st = statSync(root);
  } catch {
    st = null;
  }
  if (!st?.isDirectory()) {
    throw new OiError('OI_ROOT_NOT_FOUND', `OI_ROOT is not a directory: ${root}`);
  }
  const required = [
    'packages/space-ir/src/index.ts',
    'src/lib/space-ir-compiler.ts',
    'src/lib/workspace.ts',
    'server/local-scene-backend.ts',
    'server/mcp-scene-contract.mjs',
    'src/lib/scene-links.ts',
  ];
  const missing = required.filter((rel) => !existsSync(join(root, rel)));
  if (missing.length) {
    throw new OiError(
      'OI_LAYOUT_UNSUPPORTED',
      `OI checkout at ${root} lacks pinned interface files: ${missing.join(', ')}. ` +
        `Check out ${OI_REPO}@${OI_PIN_SHA.slice(0, 12)} (see doc/oi-boundary.md).`
    );
  }
  return root;
}

function runCapture(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { cwd, timeout: 15000 }, (err, stdout) => {
      if (err) reject(err);
      else resolvePromise(stdout);
    });
  });
}

export async function readOiIdentity(oiRoot: string): Promise<OiIdentity> {
  let actualSha: string | null = null;
  try {
    actualSha = (await runCapture('git', ['rev-parse', 'HEAD'], oiRoot)).trim() || null;
  } catch {
    actualSha = null;
  }
  let version: string | null = null;
  try {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(join(oiRoot, 'package.json'), 'utf8')) as { version?: unknown };
    version = typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    version = null;
  }
  return {
    repo: OI_REPO,
    pinnedSha: OI_PIN_SHA,
    actualSha,
    version,
    pinned: actualSha === OI_PIN_SHA,
    markers: {
      spaceIr: existsSync(join(oiRoot, 'packages/space-ir/src/index.ts')),
      compiler: existsSync(join(oiRoot, 'src/lib/space-ir-compiler.ts')),
      planViewport: existsSync(join(oiRoot, 'src/lib/plan-projection.ts')),
      localBackend: existsSync(join(oiRoot, 'server/local-scene-backend.ts')),
    },
  };
}

export type OiOp = 'validate' | 'compile' | 'commit' | 'head' | 'inspect' | 'reconstruction';

export interface OiTransport {
  request<T>(op: OiOp, payload: Record<string, unknown>): Promise<T>;
}

interface RunnerOk {
  ok: true;
  result: unknown;
}
interface RunnerFail {
  ok: false;
  code: string;
  message: string;
  details?: unknown;
  upstream?: boolean;
}

function runnerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'oi-runner.mjs');
}

export class OiRunnerTransport implements OiTransport {
  readonly oiRoot: string;
  constructor(oiRoot: string) {
    this.oiRoot = oiRoot;
  }
  async request<T>(op: OiOp, payload: Record<string, unknown>): Promise<T> {
    const runner = runnerPath();
    if (!existsSync(runner)) {
      throw new OiError('OI_RUNNER_MISSING', `Connector runner not found: ${runner}. Rebuild the app (npm run build).`);
    }
    const input = JSON.stringify({ op, payload });
    return new Promise<T>((resolvePromise, reject) => {
      const child = execFile(
        process.execPath,
        ['--import', 'tsx/esm', runner],
        {
          cwd: this.oiRoot,
          timeout: OI_RUNNER_TIMEOUT_MS,
          maxBuffer: OI_RUNNER_MAX_BYTES,
          env: { ...process.env, OI_RUNNER_ROOT: this.oiRoot },
        },
        (err, stdout) => {
          if (err) {
            if ((err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
              reject(new OiError('OI_RUNTIME_TIMEOUT', `OI ${op} timed out after ${OI_RUNNER_TIMEOUT_MS}ms.`));
              return;
            }
            const msg = (err as Error).message ?? String(err);
            if (/maxBuffer|max buffer/i.test(msg)) {
              reject(new OiError('OI_RESPONSE_TOO_LARGE', `OI ${op} response exceeded ${OI_RUNNER_MAX_BYTES} bytes.`));
              return;
            }
            reject(
              new OiError(
                'OI_RUNTIME_FAILED',
                `OI ${op} failed to run: ${msg.slice(0, 400)} ` +
                  `(needs node, tsx and three inside the OI checkout: npm install in ${this.oiRoot}).`
              )
            );
            return;
          }
          let parsed: RunnerOk | RunnerFail;
          try {
            parsed = JSON.parse(stdout) as RunnerOk | RunnerFail;
          } catch {
            reject(new OiError('OI_RUNTIME_FAILED', `OI ${op} returned non-JSON: ${stdout.slice(0, 200)}`));
            return;
          }
          if (!isRecord(parsed) || parsed.ok !== true) {
            const fail = parsed as RunnerFail;
            reject(
              new OiError(isRecord(parsed) && typeof fail.code === 'string' ? fail.code : 'OI_RUNTIME_FAILED', isRecord(parsed) && typeof fail.message === 'string' ? fail.message : `OI ${op} failed.`, {
                upstream: (fail as RunnerFail).upstream ?? true,
                details: (fail as RunnerFail).details ?? null,
              })
            );
            return;
          }
          resolvePromise((parsed as RunnerOk).result as T);
        }
      );
      try {
        child.stdin?.write(input);
        child.stdin?.end();
      } catch (e) {
        reject(new OiError('OI_RUNTIME_FAILED', `Could not write to OI runner: ${(e as Error).message}`));
      }
    });
  }
}

// Scripted offline transport for tests and --mock-oi runs. Every result is
// labeled mock:true and must never be mistaken for an OI verdict.
export interface OiMockScript {
  inspect?: (input: Record<string, unknown>) => unknown;
  validate?: (spaceIr: OiSpaceIrDoc) => OiValidation;
  compile?: (spaceIr: OiSpaceIrDoc) => OiCompiled;
  commit?: (input: Record<string, unknown>) => OiCommitted;
  head?: (input: Record<string, unknown>) => { scene_id: string; revision: number; name: string };
}
export class OiMockTransport implements OiTransport {
  readonly calls: Array<{ op: OiOp; payload: Record<string, unknown> }> = [];
  constructor(private readonly script: OiMockScript = {}) {}
  async request<T>(op: OiOp, payload: Record<string, unknown>): Promise<T> {
    this.calls.push({ op, payload });
    if (op === 'reconstruction') throw new OiError('OI_RECONSTRUCTION_UNSUPPORTED', 'Reconstruction tests require the pinned real OI runtime.');
    if (op === 'inspect') {
      if (!this.script.inspect) throw new OiError('OI_INSPECTION_UNSUPPORTED', 'Mock reference inspection needs an explicit fixture.');
      return { ...this.script.inspect(payload) as object, mock: true } as T;
    }
    if (op === 'validate') {
      const fn =
        this.script.validate ??
        (() => ({ valid: true, findings: [{ code: 'MOCK_TRANSPORT', path: '$', message: 'Mock validation, not an OI verdict.', severity: 'unresolved' as const }] }));
      return fn(payload.spaceIr as OiSpaceIrDoc) as T;
    }
    if (op === 'compile') {
      const fn =
        this.script.compile ??
        ((spaceIr: OiSpaceIrDoc) => ({
          workspace: { room: [spaceIr.site?.width_m ?? 0, spaceIr.site?.depth_m ?? 0, spaceIr.site?.height_m ?? 0], items: [], mock: true },
          source_sha256: 'mock'.padEnd(64, '0'),
          bindings: [],
          diagnostics: [{ code: 'MOCK_TRANSPORT', entity_id: spaceIr.id, message: 'Mock compile, not an OI verdict.' }],
        }));
      return fn(payload.spaceIr as OiSpaceIrDoc) as T;
    }
    if (op === 'commit') {
      const fn =
        this.script.commit ??
        ((input: Record<string, unknown>) => {
          const sceneId = typeof input.sceneId === 'string' ? input.sceneId : randomUUID();
          const origin = typeof input.workbenchOrigin === 'string' ? input.workbenchOrigin : OI_DEFAULT_WORKBENCH_ORIGIN;
          return {
            scene_id: sceneId,
            revision: 1,
            name: typeof input.name === 'string' ? input.name : 'mock-scene',
            head_url: `${origin}/?sceneId=${sceneId}`,
            revision_url: `${origin}/?sceneId=${sceneId}&revision=1`,
          };
        });
      return fn(payload) as T;
    }
    const fn = this.script.head ?? ((input: Record<string, unknown>) => ({ scene_id: String(input.sceneId), revision: 1, name: 'mock-scene' }));
    return fn(payload) as T;
  }
}

export interface FloorPlanFlowInput {
  observations: FloorPlanObservations;
  source: OiSource;
  run: { model: string; promptVersion: string; mock: boolean };
  oi: {
    root: string;
    dataDir: string;
    workbenchOrigin?: string;
    sceneName?: string;
    sceneId?: string;
    baseRevision?: number;
    requestId?: string;
    assumedHeightM?: number;
    docId?: string;
    agent?: string;
  };
  transport: OiTransport;
}
export interface FloorPlanFlowResult {
  spaceIr: OiSpaceIrDoc;
  oiIdentity: OiIdentity;
  validation: OiValidation;
  compiled: OiCompiled;
  committed: OiCommitted;
  mock: boolean;
}

// Validate -> compile -> commit through OI. OI verdicts (findings,
// diagnostics, conflicts) propagate untouched; only transport and
// request-shaping failures originate here.
export async function runFloorPlanFlow(input: FloorPlanFlowInput): Promise<FloorPlanFlowResult> {
  const spaceIr = buildSpaceIr(input.observations, input.source, { docId: input.oi.docId, assumedHeightM: input.oi.assumedHeightM });
  const oiIdentity = input.run.mock
    ? { repo: OI_REPO, pinnedSha: OI_PIN_SHA, actualSha: null, version: null, pinned: false, markers: { spaceIr: false, compiler: false, planViewport: false, localBackend: false } }
    : await readOiIdentity(input.oi.root);
  const validation = await input.transport.request<OiValidation>('validate', { spaceIr });
  if (!validation.valid) {
    const codes = validation.findings
      .filter((f) => f.severity === 'error')
      .map((f) => `${f.code}@${f.path}`)
      .join('; ');
    throw new OiError('OI_SPACE_IR_INVALID', `OI rejected the SpaceIR document: ${codes || 'unknown'}.`, {
      upstream: !input.run.mock,
      details: validation.findings,
    });
  }
  const compiled = await input.transport.request<OiCompiled>('compile', { spaceIr });
  const sceneId = input.oi.sceneId ?? randomUUID();
  const committed = await input.transport.request<OiCommitted>('commit', {
    workspace: compiled.workspace,
    name: input.oi.sceneName ?? `fieldops-${input.source.sourceId}`,
    sceneId,
    baseRevision: input.oi.baseRevision ?? 0,
    requestId: input.oi.requestId ?? randomUUID(),
    dataDir: input.oi.dataDir,
    workbenchOrigin: input.oi.workbenchOrigin ?? OI_DEFAULT_WORKBENCH_ORIGIN,
    agent: input.oi.agent ?? 'fieldops-connector',
  });
  return { spaceIr, oiIdentity, validation, compiled, committed, mock: input.run.mock };
}
