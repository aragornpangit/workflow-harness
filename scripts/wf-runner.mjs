#!/usr/bin/env node
// wf-runner.mjs — workflow-harness portable runtime (Tier-2 execution).
// Executes the shared workflow DSL (meta / agent / parallel / pipeline / phase / log / args / budget)
// on harnesses WITHOUT a native dynamic-workflow engine (codex, opencode2, hermes, ...),
// by spawning the local agent CLI as a subprocess per agent() call.
// Dependency-free. Node.js >= 18.
//
// Usage:
//   node wf-runner.mjs <workflow.mjs> [--agents <agents.json>] [--args <json-or-string>]
//                      [--name <run-name>] [--out <dir>] [--resume] [--budget-tokens <n>]
//                      [--concurrency <n>]
//
// Output tree:  <out>/<run-name>/{run.json,events.jsonl,journal.jsonl,result.json,report.md?,
//                                 prompts/,outputs/,errors/}

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const MAX_AGENTS = 1000;
const SCHEMA_RETRIES = 2;

// ---------------------------------------------------------------- CLI args
const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--agents', '--args', '--name', '--out', '--budget-tokens', '--concurrency']);
function flag(name, dflt) {
  const inline = argv.find((a) => a.startsWith('--' + name + '='));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
}
const has = (name) => argv.includes('--' + name);
// The script path is the first positional argument, wherever it sits among flags.
function findScriptPath() {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (!a.includes('=') && VALUE_FLAGS.has(a)) i++;
      continue;
    }
    return a;
  }
  return null;
}
const scriptPath = findScriptPath();
if (!scriptPath) {
  console.error('usage: node wf-runner.mjs <workflow.mjs> [--agents a.json] [--args JSON] [--name n] [--out dir] [--resume] [--budget-tokens n] [--concurrency n]');
  process.exit(2);
}

// ---------------------------------------------------------------- concurrency
function resolveConcurrency() {
  const requested = Number(flag('concurrency'));
  if (Number.isFinite(requested) && requested > 0) return Math.min(64, Math.floor(requested));
  return Math.max(1, Math.min(16, (os.cpus()?.length ?? 4) - 2));
}
const CONCURRENCY = resolveConcurrency();

// Counting semaphore: agent() holds a slot for the lifetime of its subprocess, so
// parallel()/pipeline() fan-out can never exceed CONCURRENCY live children.
function makeLimiter(max) {
  let active = 0;
  const queue = [];
  return {
    acquire() {
      if (active < max) { active++; return Promise.resolve(); }
      return new Promise((resolve) => queue.push(resolve));
    },
    release() {
      active--;
      if (queue.length && active < max) { active++; queue.shift()(); }
    },
  };
}
const agentSlots = makeLimiter(CONCURRENCY);

// ---------------------------------------------------------------- source prep
const source = fs.readFileSync(scriptPath, 'utf8');

// Blank out comments and string/template literal *text* (keeping ${...} expressions
// as code) so the determinism scan only sees executable code. Without this, a prompt
// that merely mentions "Date.now()" or "require(" would be rejected.
// Known limitation: regex literals are not lexed; a regex containing a quote can
// desync the scanner, which only ever causes a false negative, never a false positive.
function codeOnly(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blank(start, i);
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
      blank(start, i);
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === c) { i++; break; }
        i++;
      }
      blank(start, i);
      continue;
    }
    if (c === '\u0060') {
      const start = i++;
      blank(start, i);
      let seg = i;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '\u0060') { blank(seg, i + 1); i++; break; }
        if (src[i] === '$' && src[i + 1] === '{') {
          blank(seg, i + 2);
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            i++;
          }
          seg = i;
          continue;
        }
        i++;
      }
      blank(seg, i);
      continue;
    }
    i++;
  }
  return out.join('');
}

