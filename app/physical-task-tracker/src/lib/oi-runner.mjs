// OI runner: executes pinned OpenIndustries operations inside the OI
// checkout and speaks JSON over stdio to oi-connector.ts.
//
// Run as (cwd = OI checkout, needs its node_modules with tsx):
//   node --import tsx/esm oi-runner.mjs < request.json
//
// stdin:  { op: 'validate'|'compile'|'commit'|'head', payload: {...} }
// stdout: { ok: true, result } or { ok: false, code, message, details?, upstream? }
//
// Every spatial verdict comes from OI modules (space-ir validator, scene
// compiler, local backend, scene links). This file only wires stdin/stdout
// to those entry points; it contains no spatial logic of its own.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const ROOT = process.env.OI_RUNNER_ROOT || process.cwd();
const STDIN_LIMIT = 75 * 1024 * 1024;
const MANIFEST_LIMIT = 1024 * 1024;

const mod = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

function fail(code, message, details = null, upstream = true) {
  return { ok: false, code, message, details, upstream };
}
function errCode(error) {
  return typeof error?.code === 'string' ? error.code : 'RUNNER_FAILED';
}
function errMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function opValidate(payload) {
  const { validateSpaceIR } = await mod('packages/space-ir/src/index.ts');
  return validateSpaceIR(payload.spaceIr);
}

async function opCompile(payload) {
  const { compileSpaceIR } = await mod('src/lib/space-ir-compiler.ts');
  return await compileSpaceIR(payload.spaceIr);
}

async function opHead(payload) {
  const { LocalSceneBackend } = await mod('server/local-scene-backend.ts');
  const backend = new LocalSceneBackend(payload.dataDir);
  try {
    const saved = await backend.read(payload.sceneId, payload.revision);
    return { scene_id: saved.id, revision: saved.revision, name: saved.name };
  } finally {
    backend.close();
  }
}

async function opCommit(payload) {
  const { sceneId, baseRevision, requestId, dataDir, workbenchOrigin, agent } = payload;
  if (typeof sceneId !== 'string' || !sceneId) throw Object.assign(new Error('commit needs sceneId.'), { code: 'INVALID_REQUEST' });
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw Object.assign(new Error('commit needs a base revision >= 0 (0 creates).'), { code: 'INVALID_REQUEST' });
  if (typeof requestId !== 'string' || !requestId) throw Object.assign(new Error('commit needs requestId.'), { code: 'INVALID_REQUEST' });
  if (typeof dataDir !== 'string' || !dataDir) throw Object.assign(new Error('commit needs dataDir.'), { code: 'INVALID_REQUEST' });
  const { LocalSceneBackend } = await mod('server/local-scene-backend.ts');
  const { makeManifest, canonicalJSON } = await mod('src/lib/workspace.ts');
  const { sceneURLs } = await mod('src/lib/scene-links.ts');
  const backend = new LocalSceneBackend(dataDir);
  try {
    const workspace = payload.workspace;
    // Verify geometry into immutable local asset versions. Client-supplied
    // bindings are never trusted (same rule as OI's own localSceneRequest).
    const verified = new Map();
    const versions = new Map();
    for (const item of workspace.items ?? []) {
      let actual = verified.get(item.asset);
      if (actual === undefined) {
        actual = await backend.persistAsset(item.asset);
        verified.set(item.asset, actual);
      }
      if (item.cloudVersionId && item.cloudVersionId !== actual) {
        throw Object.assign(new Error('Geometry does not match its immutable local asset version.'), { code: 'INVALID_ASSET' });
      }
      const existing = versions.get(item.asset.id);
      if (existing && existing !== actual) {
        throw Object.assign(new Error('One asset ID cannot name different versions.'), { code: 'INVALID_ASSET' });
      }
      versions.set(item.asset.id, actual);
      item.cloudVersionId = actual;
    }
    const manifest = makeManifest(workspace);
    const digest = createHash('sha256')
      .update(canonicalJSON({ id: sceneId, request_id: requestId, base_revision: baseRevision, document: manifest }))
      .digest('hex');
    const receipt = await backend.receipt(sceneId, requestId);
    if (receipt) {
      if (receipt.document?.authoring?.request_digest !== digest) {
        throw Object.assign(new Error('This request ID already names a different write.'), { code: 'REQUEST_ID_REUSED' });
      }
      return { scene_id: receipt.id, revision: receipt.revision, name: receipt.name, ...sceneURLs(receipt.id, receipt.revision, workbenchOrigin) };
    }
    const document = {
      ...manifest,
      authoring: { via: 'fieldops-connector', agent: agent || 'fieldops-connector', parent_revision: baseRevision || null, request_id: requestId, request_digest: digest },
    };
    if (Buffer.byteLength(JSON.stringify(document)) > MANIFEST_LIMIT) {
      throw Object.assign(new Error('Scene metadata exceeds 1 MiB.'), { code: 'PAYLOAD_TOO_LARGE' });
    }
    const saved = await backend.save(sceneId, payload.name || 'fieldops-space', document, baseRevision, requestId);
    return { scene_id: saved.id, revision: saved.revision, name: saved.name, ...sceneURLs(saved.id, saved.revision, workbenchOrigin) };
  } finally {
    backend.close();
  }
}

async function main() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > STDIN_LIMIT) {
      console.log(JSON.stringify(fail('PAYLOAD_TOO_LARGE', 'Runner request exceeds 75 MiB.', null, false)));
      return;
    }
    chunks.push(chunk);
  }
  let request;
  try {
    request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    console.log(JSON.stringify(fail('INVALID_REQUEST', 'Runner request is not JSON.', null, false)));
    return;
  }
  try {
    const { op, payload } = request;
    if (op === 'validate') console.log(JSON.stringify({ ok: true, result: await opValidate(payload) }));
    else if (op === 'compile') console.log(JSON.stringify({ ok: true, result: await opCompile(payload) }));
    else if (op === 'commit') console.log(JSON.stringify({ ok: true, result: await opCommit(payload) }));
    else if (op === 'head') console.log(JSON.stringify({ ok: true, result: await opHead(payload) }));
    else console.log(JSON.stringify(fail('INVALID_REQUEST', `Unknown runner op "${op}".`, null, false)));
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(errMessage(error, ''))) {
      console.log(JSON.stringify(fail('OI_LAYOUT_UNSUPPORTED', `OI checkout at ${ROOT} lacks a pinned module: ${errMessage(error, 'unknown')}. Check out the pinned commit and run npm install there.`, null, false)));
      return;
    }
    const code = errCode(error);
    const details = error?.details ?? error?.findings ?? null;
    console.log(JSON.stringify(fail(code, errMessage(error, `OI ${request?.op} failed.`), details, true)));
  }
}

main();
