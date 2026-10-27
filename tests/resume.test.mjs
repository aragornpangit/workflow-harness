#!/usr/bin/env node
// tests/resume.test.mjs — resume semantics regression for scripts/wf-runner.mjs
// Run: node tests/resume.test.mjs
//
// Semantics under test:
//   S1 fresh run: every agent() spawns once and journals one entry per call
//   S2 unchanged resume: all calls cache-hit, zero spawns
//   S3 changed prompt at call i: calls < i hit; call i and EVERYTHING AFTER re-runs (prefix invalidation)
//   S4 re-resume after a partial re-run: stale journal rows are superseded (last write wins) — all hit
//   S5 failed calls (null result) are never cache-hit: resume retries them

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const runner = path.join(repo, 'scripts', 'wf-runner.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-resume-test-'));
const outDir = path.join(tmp, 'runs');

fs.writeFileSync(path.join(tmp, 'mock-agent.mjs'), `#!/usr/bin/env node
let p = '';
process.stdin.on('data', (d) => (p += d));
process.stdin.on('end', () => process.stdout.write(JSON.stringify({ echo: p.trim().slice(0, 40) })));
`);
fs.writeFileSync(path.join(tmp, 'mock-fail.mjs'), `#!/usr/bin/env node
process.exit(1);
`);
fs.writeFileSync(path.join(tmp, 'agents.json'), JSON.stringify({
  agents: {
    default: { command: 'node ' + path.join(tmp, 'mock-agent.mjs'), output: 'json' },
    fail: { command: 'node ' + path.join(tmp, 'mock-fail.mjs'), output: 'text' },
  },
}, null, 2));

// call-0/1/3 prompts are stable; only call-2 varies with args — distinguishes
// per-index caching from prefix invalidation at call-2.
const wfMain = path.join(tmp, 'resume-test.workflow.mjs');
fs.writeFileSync(wfMain, `export const meta = { name: 'resume-test', description: 'resume semantics' }
const variant = (typeof args === 'string' && args) || 'v1'
const a = await agent('call-0 stable', { label: 'c0' })
const b = await agent('call-1 stable', { label: 'c1' })
const c = await agent('call-2 ' + variant, { label: 'c2' })
const d = await agent('call-3 stable', { label: 'c3' })
return { a, b, c, d }
`);

const wfFail = path.join(tmp, 'resume-fail.workflow.mjs');
fs.writeFileSync(wfFail, `export const meta = { name: 'resume-fail', description: 'failure retry' }
return { r: await agent('will fail', { label: 'boom', agentType: 'fail' }) }
`);

function run(wf, name, extra = []) {
  const r = spawnSync('node', [runner, wf, '--agents', path.join(tmp, 'agents.json'),
    '--name', name, '--out', outDir, ...extra], { encoding: 'utf8' });
  const runMeta = JSON.parse(fs.readFileSync(path.join(outDir, name, 'run.json'), 'utf8'));
  const result = JSON.parse(fs.readFileSync(path.join(outDir, name, 'result.json'), 'utf8'));
  return { status: r.status, runMeta, result, stderr: r.stderr };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('S1 fresh run spawns every call once', () => {
  const { runMeta, result } = run(wfMain, 'resume-test');
  assert.strictEqual(runMeta.agentsSpawned, 4);
  assert.strictEqual(runMeta.cachedHits, 0);
  assert.ok(result.d && String(result.d.echo).startsWith('call-3 stable'), 'call-3 result flows through');
});

test('S2 unchanged resume is 100% cache hit', () => {
  const { runMeta } = run(wfMain, 'resume-test', ['--resume']);
  assert.strictEqual(runMeta.agentsSpawned, 0);
  assert.strictEqual(runMeta.cachedHits, 4);
});

test('S3 changed prompt re-runs that call AND the suffix (prefix invalidation)', () => {
  // call-2 prompt changes (variant-b); call-3 prompt is identical to the cached one,
  // yet must re-run: results must not mix one run's suffix with another run's prefix.
  const { runMeta, result } = run(wfMain, 'resume-test', ['--resume', '--args', 'variant-b']);
  assert.strictEqual(runMeta.cachedHits, 2, 'only call-0/1 hit');
  assert.strictEqual(runMeta.agentsSpawned, 2, 'call-2 and call-3 re-run');
  assert.ok(String(result.c.echo).startsWith('call-2 variant-b'), 're-ran call-2 with new prompt');
});

test('S4 re-resume after partial re-run is all hit (journal last write wins)', () => {
  // journal now holds stale rows for i=2,3 plus fresh ones; stale rows must be superseded
  const { runMeta } = run(wfMain, 'resume-test', ['--resume', '--args', 'variant-b']);
  assert.strictEqual(runMeta.agentsSpawned, 0, 'no live spawns');
  assert.strictEqual(runMeta.cachedHits, 4, 'stale duplicate journal rows superseded');
});

test('S5 failed calls are not cached — resume retries them', () => {
  const fresh = run(wfFail, 'resume-fail');
  assert.strictEqual(fresh.runMeta.agentsSpawned, 1);
  assert.strictEqual(fresh.result.r, null);
  const again = run(wfFail, 'resume-fail', ['--resume']);
  assert.strictEqual(again.runMeta.agentsSpawned, 1, 'null result re-executed on resume');
  assert.strictEqual(again.runMeta.cachedHits, 0);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log('ok  ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message ? e.message : e)); }
}
console.log(failed ? failed + ' test(s) failed' : 'all ' + tests.length + ' resume semantics tests passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
