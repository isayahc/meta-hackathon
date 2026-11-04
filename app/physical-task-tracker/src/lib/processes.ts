// Farmer process model: a typed, versioned account of work derived from
// video/spot evidence. Observed temporal order (when footage shows a step)
// stays separate from required precedence (what must come first).
// Claim status (how sure the model is) stays separate from execution
// status (how far the work got). Unsupported details stay unknown —
// partial footage can never establish completion.
//
// Storage reuses fieldops.db: one row per (process id, revision) in the
// processes table. Corrections append revisions; original claims stay
// readable. Downstream docs (optimizer plan) stamp the process revisions
// they were built from and go stale when a correction lands.
// No dependencies beyond node:sqlite (via lib/db).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { withDb, getDoc, setDoc } from './db.js';

export const PROCESS_SCHEMA = 'farm-process/1';

export type ClaimStatus = 'observed' | 'inferred' | 'corrected' | 'unknown';
export type ExecutionStatus = 'not_started' | 'in_progress' | 'complete' | 'unknown';

export interface TimeSpan {
  start_s: number;
  end_s: number;
  frame?: number | null;
}

export interface StepEvidence {
  media: string | null;
  spans: TimeSpan[];
  coverage_note?: string | null;
}

export type RepeatSpec = { times: number } | { until: string };

export interface ProcessStep {
  id: string;
  label: string;
  claim: ClaimStatus;
  execution: ExecutionStatus;
  inputs: string[];
  outputs: string[];
  tools: string[];
  materials: string[];
  actors: string[];
  preconditions: string[];
  completion_criteria: string[];
  criteria_evidence: Record<string, TimeSpan[]>;
  requires: string[];
  requires_unknown: boolean;
  observed_order: number | null;
  repeat: RepeatSpec | null;
  location: string | null;
  evidence: StepEvidence;
  unknowns: string[];
}

export interface ProcessGoal {
  id: string;
  label: string;
  claim: ClaimStatus;
  execution: ExecutionStatus;
  completion_criteria: string[];
  step_ids: string[];
}

export interface ProcessProvenance {
  model: string;
  prompt_version: string;
  recorded_at: string | null;
  source_event_id: string | null;
}

export interface ProcessCorrection {
  rev: number;
  at: string;
  rationale: string;
  paths: string[];
}

export interface ProcessDoc {
  schema: 'farm-process/1';
  id: string;
  rev: number;
  title: string;
  stage: string | null;
  goals: ProcessGoal[];
  steps: ProcessStep[];
  coverage: { observed_spans: TimeSpan[]; total_s: number | null; coverage_note?: string | null };
  gaps: string[];
  order_notes: string[];
  unknowns: string[];
  confidence: 'low' | 'medium' | 'high' | null;
  provenance: ProcessProvenance;
  corrections: ProcessCorrection[];
  created_at: string;
  updated_at: string;
}

export class ProcessError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const CLAIMS: ReadonlySet<string> = new Set(['observed', 'inferred', 'corrected', 'unknown']);
const EXECUTIONS: ReadonlySet<string> = new Set(['not_started', 'in_progress', 'complete', 'unknown']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertSpan(span: unknown, where: string, totalS: number | null): TimeSpan {
  if (!isRecord(span) || typeof span.start_s !== 'number' || typeof span.end_s !== 'number') {
    throw new ProcessError('PROC_BAD_TIMESTAMP', `${where}: span needs numeric start_s/end_s.`);
  }
  const { start_s: start, end_s: end } = span as { start_s: number; end_s: number };
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0) {
    throw new ProcessError('PROC_BAD_TIMESTAMP', `${where}: span times must be finite seconds >= 0.`);
  }
  if (end < start) {
    throw new ProcessError('PROC_BAD_TIMESTAMP', `${where}: span ends (${end}s) before it starts (${start}s).`);
  }
  if (totalS !== null && (start > totalS || end > totalS)) {
    throw new ProcessError('PROC_BAD_TIMESTAMP', `${where}: span [${start}s, ${end}s] exceeds footage length ${totalS}s.`);
  }
  return {
    start_s: start,
    end_s: end,
    frame: typeof span.frame === 'number' ? span.frame : null,
  };
}

