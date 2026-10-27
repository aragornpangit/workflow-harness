#!/usr/bin/env node
// tests/runtime.test.mjs — runtime robustness regression for scripts/wf-runner.mjs
// Run: node tests/runtime.test.mjs
//
// R1 EPIPE:    a child that exits without reading stdin must not crash the runner
// R2 timeout:  cfg.timeoutMs must kill the whole process group (incl. grandchildren)
// R3 concurrency: at most --concurrency agent() subprocesses may run at once

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const runner = path.join(repo, 'scripts', 'wf-runner.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-runtime-test-'));

function w(name, text, mode) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, text);
  if (mode) fs.chmodSync(p, mode);
  return p;
}

function run(wf, agents, name, extra = []) {
  const started = Date.now();
  const r = spawnSync('node', [runner, wf, '--agents', agents, '--name', name,
    '--out', path.join(tmp, 'runs'), ...extra], { encoding: 'utf8', timeout: 60000 });
  const dir = path.join(tmp, 'runs', name);
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : null);
  return { status: r.status, wallMs: Date.now() - started, stderr: r.stderr || '', runMeta: read('run.json'), result: read('result.json') };
}

// ---------------------------------------------------------------- R1 EPIPE
const wfEpipe = w('epipe.workflow.mjs', `export const meta = { name: 'epipe', description: 'epipe' }
const big = 'x'.repeat(200000)
return { v: await agent(big, {}) }
`);
const agEpipe = w('agents-epipe.json', JSON.stringify({
  agents: { default: { command: 'true', output: 'text' } },
}));

// ---------------------------------------------------------------- R2 timeout
const wfTimeout = w('timeout.workflow.mjs', `export const meta = { name: 'timeout', description: 'timeout' }
return { v: await agent('hi', {}) }
`);
const agTimeout = w('agents-timeout.json', JSON.stringify({
  agents: { default: { command: "sleep 5; echo '{\"ok\":true}'", output: 'json', timeoutMs: 300 } },
}));

// ---------------------------------------------------------------- R3 concurrency
const traceFile = path.join(tmp, 'trace.log');
w('slow.sh', `#!/bin/sh
cat > /dev/null
echo "S $(date +%s%N)" >> ${traceFile}
sleep 0.3
echo "E $(date +%s%N)" >> ${traceFile}
echo '{"ok":true}'
`, 0o755);
const agSlow = w('agents-slow.json', JSON.stringify({
  agents: { default: { command: 'sh ' + path.join(tmp, 'slow.sh'), output: 'json' } },
}));
const wfConc = w('conc.workflow.mjs', `export const meta = { name: 'conc', description: 'conc' }
const thunks = []
for (let i = 0; i < 8; i++) thunks.push(() => agent('p' + i, { label: 'a' + i }))
const r = await parallel(thunks)
return { n: r.filter(Boolean).length }
`);

function maxConcurrent(file) {
  if (!fs.existsSync(file)) return 0;
  const ev = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { const [k, t] = l.split(' '); return { k, t: Number(t) }; })
    .sort((a, b) => a.t - b.t);
  let cur = 0, max = 0;
  for (const e of ev) {
    if (e.k === 'S') { cur++; if (cur > max) max = cur; } else cur--;
  }
  return max;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('R1 child that exits before reading stdin does not crash the runner', () => {
  const { status, stderr, result } = run(wfEpipe, agEpipe, 'epipe');
  assert.ok(!/Unhandled 'error' event|EPIPE/.test(stderr), 'no unhandled EPIPE: ' + stderr.slice(0, 200));
  assert.strictEqual(status, 0, 'runner exits 0');
  assert.ok(result !== null, 'result.json written');
});

test('R2 timeout kills the whole process group', () => {
  const { wallMs, result } = run(wfTimeout, agTimeout, 'timeout');
  assert.ok(wallMs < 3000, 'wall ' + wallMs + 'ms should be far below the 5s sleep');
  assert.strictEqual(result.v, null, 'timed-out agent yields null');
});

test('R3 --concurrency caps simultaneous agent subprocesses', () => {
  const { runMeta, result } = run(wfConc, agSlow, 'conc', ['--concurrency', '2']);
  const peak = maxConcurrent(traceFile);
  assert.strictEqual(result.n, 8, 'all 8 agents returned');
  assert.strictEqual(runMeta.concurrency, 2, 'run.json reports the requested cap');
  assert.ok(peak <= 2, 'peak concurrency ' + peak + ' must not exceed 2');
  assert.strictEqual(peak, 2, 'cap should actually be saturated, got ' + peak);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log('ok  ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message ? e.message : e)); }
}
console.log(failed ? failed + ' test(s) failed' : 'all ' + tests.length + ' runtime tests passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