const code = codeOnly(source);
const FORBIDDEN = [/\bDate\.now\s*\(/, /\bMath\.random\s*\(/, /\bnew\s+Date\s*\(/, /\bimport\s*\(/, /\brequire\s*\(/, /\beval\s*\(/, /\bnew\s+Function\s*\(/];
for (const re of FORBIDDEN) {
  if (re.test(code)) {
    console.error('wf-runner: nondeterministic construct in workflow script: ' + re);
    process.exit(2);
  }
}

function splitMeta(src) {
  const m = src.match(/export\s+const\s+meta\s*=/);
  if (!m) throw new Error('workflow script must start with: export const meta = {...}');
  const start = m.index + m[0].length;
  let depth = 0, i = start, inStr = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const literal = src.slice(start, i);
  const meta = vm.runInNewContext('(' + literal + ')', Object.create(null));
  let body = src.slice(0, m.index) + src.slice(i).replace(/^\s*;?/, '');
  body = body.replace(/^export\s+/gm, '');
  return { meta, body };
}
const { meta, body } = splitMeta(source);
if (!meta || typeof meta.name !== 'string' || !meta.name || typeof meta.description !== 'string') {
  console.error('wf-runner: meta must be a pure literal with name and description');
  process.exit(2);
}
const runName = (flag('name') || meta.name).replace(/[^a-zA-Z0-9._-]+/g, '-');

// ---------------------------------------------------------------- run dir / logs
const outRoot = path.resolve(flag('out') || '.wf-runs');
const runDir = path.join(outRoot, runName);
for (const d of ['', 'prompts', 'outputs', 'errors']) fs.mkdirSync(path.join(runDir, d), { recursive: true });
const startedAt = new Date().toISOString();
fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
  name: runName, description: meta.description, phases: meta.phases ?? [], script: path.resolve(scriptPath),
  startedAt, pid: process.pid, concurrency: CONCURRENCY,
}, null, 2));

function appendJsonl(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}
function log(msg) {
  appendJsonl(path.join(runDir, 'events.jsonl'), { t: new Date().toISOString(), phase: currentPhase, event: 'log', msg: String(msg) });
  console.error('[wf:' + runName + ']' + (currentPhase ? ' [' + currentPhase + ']' : '') + ' ' + msg);
}
function phase(title, body) {
  currentPhase = String(title);
  appendJsonl(path.join(runDir, 'events.jsonl'), { t: new Date().toISOString(), event: 'phase', title: currentPhase });
  // codebuddy's native signature is phase(name, body); accept it so those scripts port over.
  if (typeof body === 'function') return body();
}
let currentPhase = null;

// ---------------------------------------------------------------- journal / resume
const journalPath = path.join(runDir, 'journal.jsonl');
const resume = has('resume');
// Journal rows are keyed by call index; a re-run APPENDS a fresh row for the same index,
// so later rows supersede earlier ones when replaying.
const cachedByIndex = new Map();
if (resume && fs.existsSync(journalPath)) {
  for (const line of fs.readFileSync(journalPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && Number.isInteger(entry.i)) cachedByIndex.set(entry.i, entry);
    } catch { /* skip */ }
  }
  log('resume: ' + cachedByIndex.size + ' cached agent results from ' + journalPath);
}
let agentSeq = 0;
let agentsSpawned = 0;
let cacheHits = 0;
let resumeBroken = false; // prefix invalidation: first live call forces all later calls live

// ---------------------------------------------------------------- agents.json
function commandExists(cmd) {
  return spawnSync('sh', ['-c', 'command -v ' + cmd], { stdio: 'ignore' }).status === 0;
}
function autoPreset() {
  for (const c of ['claude', 'codex', 'pi', 'codebuddy', 'opencode', 'hermes']) {
    if (commandExists(c)) return c;
  }
  return null;
}

// Presets verified against real CLIs on 2026-10-27 (evidence: references/research/preset-flags/*.md).
// command = text mode; jsonCommand = structured mode (used with opts.schema); schemaOutput parses jsonCommand output.
// modelFlag: appended as `<modelFlag> <model>` when opts.model is set.
const PRESETS = {
  claude: {
    command: 'claude -p --no-session-persistence --permission-mode acceptEdits',
    jsonCommand: 'claude -p --output-format json --no-session-persistence --permission-mode acceptEdits',
    output: 'text', schemaOutput: 'claude-json', input: 'stdin', modelFlag: '--model',
  },
  codex: {
    command: 'codex exec --ephemeral --skip-git-repo-check -s workspace-write --color never -',
    jsonCommand: 'codex exec --ephemeral --skip-git-repo-check -s workspace-write --json -',
    output: 'text', schemaOutput: 'codex-json', input: 'stdin', modelFlag: '--model',
  },
  pi: {
    command: 'pi -p --no-session',
    jsonCommand: 'pi -p --no-session --mode json',
    output: 'text', schemaOutput: 'pi-json', input: 'stdin', modelFlag: '--model',
  },
  codebuddy: {
    command: 'codebuddy -p -y --no-session-persistence',
    jsonCommand: 'codebuddy -p -y --no-session-persistence --output-format json',
    output: 'text', schemaOutput: 'claude-json', input: 'stdin', modelFlag: '--model',
  },
  opencode: {
    command: 'opencode run --auto',
    jsonCommand: 'opencode run --format json --auto',
    output: 'text', schemaOutput: 'opencode-json', input: 'stdin', modelFlag: '--model',
  },
  hermes: {
    command: 'hermes chat --oneshot -Q --query-file -',
    jsonCommand: 'hermes chat --oneshot --query-file - --format stream-json',
    output: 'text', schemaOutput: 'hermes-json', input: 'stdin', modelFlag: '--model',
  },
};

function loadAgents() {
  const agentsFile = flag('agents') || path.join(process.cwd(), 'agents.json');
  let cfg = { agents: {} };
  if (fs.existsSync(agentsFile)) {
    cfg = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
    log('agents config: ' + agentsFile);
  } else {
    log('no agents.json found; auto-detecting preset');
  }
  const resolve = (role) => {
    let a = cfg.agents?.[role];
    if (typeof a === 'string') a = { preset: a };
    if (!a && role !== 'default') { log('unknown agent role "' + role + '", using default'); a = cfg.agents?.default; if (typeof a === 'string') a = { preset: a }; }
    const presetName = a?.preset || autoPreset();
    if (!presetName || !PRESETS[presetName]) {
      if (!a?.command) throw new Error('no agent CLI detected; configure agents.json with a command');
    }
    const preset = PRESETS[presetName] || {};
    const merged = { timeoutMs: 30 * 60 * 1000, inheritEnv: true, ...preset, ...(a || {}) };
    // A custom `command` replaces the preset wholesale: drop preset json/schema wrappers
    // unless the config explicitly redefines them.
    if (a?.command && !a?.jsonCommand) delete merged.jsonCommand;
    if (a?.command && !a?.schemaCommand) delete merged.schemaCommand;
    return merged;
  };
  return resolve;
}
const resolveAgent = loadAgents();

// ---------------------------------------------------------------- schema validation (subset)
function validateSchema(schema, value, trail = '$') {
  const errs = [];
  const t = schema.type;
  const okType = (v) => {
    if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
    if (t === 'array') return Array.isArray(v);
    if (t === 'integer') return Number.isInteger(v);
    if (t === 'number') return typeof v === 'number';
    if (t === 'string') return typeof v === 'string';
    if (t === 'boolean') return typeof v === 'boolean';
    return true;
  };
  if (t && !okType(value)) { errs.push(trail + ': expected ' + t); return errs; }
  if (schema.enum && !schema.enum.includes(value)) errs.push(trail + ': not in enum');
  if (t === 'object') {
    for (const key of schema.required || []) {
      if (!(key in (value || {}))) errs.push(trail + '.' + key + ': required');
    }
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (value && k in value) errs.push(...validateSchema(sub, value[k], trail + '.' + k));
    }
  }
  if (t === 'array' && schema.items && Array.isArray(value)) {
    value.forEach((v, i) => errs.push(...validateSchema(schema.items, v, trail + '[' + i + ']')));
  }
  return errs;
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const first = text.indexOf('{'), last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  const arrFirst = text.indexOf('['), arrLast = text.lastIndexOf(']');
  if (arrFirst >= 0 && arrLast > arrFirst) candidates.push(text.slice(arrFirst, arrLast + 1));
  candidates.push(text);
  for (const c of candidates) {
    try { return JSON.parse(c.trim()); } catch { /* next */ }
  }
  return null;
}

function parseOutput(raw, output) {
  const text = String(raw);
  if (output === 'text') return text.trim();
  if (output === 'claude-json') {
    // single JSON object: .structured_output (schema flag) or .result (agent text)
    const j = extractJson(text);
    if (j && typeof j === 'object') {
      if (j.structured_output !== undefined) return j.structured_output;
      if (typeof j.result === 'string') {
        const inner = extractJson(j.result);
        return inner !== null ? inner : j.result.trim();
      }
      return j;
    }
    return text.trim();
  }
  if (output === 'codex-json') {
    // JSONL events; final text = last item.completed with item.type === 'agent_message' → .item.text
    let last = null;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
          last = ev.item.text;
          continue;
        }
        const type = ev.type ?? ev.msg?.type; // legacy shapes
        if (type === 'agent_message' && (ev.message ?? ev.msg?.message)) last = ev.message ?? ev.msg.message;
      } catch { /* ignore non-JSON lines */ }
    }
    return last !== null ? last : text.trim();
  }
  if (output === 'pi-json') {
    // JSONL events; final text in agent_end / turn_end message content text blocks
    let last = null;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        const msgs = ev.messages || (ev.message ? [ev.message] : []);
        for (const m of msgs) {
          for (const c of (m && m.content) || []) {
            if (c && typeof c.text === 'string' && c.text.trim()) last = c.text;
          }
        }
      } catch { /* ignore non-JSON lines */ }
    }
    return last !== null ? last : text.trim();
  }
  if (output === 'opencode-json') {
    // JSONL events; final text = concatenation of type:"text" events' part.text
    const parts = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'text' && ev.part && typeof ev.part.text === 'string') parts.push(ev.part.text);
      } catch { /* ignore non-JSON lines */ }
    }
    return parts.length ? parts.join('') : text.trim();
  }
  if (output === 'hermes-json') {
    // JSONL events (stream-json); final text = type:"result" event's .text
    let last = null;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'result' && typeof ev.text === 'string') last = ev.text;
      } catch { /* ignore non-JSON lines */ }
    }
    return last !== null ? last : text.trim();
  }
  const j = extractJson(text);
  return j !== null ? j : text.trim();
}