function findRequireCycle(steps: ProcessStep[]): string[] | null {
  const edges = new Map(steps.map((s) => [s.id, s.requires]));
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 'open');
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      if (state.get(next) === 'open') return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) {
        const hit = visit(next);
        if (hit) return hit;
      }
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };
  for (const s of steps) {
    if (!state.has(s.id)) {
      const hit = visit(s.id);
      if (hit) return hit;
    }
  }
  return null;
}

// Structural validation: rejects malformed docs, unknown references,
// required-dependency cycles, bad timestamps, and completion claims that
// the evidence cannot support. Missing evidence itself is surfaced by
// normalizeProcess, not rejected here.
export function validateProcess(doc: unknown): ProcessDoc {
  if (!isRecord(doc)) throw new ProcessError('PROC_SCHEMA', 'Process must be an object.');
  if (doc.schema !== PROCESS_SCHEMA) {
    throw new ProcessError('PROC_SCHEMA', `Unsupported process schema "${String(doc.schema)}": want ${PROCESS_SCHEMA}.`);
  }
  if (typeof doc.id !== 'string' || !doc.id.trim()) throw new ProcessError('PROC_SCHEMA', 'Process id is required.');
  if (!Array.isArray(doc.steps)) throw new ProcessError('PROC_SCHEMA', 'Process steps must be an array.');
  if (!Array.isArray(doc.goals)) throw new ProcessError('PROC_SCHEMA', 'Process goals must be an array.');
  const totalS = isRecord(doc.coverage) && (typeof doc.coverage.total_s === 'number' || doc.coverage.total_s === null)
    ? (doc.coverage.total_s as number | null)
    : null;
  if (isRecord(doc.coverage) && typeof doc.coverage.total_s === 'number' && (!Number.isFinite(doc.coverage.total_s) || (doc.coverage.total_s as number) < 0)) {
    throw new ProcessError('PROC_BAD_TIMESTAMP', 'coverage.total_s must be finite seconds >= 0 or null.');
  }

  const seen = new Set<string>();
  for (const s of doc.steps) {
    if (!isRecord(s) || typeof s.id !== 'string' || !s.id.trim()) {
      throw new ProcessError('PROC_SCHEMA', 'Every step needs a non-empty string id.');
    }
    if (seen.has(s.id)) throw new ProcessError('PROC_DUP_ID', `Duplicate step id "${s.id}".`);
    seen.add(s.id);
  }
  const goalSeen = new Set<string>();
  for (const g of doc.goals) {
    if (!isRecord(g) || typeof g.id !== 'string' || !g.id.trim()) {
      throw new ProcessError('PROC_SCHEMA', 'Every goal needs a non-empty string id.');
    }
    if (goalSeen.has(g.id)) throw new ProcessError('PROC_DUP_ID', `Duplicate goal id "${g.id}".`);
    goalSeen.add(g.id);
  }

  const steps = doc.steps as ProcessStep[];
  for (const s of steps) {
    if (!CLAIMS.has(s.claim)) throw new ProcessError('PROC_BAD_STATUS', `Step "${s.id}": bad claim "${String(s.claim)}".`);
    if (!EXECUTIONS.has(s.execution)) throw new ProcessError('PROC_BAD_STATUS', `Step "${s.id}": bad execution "${String(s.execution)}".`);
    if (!Array.isArray(s.requires) || s.requires.some((r) => typeof r !== 'string')) {
      throw new ProcessError('PROC_SCHEMA', `Step "${s.id}": requires must be an array of step ids.`);
    }
    for (const r of s.requires) {
      if (!seen.has(r)) throw new ProcessError('PROC_UNKNOWN_REQUIRE', `Step "${s.id}" requires unknown step "${r}".`);
    }
    if (s.repeat !== null && s.repeat !== undefined) {
      const times = (s.repeat as { times?: unknown }).times;
      const until = (s.repeat as { until?: unknown }).until;
      if (typeof times === 'number') {
        if (!Number.isInteger(times) || times < 1) {
          throw new ProcessError('PROC_BAD_REPEAT', `Step "${s.id}": repeat.times must be an integer >= 1.`);
        }
      } else if (typeof until === 'string') {
        if (!until.trim()) throw new ProcessError('PROC_BAD_REPEAT', `Step "${s.id}": repeat.until must be non-empty.`);
      } else {
        throw new ProcessError('PROC_BAD_REPEAT', `Step "${s.id}": repeat must be { times: n } or { until: ... }.`);
      }
    }
    if (!isRecord(s.evidence) || !Array.isArray((s.evidence as { spans?: unknown }).spans)) {
      throw new ProcessError('PROC_SCHEMA', `Step "${s.id}": evidence.spans must be an array.`);
    }
    for (const span of (s.evidence as StepEvidence).spans) assertSpan(span, `step "${s.id}" evidence`, totalS);
    if (!isRecord(s.criteria_evidence)) {
      throw new ProcessError('PROC_SCHEMA', `Step "${s.id}": criteria_evidence must be an object.`);
    }
    const criteria = Array.isArray(s.completion_criteria) ? s.completion_criteria : [];
    for (const [criterion, spans] of Object.entries(s.criteria_evidence)) {
      if (!criteria.includes(criterion)) {
        throw new ProcessError('PROC_UNKNOWN_CRITERION', `Step "${s.id}": evidence for unlisted criterion "${criterion}".`);
      }
      if (!Array.isArray(spans)) throw new ProcessError('PROC_SCHEMA', `Step "${s.id}": criterion evidence must be arrays of spans.`);
      for (const span of spans) assertSpan(span, `step "${s.id}" criterion "${criterion}"`, totalS);
    }
    if (s.execution === 'complete') {
      if (!criteria.length) {
        throw new ProcessError('PROC_UNEVIDENCED_COMPLETION', `Step "${s.id}": complete needs at least one completion criterion.`);
      }
      const bare = criteria.filter((c) => !((s.criteria_evidence[c] ?? []).length));
      if (bare.length) {
        throw new ProcessError('PROC_UNEVIDENCED_COMPLETION', `Step "${s.id}": complete needs evidence for: ${bare.join(', ')}.`);
      }
    }
  }

  const cycle = findRequireCycle(steps);
  if (cycle) {
    throw new ProcessError('PROC_CYCLE', `Required dependencies cycle: ${cycle.join(' -> ')}.`);
  }

  for (const g of doc.goals as ProcessGoal[]) {
    if (!CLAIMS.has(g.claim)) throw new ProcessError('PROC_BAD_STATUS', `Goal "${g.id}": bad claim "${String(g.claim)}".`);
    if (!EXECUTIONS.has(g.execution)) throw new ProcessError('PROC_BAD_STATUS', `Goal "${g.id}": bad execution "${String(g.execution)}".`);
    if (!Array.isArray(g.step_ids) || g.step_ids.some((id) => typeof id !== 'string')) {
      throw new ProcessError('PROC_SCHEMA', `Goal "${g.id}": step_ids must be an array of step ids.`);
    }
    for (const id of g.step_ids) {
      if (!seen.has(id)) throw new ProcessError('PROC_UNKNOWN_REQUIRE', `Goal "${g.id}" references unknown step "${id}".`);
    }
    if (g.execution === 'complete') {
      if (!g.step_ids.length) {
        throw new ProcessError('PROC_UNEVIDENCED_COMPLETION', `Goal "${g.id}": complete needs at least one step.`);
      }
      const open = g.step_ids.filter((id) => steps.find((s) => s.id === id)?.execution !== 'complete');
      if (open.length) {
        throw new ProcessError('PROC_UNEVIDENCED_COMPLETION', `Goal "${g.id}": complete needs these steps complete: ${open.join(', ')}.`);
      }
    }
  }

  if (isRecord(doc.coverage) && Array.isArray(doc.coverage.observed_spans)) {
    for (const span of doc.coverage.observed_spans as unknown[]) assertSpan(span, 'coverage', totalS);
  }
  if (doc.confidence !== null && doc.confidence !== 'low' && doc.confidence !== 'medium' && doc.confidence !== 'high') {
    throw new ProcessError('PROC_BAD_STATUS', `Bad confidence "${String(doc.confidence)}": want low, medium, high, or null.`);
  }
  if ((doc as { stage?: unknown }).stage !== null && typeof (doc as { stage?: unknown }).stage !== 'string') {
    throw new ProcessError('PROC_SCHEMA', 'Process stage must be a string or null.');
  }
  return doc as unknown as ProcessDoc;
}

