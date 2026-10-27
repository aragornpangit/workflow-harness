#!/usr/bin/env node
// tests/parsers.test.mjs — output-format parser regression for scripts/wf-runner.mjs
// Run: node tests/parsers.test.mjs
// Covers: claude-json / codex-json / pi-json / opencode-json / hermes-json and the
// prompt-contract fallback (agent text carrying an embedded JSON string).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const runner = path.join(repo, 'scripts', 'wf-runner.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-parsers-test-'));

const fixtures = {
  'mock-codex.mjs': [
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"files\\":[\\"x.ts\\"]}"}}',
  ],
  'mock-claude.mjs': ['{"type":"result","result":"{\\"n\\":3}"}'],
  'mock-claude-struct.mjs': ['{"type":"result","structured_output":{"ok":true}}'],
  'mock-pi.mjs': ['{"type":"session","id":"s1"}', '{"type":"agent_end","messages":[{"content":[{"text":"{\\"p\\":1}"}]}]}'],
  'mock-opencode.mjs': [
    '{"type":"text","part":{"text":"{\\"k\\":"}}',
    '{"type":"text","part":{"text":"\\"v\\"}"}}',
  ],
  'mock-hermes.mjs': ['{"type":"tool","name":"x"}', '{"type":"result","text":"{\\"h\\":true}"}'],
};
for (const [name, lines] of Object.entries(fixtures)) {
  const body = lines.map((l) => 'process.stdout.write(' + JSON.stringify(l) + " + '\\n');").join('\n');
  fs.writeFileSync(path.join(tmp, name), '#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on("end", () => {\n' + body + '\n});\n');
}

fs.writeFileSync(path.join(tmp, 'agents.json'), JSON.stringify({
  agents: {
    cx: { command: 'true', jsonCommand: 'node ' + path.join(tmp, 'mock-codex.mjs'), output: 'text', schemaOutput: 'codex-json' },
    cl: { command: 'true', jsonCommand: 'node ' + path.join(tmp, 'mock-claude.mjs'), output: 'text', schemaOutput: 'claude-json' },
    cl2: { command: 'true', jsonCommand: 'node ' + path.join(tmp, 'mock-claude-struct.mjs'), output: 'text', schemaOutput: 'claude-json' },
    pi: { command: 'true', jsonCommand: 'node ' + path.join(tmp, 'mock-pi.mjs'), output: 'text', schemaOutput: 'pi-json' },
    oc: { command: 'true', jsonCommand: 'node ' + path.join(tmp, 'mock-opencode.mjs'), output: 'text', schemaOutput: 'opencode-json' },
    hm: { command: 'true', jsonCommand: 'node ' + path.join(tmp, 'mock-hermes.mjs'), output: 'text', schemaOutput: 'hermes-json' },
  },
}, null, 2));

const wf = path.join(tmp, 'parsers.workflow.mjs');
fs.writeFileSync(wf, `export const meta = { name: 'parsers-test', description: 'parser regression' }
const F = { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } }
const N = { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } }
const O = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }
const P = { type: 'object', required: ['p'], properties: { p: { type: 'integer' } } }
const K = { type: 'object', required: ['k'], properties: { k: { type: 'string' } } }
const H = { type: 'object', required: ['h'], properties: { h: { type: 'boolean' } } }
return {
  cx: await agent('x', { agentType: 'cx', schema: F }),
  cl: await agent('x', { agentType: 'cl', schema: N }),
  cl2: await agent('x', { agentType: 'cl2', schema: O }),
  pi: await agent('x', { agentType: 'pi', schema: P }),
  oc: await agent('x', { agentType: 'oc', schema: K }),
  hm: await agent('x', { agentType: 'hm', schema: H }),
}
`);

const r = spawnSync('node', [runner, wf, '--agents', path.join(tmp, 'agents.json'),
  '--name', 'parsers-test', '--out', path.join(tmp, 'runs')], { encoding: 'utf8' });
assert.strictEqual(r.status, 0, 'runner exits 0: ' + r.stderr);
const result = JSON.parse(fs.readFileSync(path.join(tmp, 'runs', 'parsers-test', 'result.json'), 'utf8'));

const tests = [
  ['codex-json: item.completed/agent_message/.item.text', () => assert.deepStrictEqual(result.cx, { files: ['x.ts'] })],
  ['claude-json: .result carries prompt-contract JSON', () => assert.deepStrictEqual(result.cl, { n: 3 })],
  ['claude-json: .structured_output preferred', () => assert.deepStrictEqual(result.cl2, { ok: true })],
  ['pi-json: agent_end content text blocks', () => assert.deepStrictEqual(result.pi, { p: 1 })],
  ['opencode-json: type:"text" part.text joined', () => assert.deepStrictEqual(result.oc, { k: 'v' })],
  ['hermes-json: type:"result" .text', () => assert.deepStrictEqual(result.hm, { h: true })],
];

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log('ok  ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message ? e.message : e)); }
}
console.log(failed ? failed + ' test(s) failed' : 'all ' + tests.length + ' parser tests passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
