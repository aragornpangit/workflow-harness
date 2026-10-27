# workflow-harness

中文 | [English](README.en.md)

跨 harness 通用的**动态工作流（dynamic workflow）** agent skill：把大任务写成一段确定性 JavaScript 编排脚本，扇出隔离子代理执行，中间结果留在脚本变量里，只把最终答案带回会话。

一套 DSL，六种 harness 通用：**claude-code、codebuddy、pi-agent、codex、opencode2、hermes**。

## 解决什么问题

单个会话上下文装不下、或天然可并行/可验证/需长循环的任务（全库审计、批量评审、大规模迁移、深度调研），不该在一个对话里串行硬啃。业界已有成熟做法——Claude Code 的内置 dynamic workflows、pi 的 pi-dynamic-workflow 扩展——但各家 harness 能力不齐：

| Harness | 原生 workflow 引擎 | 本 skill 执行层 |
|---|---|---|
| claude-code / codebuddy | ✅ 内置 Workflow 工具 | Tier 1：脚本直接交给原生引擎 |
| pi-agent | ⚠️ 系扩展（DSL 同族） | Tier 1（有扩展）/ Tier 2 |
| codex / opencode2 / hermes | ❌ | Tier 2：`wf-runner.mjs` 便携运行时 |

## 三 Tier 执行模型

1. **原生引擎** — 脚本交给 harness 自带的 Workflow 工具（claude-code、codebuddy、装了 pi-dynamic-workflow 的 pi）。
2. **便携运行时** — `node scripts/wf-runner.mjs <wf.mjs> --agents agents.json`：零依赖 Node 运行时执行同一套 DSL，`agent()` 通过 CLI 子进程（`codex exec` / `opencode run` / `hermes chat --oneshot` 等，flag 已对真实 CLI 实测）模拟子代理扇出，附并发控制、JSON Schema 校验、断点续跑、可审计产物落盘。
3. **会话内降级** — 小任务直接用原生子代理工具按模式检查单手动 fan-out。

## 仓库结构

```
SKILL.md                        # agent 入口：触发条件、三 Tier 流程、硬性规则
references/
  workflow-spec.md              # 跨 harness 共享 DSL 契约（meta/agent/pipeline/parallel/phase/...）
  harness-matrix.md             # 六 harness 路由表、安装路径、现成 package/extension/skill 生态
  patterns.md                   # 7 种编排模式 + 质量杠杆 + Eval 门/Handoff + 反模式
  research/                     # 调研原文（各 harness 扩展机制 + preset flags 实测证据，含来源 URL）
scripts/wf-runner.mjs           # Tier-2 便携运行时（零依赖，Node ≥18）
assets/                         # agents.json 模板 + 可改写示例 workflow
tests/                          # 回归：parsers 6 + resume 5 + smoke 2，全绿基准
```

## 快速上手

装到任意 harness 的 skills 目录（`~/.claude/skills`、`~/.codebuddy/skills`、`~/.codex/skills`、`~/.config/opencode/skills`、`~/.pi/skills`、`~/.hermes/skills`），然后对 agent 说"用 dynamic workflow 做 X"。

Tier 2 直接跑：

```bash
node scripts/wf-runner.mjs assets/examples/review-codebase.workflow.mjs \
  --agents agents.json --name demo
# 产物：.wf-runs/demo/{result.json,report.md,journal.jsonl,prompts/,outputs/}
# 续跑：加 --resume（前缀失效语义，失败调用自动重试）
```

## 开发

改 `wf-runner.mjs` 后必跑全量回归：

```bash
for f in tests/*.test.mjs; do node "$f"; done
```

resume 语义由 `tests/resume.test.mjs` 锁定：命中条件 = 调用序号 + prompt 哈希一致且上次非失败；首个未命中起后缀全部重跑；失败不缓存。

## 背景与致谢

设计参照 Anthropic dynamic workflows in Claude Code、milanglacier/pi-dynamic-workflow、TianqiZhang/dynamic-workflow（便携运行时思路）、affaan-m/ECC dynamic-workflow-mode（Eval 门/Handoff/决策树）。各 harness 扩展生态调研快照见 `references/research/`（2026-10）。