// Surface (never reject): missing evidence becomes gaps, unsupported model
// claims become unknown, ambiguous or prerequisite-defying order becomes
// notes. Farmer corrections ('corrected') are never downgraded.
export function normalizeProcess(doc: ProcessDoc): ProcessDoc {
  const out: ProcessDoc = structuredClone(doc);
  const gaps: string[] = [];
  for (const s of out.steps) {
    const spans = s.evidence.spans.length + Object.values(s.criteria_evidence).reduce((n, v) => n + v.length, 0);
    // Supported = timestamped spans, or an observed frame in known media.
    const supported = spans > 0 || (s.observed_order !== null && s.observed_order !== undefined && s.evidence.media !== null);
    if (!supported) {
      gaps.push(`step "${s.id}": no supporting footage`);
      if (s.claim !== 'corrected') s.claim = 'unknown';
    } else if (spans === 0) {
      gaps.push(`step "${s.id}": frame timestamps unavailable`);
    }
    for (const c of s.completion_criteria) {
      if (!(s.criteria_evidence[c] ?? []).length) gaps.push(`step "${s.id}" criterion "${c}": unevidenced`);
    }
  }
  if (!out.coverage.observed_spans.length && out.coverage.total_s === null) {
    gaps.push('footage coverage unknown: no observed spans and no total length');
  }
  out.gaps = [...new Set(gaps)];

  const notes: string[] = [];
  const byOrder = new Map<number, string[]>();
  for (const s of out.steps) {
    if (s.observed_order !== null && s.observed_order !== undefined) {
      const list = byOrder.get(s.observed_order) ?? [];
      list.push(s.id);
      byOrder.set(s.observed_order, list);
    }
  }
  for (const [order, ids] of [...byOrder.entries()].sort((a, b) => a[0] - b[0])) {
    if (ids.length > 1) notes.push(`steps ${ids.join(', ')} share observed order ${order} (ambiguous)`);
  }
  const orderOf = new Map(out.steps.map((s) => [s.id, s.observed_order]));
  for (const s of out.steps) {
    const mine = orderOf.get(s.id);
    if (mine === null || mine === undefined) continue;
    for (const req of s.requires) {
      const theirs = orderOf.get(req);
      if (theirs !== null && theirs !== undefined && mine < theirs) {
        notes.push(`step "${s.id}" observed before its prerequisite "${req}" (out-of-order footage or repeat)`);
      }
    }
  }
  out.order_notes = notes;
  return out;
}

