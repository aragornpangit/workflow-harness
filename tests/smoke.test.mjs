#!/usr/bin/env node
// tests/smoke.test.mjs — end-to-end smoke: bundled example workflow against a mock CLI.
// Run: node tests/smoke.test.mjs

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const runner = path.join(repo, 'scripts', 'wf-runner.mjs');
const example = path.join(repo, 'assets', 'examples', 'review-codebase.workflow.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-smoke-test-'));

fs.writeFileSync(path.join(tmp, 'mock-agent.sh'), `#!/bin/sh
prompt=$(cat)
case "$prompt" in
  *source*) echo '{"files":["a.ts","b.ts"]}' ;;
  *REFUTE*) echo '{"isReal":true,"reason":"concrete bug"}' ;;
  *Review*) echo '{"findings":[{"file":"a.ts","line":1,"severity":"high","title":"mock finding"}]}' ;;
  *) echo '{}' ;;
esac
`);
fs.writeFileSync(path.join(tmp, 'agents.json'), JSON.stringify({
  agents: { default: { command: 'sh ' + path.join(tmp, 'mock-agent.sh'), output: 'json' } },
}, null, 2));

function run(extra = []) {
  const r = spawnSync('node', [runner, example, '--agents', path.join(tmp, 'agents.json'),
    '--name', 'smoke', '--out', path.join(tmp, 'runs'), ...extra], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'runner exits 0: ' + r.stderr);
  return {
    runMeta: JSON.parse(fs.readFileSync(path.join(tmp, 'runs', 'smoke', 'run.json'), 'utf8')),
    result: JSON.parse(fs.readFileSync(path.join(tmp, 'runs', 'smoke', 'result.json'), 'utf8')),
    report: fs.readFileSync(path.join(tmp, 'runs', 'smoke', 'report.md'), 'utf8'),
  };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('E2E fan-out: inventory + per-file review + adversarial verify', () => {
  const { runMeta, result, report } = run();
  assert.strictEqual(runMeta.agentsSpawned, 5, '1 inventory + 2 review + 2 verify');
  assert.strictEqual(result.filesReviewed, 2);
  assert.strictEqual(result.confirmed.length, 2);
  assert.ok(report.includes('Review Codebase Report'), 'report.md written from return value');
});

test('E2E resume: unchanged re-run is fully cached', () => {
  const { runMeta } = run(['--resume']);
  assert.strictEqual(runMeta.agentsSpawned, 0);
  assert.strictEqual(runMeta.cachedHits, 5);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log('ok  ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message ? e.message : e)); }
}
console.log(failed ? failed + ' test(s) failed' : 'all ' + tests.length + ' smoke tests passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
