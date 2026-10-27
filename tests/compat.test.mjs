#!/usr/bin/env node
// tests/compat.test.mjs — determinism-check, sandbox and DSL-compat regression.
// Run: node tests/compat.test.mjs
//
// X1 (E4) the determinism scan must ignore string literals: prompts that merely
//         MENTION Date.now()/Math.random()/require( must not be rejected
// X2 (E4) real nondeterministic calls in code are still rejected
// X3 (E5) code generation from strings is disabled inside the workflow context
// X4 (E6) the script path may follow flags: --agents a.json wf.mjs
// X5 (C1) codebuddy-style phase(name, body) is accepted and runs the body
// X6 (C1) codebuddy-style parallel([promise, ...]) accepts already-started agents

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const runner = path.join(repo, 'scripts', 'wf-runner.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-compat-test-'));

function w(name, text) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, text);
  return p;
}

function run(argv, name) {
  const r = spawnSync('node', argv, { encoding: 'utf8', timeout: 60000 });
  const dir = path.join(tmp, 'runs', name);
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : null);
  return { status: r.status, stderr: r.stderr || '', result: read('result.json'), runMeta: read('run.json') };
}

const agents = w('agents.json', JSON.stringify({
  agents: { default: { command: 'cat > /dev/null; echo ok', output: 'text' } },
}));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// X1: prompt text mentioning forbidden APIs
const wfMention = w('mention.workflow.mjs', `export const meta = { name: 'mention', description: 'x' }
const prompt = 'Find all require( calls, Math.random() uses and new Date() sites in this repo'
return { v: await agent(prompt, { label: 'scan' }) }
`);
test('X1 determinism scan ignores string literals', () => {
  const { status, stderr } = run([runner, wfMention, '--agents', agents, '--name', 'mention', '--out', path.join(tmp, 'runs')], 'mention');
  assert.strictEqual(status, 0, 'must not reject: ' + stderr.slice(0, 200));
});

// X2: real nondeterminism still rejected
const wfReal = w('real.workflow.mjs', `export const meta = { name: 'real', description: 'x' }
return { t: Date.now() }
`);
test('X2 real Date.now() in code is still rejected', () => {
  const { status } = run([runner, wfReal, '--agents', agents, '--name', 'real', '--out', path.join(tmp, 'runs')], 'real');
  assert.strictEqual(status, 2, 'static check must still fire');
});

// X3: code generation disabled inside the context
const wfEscape = w('escape.workflow.mjs', `export const meta = { name: 'escape', description: 'x' }
let blocked = false
try { Function('return 1')() } catch (e) { blocked = true }
return { blocked, json: JSON.stringify({ a: 1 }), max: Math.max(1, 2), mapped: [1, 2].map((x) => x * 2).length }
`);
test('X3 Function() from strings is blocked, builtins still work', () => {
  const { status, result, stderr } = run([runner, wfEscape, '--agents', agents, '--name', 'escape', '--out', path.join(tmp, 'runs')], 'escape');
  assert.strictEqual(status, 0, stderr.slice(0, 200));
  assert.strictEqual(result.blocked, true, 'string code generation must throw');
  assert.strictEqual(result.json, '{"a":1}');
  assert.strictEqual(result.max, 2);
  assert.strictEqual(result.mapped, 2);
});

// X4: script path after flags
test('X4 script path may follow --agents', () => {
  const { status, result, stderr } = run([runner, '--agents', agents, '--name', 'order', '--out', path.join(tmp, 'runs'), wfMention], 'order');
  assert.strictEqual(status, 0, stderr.slice(0, 200));
  assert.strictEqual(result.v, 'ok');
});

// X5: codebuddy-style phase(name, body)
const wfPhase = w('phase.workflow.mjs', `export const meta = { name: 'phasebody', description: 'x' }
let ran = false
phase('Step', () => { ran = true })
return { ran }
`);
test('X5 phase(name, body) runs the body', () => {
  const { status, result, stderr } = run([runner, wfPhase, '--agents', agents, '--name', 'phasebody', '--out', path.join(tmp, 'runs')], 'phasebody');
  assert.strictEqual(status, 0, stderr.slice(0, 200));
  assert.strictEqual(result.ran, true);
});

// X6: parallel over already-started promises
const wfPromises = w('promises.workflow.mjs', `export const meta = { name: 'promises', description: 'x' }
const p1 = agent('a', { label: 'a' })
const p2 = agent('b', { label: 'b' })
const r = await parallel([p1, p2])
return { n: r.filter(Boolean).length }
`);
test('X6 parallel accepts already-started promises', () => {
  const { status, result, stderr } = run([runner, wfPromises, '--agents', agents, '--name', 'promises', '--out', path.join(tmp, 'runs')], 'promises');
  assert.strictEqual(status, 0, stderr.slice(0, 200));
  assert.strictEqual(result.n, 2);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log('ok  ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message ? e.message : e)); }
}
console.log(failed ? failed + ' test(s) failed' : 'all ' + tests.length + ' compat tests passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