// Completion support: a 'complete' claim must resolve against real source
// media and observed coverage, not just well-formed numbers. Isolated
// sampled instants prove instants, never intervals: an interval criterion
// needs continuous coverage. Call after validateProcess; non-complete
// steps are untouched (missing evidence blocks completion, never the doc).
export interface SourceContext {
  mediaPresent: (media: string | null) => boolean;
}

export function validateCompletion(doc: ProcessDoc, ctx: SourceContext): void {
  const totalS = doc.coverage.total_s;
  const covered = doc.coverage.observed_spans;
  const framed = new Set(covered.map((o) => o.frame).filter((f): f is number => typeof f === 'number'));
  const supports = (span: TimeSpan): boolean => {
    if (span.frame !== null && span.frame !== undefined && !framed.has(span.frame)) return false;
    if (span.start_s === span.end_s) {
      return covered.some((o) => o.start_s <= span.start_s && span.start_s <= o.end_s);
    }
    let reach = span.start_s;
    for (const o of [...covered].sort((a, b) => a.start_s - b.start_s)) {
      if (o.start_s > reach) break;
      reach = Math.max(reach, o.end_s);
      if (reach >= span.end_s) return true;
    }
    return false;
  };
  for (const s of doc.steps) {
    if (s.execution !== 'complete') continue;
    if (s.evidence.media === null || !ctx.mediaPresent(s.evidence.media)) {
      throw new ProcessError('PROC_UNEVIDENCED_COMPLETION', `Step "${s.id}": complete needs resolvable source media.`);
    }
    if (totalS === null) {
      throw new ProcessError('PROC_UNEVIDENCED_COMPLETION', `Step "${s.id}": complete needs known footage bounds.`);
    }
    for (const spans of Object.values(s.criteria_evidence)) {
      for (const span of spans) {
        if (!supports(span)) {
          throw new ProcessError(
            'PROC_UNEVIDENCED_COMPLETION',
            `Step "${s.id}": span [${span.start_s}s, ${span.end_s}s] is not covered by observed footage.`
          );
        }
      }
    }
  }
}

function mediaFilePresent(root: string, media: string | null): boolean {
  if (typeof media !== 'string' || !media || media.includes('/') || media.includes('\\')) return false;
  try {
    return existsSync(join(root, 'media', media));
  } catch {
    return false;
  }
}

