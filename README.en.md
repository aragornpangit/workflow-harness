# workflow-harness

A cross-harness **dynamic workflow** agent skill: turn a large task into a deterministic JavaScript orchestration script that fans out isolated subagents, keeps intermediate results in script variables, and brings only the final answer back into the conversation.

One DSL, six harnesses: **claude-code, codebuddy, pi-agent, codex, opencode2, hermes**.

[中文](README.md) | English

## What problem it solves

Tasks that overflow a single context window, or that are naturally parallelizable / verifiable / loop-heavy (whole-repo audits, batch reviews, large migrations, deep research), should not be chewed through serially in one chat. Mature approaches already exist — Claude Code's built-in dynamic workflows, the pi-dynamic-workflow extension for Pi — but harness capabilities differ:

| Harness | Native workflow engine | Execution layer of this skill |
|---|---|---|
| claude-code / codebuddy | ✅ built-in Workflow tool | Tier 1: hand the script to the native engine |
| pi-agent | ⚠️ via extension (same DSL family) | Tier 1 (with extension) / Tier 2 |
| codex / opencode2 / hermes | ❌ | Tier 2: the `wf-runner.mjs` portable runtime |

## Three-tier execution model

1. **Native engine** — hand the script to the harness's own Workflow tool (claude-code, codebuddy, pi with pi-dynamic-workflow installed).
2. **Portable runtime** — `node scripts/wf-runner.mjs <wf.mjs> --agents agents.json`: a dependency-free Node runtime executes the same DSL; `agent()` simulates subagent fan-out via CLI subprocesses (`codex exec` / `opencode run` / `hermes chat --oneshot`, etc. — flags verified against real CLIs), with bounded concurrency, JSON Schema validation, resumable journaling, and auditable on-disk artifacts.
3. **In-session fallback** — for small tasks, fan out with the harness's native subagent tool following the pattern checklist.

## Repository layout

```
SKILL.md                        # agent entry point: triggers, tier routing, hard rules
references/
  workflow-spec.md              # shared cross-harness DSL contract (meta/agent/pipeline/parallel/phase/...)
  harness-matrix.md             # routing table per harness, install paths, existing package/extension/skill ecosystem
  patterns.md                   # 7 orchestration patterns + quality levers + eval gates/handoff + anti-patterns
  research/                     # research notes (harness extension mechanisms + preset flag evidence, with source URLs)
scripts/wf-runner.mjs           # Tier-2 portable runtime (zero dependencies, Node ≥18)
assets/                         # agents.json template + rewritable example workflow
tests/                          # regression: parsers 6 + resume 5 + runtime 3 + compat 6 + smoke 2 — all green baseline
```

## Quick start

Install into any harness's skills directory (`~/.claude/skills`, `~/.codebuddy/skills`, `~/.codex/skills`, `~/.config/opencode/skills`, `~/.pi/skills`, `~/.hermes/skills`), then tell the agent "run a dynamic workflow for X".

Run Tier 2 directly:

```bash
node scripts/wf-runner.mjs assets/examples/review-codebase.workflow.mjs \
  --agents agents.json --name demo
# artifacts: .wf-runs/demo/{result.json,report.md,journal.jsonl,prompts/,outputs/}
# resume: add --resume (prefix-invalidation semantics; failed calls are retried)
```

## Development

After changing `wf-runner.mjs`, always run the full regression suite:

```bash
for f in tests/*.test.mjs; do node "$f"; done
```

Resume semantics are locked by `tests/resume.test.mjs`: a cache hit requires matching call index + prompt hash with a non-failed prior result; the first miss invalidates the whole suffix; failures are never cached.

## Background & credits

Design follows Anthropic's dynamic workflows in Claude Code, milanglacier/pi-dynamic-workflow, TianqiZhang/dynamic-workflow (portable runtime approach), and affaan-m/ECC dynamic-workflow-mode (eval gates / handoff / decision tree). Research snapshots of each harness's extension ecosystem live in `references/research/` (2026-10).