// ---------------------------------------------------------------- subprocess agent
function runProcess(command, promptText, cfg) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd: process.cwd(),
      env: cfg.inheritEnv === false ? { PATH: process.env.PATH, ...(cfg.env || {}) } : { ...process.env, ...(cfg.env || {}) },
      // Own process group: a timeout must be able to kill grandchildren, not just the shell.
      detached: true,
    });
    let out = '', err = '', timedOut = false, settled = false, timer = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    };
    timer = setTimeout(() => {
      timedOut = true;
      err += '\n[wf-runner] timeout after ' + cfg.timeoutMs + 'ms';
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    }, cfg.timeoutMs);
    // A child that exits before draining stdin raises EPIPE on the stream; unhandled,
    // that becomes an uncaught 'error' event and takes down the whole run.
    child.stdin.on('error', () => { /* child closed stdin early */ });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { err += String(e); finish(-1); });
    child.on('close', (code) => finish(code));
    try { child.stdin.write(promptText); child.stdin.end(); } catch { /* stream already closed */ }
  });
}

async function agent(prompt, opts = {}) {
  const idx = agentSeq++;
  const promptText = String(prompt);
  const hash = crypto.createHash('sha256').update(promptText).digest('hex').slice(0, 16);
  const label = (opts.label || 'agent-' + idx).replace(/[^a-zA-Z0-9._#-]+/g, '_').slice(0, 60);

  const entry = cachedByIndex.get(idx);
  if (resume && !resumeBroken && entry && entry.hash === hash && entry.result !== null) {
    cacheHits++;
    log('cache hit #' + idx + ' ' + label);
    appendJsonl(path.join(runDir, 'events.jsonl'), { t: new Date().toISOString(), event: 'agent', i: idx, label, phase: currentPhase, ok: true, cached: true });
    return entry.result;
  }
  // Prefix invalidation: once a call runs live (changed prompt, failed result, or no
  // cache entry), every later call runs live too — never mix one run's suffix with
  // another run's prefix.
  resumeBroken = true;
  if (agentsSpawned >= MAX_AGENTS) throw new Error('agent cap reached (' + MAX_AGENTS + ')');
  agentsSpawned++;

  let fullPrompt = promptText;
  if (opts.schema && !resolveAgent(opts.agent || opts.agentType || 'default').schemaCommand) {
    fullPrompt += '\n\nReturn ONLY a JSON object matching this JSON Schema (no prose, no markdown fences):\n' + JSON.stringify(opts.schema);
  }

  const tag = String(idx).padStart(4, '0') + '-' + label;
  fs.writeFileSync(path.join(runDir, 'prompts', tag + '.md'), fullPrompt);

  const cfg = resolveAgent(opts.agent || opts.agentType || 'default');
  let command = opts.schema && cfg.schemaCommand ? cfg.schemaCommand.replace('{schema}', JSON.stringify(opts.schema)) : (cfg.jsonCommand && opts.schema ? cfg.jsonCommand : cfg.command);
  if (opts.model && cfg.modelFlag) command += ' ' + cfg.modelFlag + ' ' + String(opts.model).replace(/[^a-zA-Z0-9._:/#-]/g, '');

  log('spawn #' + idx + ' ' + label + ' (' + command.split(' ')[0] + ')');
  let result = null;
  for (let attempt = 0; attempt <= SCHEMA_RETRIES; attempt++) {
    await agentSlots.acquire();
    let proc;
    try { proc = await runProcess(command, fullPrompt, cfg); }
    finally { agentSlots.release(); }
    const { code, out, err, timedOut } = proc;
    fs.writeFileSync(path.join(runDir, 'outputs', tag + (attempt ? '-r' + attempt : '') + '.txt'), out);
    if (err) fs.writeFileSync(path.join(runDir, 'errors', tag + (attempt ? '-r' + attempt : '') + '.txt'), err);
    if (timedOut || (code !== 0 && !out.trim())) {
      log('agent #' + idx + ' failed (exit ' + code + ')');
      result = null;
      break;
    }
    const parsed = parseOutput(out, opts.schema ? (cfg.schemaOutput || cfg.output) : cfg.output);
    if (!opts.schema) { result = parsed; break; }
    // prompt-contract fallback: structured text may arrive as a JSON string inside the message
    let value = parsed;
    if (typeof value === 'string') {
      const inner = extractJson(value);
      if (inner !== null) value = inner;
    }
    const errs = validateSchema(opts.schema, value);
    if (errs.length === 0) { result = value; break; }
    log('agent #' + idx + ' schema mismatch (attempt ' + (attempt + 1) + '): ' + errs.slice(0, 3).join('; '));
    result = null;
    fullPrompt = promptText + '\n\nPrevious output failed schema validation: ' + errs.join('; ') + '\nReturn ONLY a corrected JSON object matching:\n' + JSON.stringify(opts.schema);
  }

  appendJsonl(journalPath, { i: idx, hash, label, phase: currentPhase, result });
  appendJsonl(path.join(runDir, 'events.jsonl'), { t: new Date().toISOString(), event: 'agent', i: idx, label, phase: currentPhase, ok: result !== null });
  return result;
}

// ---------------------------------------------------------------- combinators
function parallel(items) {
  // Accept both () => agent(...) thunks (pi/claude shape) and already-started
  // promises (codebuddy's parallel(items) shape).
  return Promise.all((items || []).map((item) => Promise.resolve()
    .then(() => (typeof item === 'function' ? item() : item))
    .catch((e) => { log('parallel item error: ' + e); return null; })));
}
async function pipeline(items, ...stages) {
  return Promise.all(items.map((item, index) => (async () => {
    let cur = item;
    for (const stage of stages) {
      if (cur === null || cur === undefined) return null;
      try { cur = await stage(cur, item, index); } catch (e) { log('pipeline stage error at item ' + index + ': ' + e); return null; }
    }
    return cur;
  })()));
}

// ---------------------------------------------------------------- budget
const budgetTotal = flag('budget-tokens') ? Number(flag('budget-tokens')) : null;
const budget = {
  total: Number.isFinite(budgetTotal) ? budgetTotal : null,
  spent: () => agentsSpawned * 2000, // rough estimate; refine by reading outputs if needed
  remaining() { return this.total === null ? Infinity : Math.max(0, this.total - this.spent()); },
};

// ---------------------------------------------------------------- args
let args = flag('args');
if (args !== undefined) {
  try { args = JSON.parse(args); } catch { /* keep as string */ }
}

// ---------------------------------------------------------------- run
// Only the DSL primitives cross the boundary; builtins come from the context's own
// realm (injecting host JSON/Math/Error leaked host constructors into the script).
const sandboxGlobals = {
  meta, agent, parallel, pipeline, phase, log, args, budget,
  console: { log: (...a) => log(a.join(' ')), error: (...a) => log(a.join(' ')) },
};
// NOTE: vm is a determinism aid, not a security boundary — the injected host functions
// still expose host constructors. Disabling string code generation blocks the cheapest
// escape (Function/eval created inside the context). Workflow scripts are trusted input.
const context = vm.createContext(sandboxGlobals, { codeGeneration: { strings: false, wasm: false } });
const wrapped = '(async () => {\n' + body + '\n})()';
const started = Date.now();
let result;
try {
  result = await vm.runInContext(wrapped, context, { filename: path.resolve(scriptPath) });
} catch (e) {
  log('workflow threw: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
  result = { error: String(e) };
}

fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result ?? null, null, 2));
if (result && typeof result.report === 'string') {
  fs.writeFileSync(path.join(runDir, 'report.md'), result.report);
}
fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
  name: runName, description: meta.description, phases: meta.phases ?? [], script: path.resolve(scriptPath),
  startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - started,
  agentsSpawned, cachedHits: cacheHits, concurrency: CONCURRENCY,
}, null, 2));
log('done — ' + agentsSpawned + ' agents spawned, result in ' + path.join(runDir, 'result.json'));