// Occurrences a repeated step stands for: a fixed count, or null when the
// repeat runs until a condition (count unknowable upfront).
export function occurrencesOf(step: ProcessStep): number | null {
  if (step.repeat === null || step.repeat === undefined) return 1;
  if (typeof (step.repeat as { times?: unknown }).times === 'number') return (step.repeat as { times: number }).times;
  return null;
}

export interface ScanAnalysisInput {
  observed_task?: unknown;
  stage?: unknown;
  per_frame?: unknown;
  suggested_next_steps?: unknown;
  confidence?: unknown;
  unknowns?: unknown;
  frame_times_s?: unknown;
  video_duration_s?: unknown;
  frame_times_estimated?: unknown;
}

export interface BuildProcessInput {
  id?: string;
  title?: string;
  analysis: ScanAnalysisInput;
  media?: string | null;
  eventId?: string | null;
  model?: string;
  promptVersion?: string;
  recordedAt?: string | null;
  duration_s?: number | null;
}

function cleanLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
}

// A video scan yields a process: the observed task becomes the goal and
// each suggested next step becomes an inferred, not-started step. Nothing
// is marked observed or complete — the scan never saw these steps happen.
export function buildProcessFromScan(input: BuildProcessInput): ProcessDoc {
  const id = input.id?.trim() || `proc-${input.eventId ?? Date.now()}`;
  const stepsRaw = cleanLines(input.analysis.suggested_next_steps);
  const frames = cleanLines(input.analysis.per_frame);
  const durationRaw = typeof input.duration_s === 'number' && Number.isFinite(input.duration_s) && input.duration_s > 0
    ? input.duration_s
    : input.analysis.video_duration_s;
  const totalS = typeof durationRaw === 'number' && Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null;
  const timesRaw = Array.isArray(input.analysis.frame_times_s) ? input.analysis.frame_times_s : [];
  const frameTimes: Array<number | null> = timesRaw.map((t) => (typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t : null));
  const estimated = input.analysis.frame_times_estimated === true;
  const now = new Date().toISOString();
  const confidenceRaw = input.analysis.confidence;
  const confidence = confidenceRaw === 'low' || confidenceRaw === 'medium' || confidenceRaw === 'high' ? confidenceRaw : null;
  const observedTask = typeof input.analysis.observed_task === 'string' && input.analysis.observed_task.trim()
    ? input.analysis.observed_task.trim()
    : null;
  const stage = typeof input.analysis.stage === 'string' && input.analysis.stage.trim()
    ? input.analysis.stage.trim()
    : null;
  const media = input.media ?? null;

  // Sampled instants only — never the intervals between isolated frames.
  const observedSpans: TimeSpan[] = [];
  frameTimes.forEach((t, i) => {
    if (t !== null) observedSpans.push({ start_s: t, end_s: t, frame: i });
  });
  let coverageNote: string | null = null;
  if (observedSpans.length && estimated) {
    coverageNote = totalS !== null
      ? `frame spans estimated from ${frameTimes.length} frames over ${totalS}s`
      : 'frame times estimated (total length unknown)';
  } else if (!observedSpans.length && (frames.length || frameTimes.length)) {
    coverageNote = 'frame timestamps unavailable; sampled instants unknown';
  }

  const emptyStep = {
    inputs: [] as string[],
    outputs: [] as string[],
    tools: [] as string[],
    materials: [] as string[],
    actors: [] as string[],
    preconditions: [] as string[],
    completion_criteria: [] as string[],
    criteria_evidence: {} as Record<string, TimeSpan[]>,
    requires: [] as string[],
    requires_unknown: true,
    repeat: null,
    location: null,
    unknowns: [] as string[],
  };
  const observedSteps: ProcessStep[] = frames.map((label, i) => {
    const t = frameTimes[i] ?? null;
    return {
      ...structuredClone(emptyStep),
      id: `${id}-o${i}`,
      label,
      claim: 'observed' as ClaimStatus,
      execution: 'unknown' as ExecutionStatus,
      observed_order: i,
      evidence: { media, spans: t === null ? [] : [{ start_s: t, end_s: t, frame: i }] },
    };
  });
  const proposedSteps: ProcessStep[] = stepsRaw.map((label, i) => ({
    ...structuredClone(emptyStep),
    id: `${id}-s${i}`,
    label,
    claim: 'inferred' as ClaimStatus,
    execution: 'not_started' as ExecutionStatus,
    observed_order: null,
    evidence: { media, spans: [] },
  }));

  const doc: ProcessDoc = {
    schema: PROCESS_SCHEMA,
    id,
    rev: 1,
    title: input.title?.trim() || observedTask || 'Untitled process',
    stage,
    goals: [
      {
        id: `${id}-g0`,
        label: observedTask ?? 'Work in footage',
        claim: observedTask ? 'observed' : 'unknown',
        execution: 'unknown',
        completion_criteria: [],
        step_ids: [...observedSteps, ...proposedSteps].map((s) => s.id),
      },
    ],
    steps: [...observedSteps, ...proposedSteps],
    coverage: { observed_spans: observedSpans, total_s: totalS, coverage_note: coverageNote },
    gaps: [],
    order_notes: [],
    unknowns: cleanLines(input.analysis.unknowns),
    confidence,
    provenance: {
      model: input.model ?? 'unknown',
      prompt_version: input.promptVersion ?? 'unknown',
      recorded_at: input.recordedAt ?? null,
      source_event_id: input.eventId ?? null,
    },
    corrections: [],
    created_at: now,
    updated_at: now,
  };
  return normalizeProcess(validateProcess(doc));
}

