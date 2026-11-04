/** Deployment contracts tested without binding ports or invoking a model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { initDb, withDb, DATABASE_VERSION } from './lib/db.js';
import { createServer } from './serve-dashboard.js';

/** Allocate an isolated deployment fixture, removed after each test. */
function project(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'container-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('legacy upgrade is versioned, once-only, and preserves corrected docs', t => {
  const root = project(t);
  writeFileSync(join(root, 'goals.json'), JSON.stringify([{ id:'old', text:'Legacy goal' }]));
  initDb(root);
  withDb(root, db => {
    assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, DATABASE_VERSION);
    db.prepare('DELETE FROM goals').run();
    db.prepare('INSERT INTO docs VALUES(?,?,?)').run('corrected', '{"human":true}', 'now');
  });
  withDb(root, db => {
    assert.equal(db.prepare('SELECT * FROM goals').all().length, 0, 'Do not resurrect deleted legacy data');
    assert.equal((db.prepare('SELECT body FROM docs WHERE key=?').get('corrected') as any).body, '{"human":true}');
  });
});

test('newer stores are refused and failed upgrades roll back all schema changes', t => {
  const root = project(t), file = join(root, 'fieldops.db');
  let db = new DatabaseSync(file);
  db.exec('PRAGMA user_version=999; CREATE TABLE future(value TEXT); INSERT INTO future VALUES(\'keep\')');db.close();
  const before = readFileSync(file);
  assert.throws(() => initDb(root), /newer than supported/);
  assert.deepEqual(readFileSync(file), before);
  db = new DatabaseSync(file);db.exec('PRAGMA user_version=0; CREATE TABLE docs(key TEXT)');db.close();
  assert.throws(() => initDb(root));
  db = new DatabaseSync(file);
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, 0);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='goals'").get(), undefined);
  assert.equal((db.prepare('SELECT value FROM future').get() as any).value, 'keep');db.close();
});

test('health probe drives the real handler and reports incompatible databases as unhealthy', async t => {
  const root = project(t), handler = createServer(root).listeners('request')[0] as Function;
  let status = 0, body = '';
  const request = async () => handler({method:'GET',url:'/healthz'}, {writeHead(code:number){status=code;},end(value:string){body=value;}});
  await request();assert.equal(status,200);assert.equal(JSON.parse(body).database_version,DATABASE_VERSION);
  const db = new DatabaseSync(join(root,'fieldops.db'));db.exec('PRAGMA user_version=999');db.close();
  await request();assert.equal(status,500);
});

test('container bind and SIGTERM draining leave the local default unchanged', t => {
  const root=project(t), shim=join(root,'http-shim.mjs');
  writeFileSync(shim, `import {Server} from 'node:http';
    Server.prototype.listen=function(port,host){console.log(JSON.stringify({port,host}));process.emit('SIGTERM');return this;};
    Server.prototype.close=function(callback){console.log('drained');callback();return this;};`);
  const entry=fileURLToPath(new URL('./serve-dashboard.js',import.meta.url));
  for(const [args,host] of [[[],'127.0.0.1'],[['--host','0.0.0.0'],'0.0.0.0']] as const){
    const result=spawnSync(process.execPath,['--import',shim,entry,root,...args],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);assert.ok(result.stdout.includes(JSON.stringify({port:8123,host})));assert.match(result.stdout,/drained/);
  }
});

test('offline archive handles WAL, media, checksum failures and nonempty restore targets', t => {
  const script=fileURLToPath(new URL('../../../docker/test_project_archive.py',import.meta.url));
  const result=spawnSync(process.env.PYTHON||(process.platform==='win32'?'python':'python3'),[script],{encoding:'utf8'});
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') { t.skip('Python is required for archive verification'); return; }
  assert.equal(result.status,0,result.stderr);
});