interface ProcessRow {
  id: string;
  rev: number;
  body: string;
  author: string;
  created: string;
}

export async function saveRevision(root: string, doc: ProcessDoc, author = 'model'): Promise<ProcessDoc> {
  const clean = normalizeProcess(validateProcess(doc));
  validateCompletion(clean, { mediaPresent: (m) => mediaFilePresent(root, m) });
  return withDb(root, (db) => {
    const prior = db.prepare('SELECT rev FROM processes WHERE id = ? AND rev = ?').get(clean.id, clean.rev) as
      | { rev: number }
      | undefined;
    if (prior) throw new ProcessError('PROC_REV_EXISTS', `Revision ${clean.rev} of "${clean.id}" already exists.`);
    db.prepare('INSERT INTO processes(id, rev, body, author, created) VALUES(?, ?, ?, ?, ?)').run(
      clean.id,
      clean.rev,
      JSON.stringify(clean),
      author,
      new Date().toISOString()
    );
    return clean;
  });
}

export async function readProcess(root: string, id: string, rev: number | null = null): Promise<ProcessDoc> {
  return withDb(root, (db) => {
    const row = (
      rev === null
        ? db.prepare('SELECT body FROM processes WHERE id = ? ORDER BY rev DESC LIMIT 1').get(id)
        : db.prepare('SELECT body FROM processes WHERE id = ? AND rev = ?').get(id, rev)
    ) as { body: string } | undefined;
    if (!row) throw new Error(rev === null ? `No process "${id}".` : `No process "${id}" rev ${rev}.`);
    return JSON.parse(row.body) as ProcessDoc;
  });
}

export interface ProcessCurrent {
  process_id: string;
  rev: number;
  title: string;
  updated_at: string;
}

export async function listProcesses(root: string): Promise<ProcessCurrent[]> {
  return withDb(root, (db) => {
    const rows = db.prepare(
      'SELECT p1.id AS process_id, p1.rev AS rev, p1.body AS body FROM processes p1 WHERE p1.rev = (SELECT MAX(p2.rev) FROM processes p2 WHERE p2.id = p1.id) ORDER BY p1.id'
    ).all() as Array<{ process_id: string; rev: number; body: string }>;
    return rows.map((r) => {
      const body = JSON.parse(r.body) as ProcessDoc;
      return { process_id: r.process_id, rev: r.rev, title: body.title, updated_at: body.updated_at };
    });
  });
}

export interface CorrectionPatch {
  title?: string;
  confidence?: 'low' | 'medium' | 'high' | null;
  stage?: string | null;
  steps?: Record<string, Partial<ProcessStep>>;
  goals?: Record<string, Partial<ProcessGoal>>;
  add_steps?: ProcessStep[];
  remove_step_ids?: string[];
}

// Farmer (or operator) correction: patch the current revision, validate the
// merged result, and append it as a new revision. Original claims stay
// readable under older revs. Dependent analysis stamped with an older
// revision goes stale.
export async function applyCorrection(
  root: string,
  id: string,
  patch: CorrectionPatch,
  rationale: string,
  author = 'farmer'
): Promise<{ doc: ProcessDoc; staleDocs: string[] }> {
  if (!rationale?.trim()) throw new ProcessError('PROC_CORRECTION', 'A correction needs a rationale.');
  const current = await readProcess(root, id);
  const next: ProcessDoc = structuredClone(current);
  const paths: string[] = [];
  if (typeof patch.title === 'string' && patch.title.trim()) {
    next.title = patch.title.trim();
    paths.push('title');
  }
  if (patch.confidence !== undefined) {
    next.confidence = patch.confidence;
    paths.push('confidence');
  }
  if (patch.stage !== undefined) {
    next.stage = patch.stage;
    paths.push('stage');
  }
  const byId = new Map(next.steps.map((s) => [s.id, s]));
  for (const [stepId, partial] of Object.entries(patch.steps ?? {})) {
    const step = byId.get(stepId);
    if (!step) throw new ProcessError('PROC_UNKNOWN_STEP', `No step "${stepId}" in process "${id}".`);
    for (const [field, value] of Object.entries(partial)) {
      if (field === 'id' || value === undefined) continue;
      (step as unknown as Record<string, unknown>)[field] = value;
      paths.push(`steps.${stepId}.${field}`);
    }
    if (partial.claim === undefined) {
      step.claim = 'corrected';
      paths.push(`steps.${stepId}.claim`);
    }
  }
  const goalById = new Map(next.goals.map((g) => [g.id, g]));
  for (const [goalId, partial] of Object.entries(patch.goals ?? {})) {
    const goal = goalById.get(goalId);
    if (!goal) throw new ProcessError('PROC_UNKNOWN_STEP', `No goal "${goalId}" in process "${id}".`);
    for (const [field, value] of Object.entries(partial)) {
      if (field === 'id' || value === undefined) continue;
      (goal as unknown as Record<string, unknown>)[field] = value;
      paths.push(`goals.${goalId}.${field}`);
    }
    if (partial.claim === undefined) {
      goal.claim = 'corrected';
      paths.push(`goals.${goalId}.claim`);
    }
  }
  for (const step of patch.add_steps ?? []) {
    if (byId.has(step.id)) throw new ProcessError('PROC_DUP_ID', `Step "${step.id}" already exists in process "${id}".`);
    const added: ProcessStep = { ...structuredClone(step), claim: step.claim ?? 'corrected' };
    next.steps.push(added);
    byId.set(added.id, added);
    paths.push(`add_steps.${added.id}`);
  }
  for (const stepId of patch.remove_step_ids ?? []) {
    if (!byId.has(stepId)) throw new ProcessError('PROC_UNKNOWN_STEP', `No step "${stepId}" in process "${id}".`);
    next.steps = next.steps.filter((s) => s.id !== stepId);
    paths.push(`remove_steps.${stepId}`);
  }
  if (!paths.length) throw new ProcessError('PROC_CORRECTION', 'Correction patch touches nothing.');
  // Validate the merged result BEFORE assigning the new rev: a rejected
  // correction (cycle, bad timestamp, unevidenced completion) must leave
  // the stored revisions untouched.
  validateProcess(next);
  validateCompletion(next, { mediaPresent: (m) => mediaFilePresent(root, m) });
  next.rev = current.rev + 1;
  next.updated_at = new Date().toISOString();
  next.corrections = [...next.corrections, { rev: next.rev, at: next.updated_at, rationale: rationale.trim(), paths }];
  const saved = await saveRevision(root, next, author);
  const staleDocs = await markDependentStale(root, id, saved.rev);
  return { doc: saved, staleDocs };
}

// Docs whose recommendations were built from an older revision of this
// process are marked stale (never silently left current).
export async function markDependentStale(root: string, processId: string, newRev: number): Promise<string[]> {
  const flipped: string[] = [];
  for (const key of ['plan']) {
    const body = getDoc(root, key) as { process_basis?: unknown; stale?: unknown } | null;
    if (!body || typeof body !== 'object') continue;
    const basis = (body as { process_basis?: Array<{ process_id?: unknown; rev?: unknown }> }).process_basis;
    if (!Array.isArray(basis)) continue;
    const hit = basis.some((b) => b?.process_id === processId && typeof b?.rev === 'number' && (b.rev as number) < newRev);
    if (hit && (body as { stale?: unknown }).stale !== true) {
      setDoc(root, key, { ...body, stale: true, stale_reason: `process "${processId}" corrected to rev ${newRev}` });
      flipped.push(key);
    }
  }
  return flipped;
}
