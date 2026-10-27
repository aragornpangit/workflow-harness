---
name: workflow-harness
description: 为任一 AI 编码 harness（claude-code、codebuddy、pi-agent、codex、opencode2、hermes）创建并运行动态工作流 dynamic workflow。任务过大、可并行、需验证、需长循环，或用户明说 workflow/fan-out/编排/批量/多代理/ultracode 时使用。把任务写成确定性 JS 编排脚本派生隔离子代理，自动路由到原生 Workflow 引擎或便携运行时。触发词：dynamic workflow、动态工作流、workflow-harness、编排、fan-out、批量并行。
---

# workflow-harness — 跨 harness 通用动态工作流

把大任务变成一段**确定性 JS 编排脚本**：脚本持有循环、分支、中间结果，子代理只做有界判断，当前会话只负责创建、启动、监控、汇总。同一套 DSL 在 claude-code、codebuddy、pi-agent、codex、opencode2、hermes 上通用。

## 何时用 / 不用

| 用 | 不用 |
|---|---|
| 多独立 item（文件/issue/候选/模块）、可并行子任务 | 单文件小改、一句话问答 |
| 长循环（优化到指标达标、反复实验）、需验证（writer→reviewer、改动→测试） | 结果一次性看全的小调研 |
| 上下文装不下的审计/迁移/大规模调研 | 用户没授权多代理规模时（先报预估再问） |

## 核心模型：三个 Tier

1. **原生引擎**（claude-code、codebuddy、装了 pi-dynamic-workflow 的 pi-agent）——脚本直接交给内置/扩展的 workflow 工具执行。
2. **便携运行时**（codex、opencode2、hermes、无扩展的 pi-agent）——`node scripts/wf-runner.mjs <wf.mjs> --agents agents.json`，同一 DSL，agent() 派生本地 CLI 子进程。
3. **会话内降级**（任务小 / 无 Node）——用原生子代理工具按 patterns.md 检查单手动 fan-out。

## 执行流程

1. **确认规模与授权**。用户没明说要多代理编排时，报预估（代理数、token 量级）并征得同意。
2. **路由 harness**。读 `references/harness-matrix.md`，确定当前 harness 的 Tier、脚本落点、可复用的现成 package（pi 装 pi-dynamic-workflow、claude-code 装 zircote/workflows-plugin 等——有现成的优先用现成的）。
3. **选模式**。读 `references/patterns.md`：七种形状（fanout-synthesize / classify-and-act / adversarial-verify / generate-and-filter / tournament / loop-until-done / deep-research）+ 质量杠杆 + 反模式。
4. **写脚本**。按 `references/workflow-spec.md` 的公共 DSL 契约写 `export const meta` + 脚本体；每个 agent 的 prompt 写清目标、输入、允许/禁止动作、验收标准，机器要用的输出走 `opts.schema`；确定性代码做枚举/聚合/判定，agent 只做模糊判断。
5. **执行**。Tier 1：调用 workflow 工具（`script`/`scriptPath`）或运行已保存的 `/<name>`。Tier 2：`wf-runner.mjs` 跑脚本（`assets/examples/` 有可直接改的示例；`assets/agents.json` 是角色配置模板，preset 命令 flag 首次先 `--help` 核对）。Tier 3：按模式检查单在会话内派子代理。
6. **汇总**。从 `result.json`/`report.md`/artifacts 读结果（Tier 1 读 run 产物），不要凭对话记忆总结。截断与失败必须显式报告。
7. **沉淀**。值得复用的脚本存到 harness 的 workflows 目录（claude-code：`.claude/workflows/`；codebuddy：`.codebuddy/workflows/`；pi：`.pi/workflows/`），下轮用 `/<name>` 重跑。

## 硬性规则

- `meta` 纯字面量、第一语句；禁 `Date.now()`/`Math.random()`/`new Date()`/`import()`/`require()`/`eval`——违反即失去 resume 缓存（wf-runner 会静态拒绝）。
- `agent()` 失败返回 `null`，结果一律 `.filter(Boolean)`；需要全量才用 `parallel` 屏障，默认 `pipeline`。
- 信息型 stage 用 schema 聚合；产出型 stage 走 快照→允许路径内编辑→diff→测试门→accept/restore。
- 规模守恒：有 `budget` 就跟着预算走；top-N/采样/不重试必须 `log()` 丢弃量。
- 不跑任意破坏性命令；子代理默认不必要继承完整环境变量时设 `inheritEnv: false`。

## References

- `references/workflow-spec.md` — 共享 DSL 契约（写脚本前必读）
- `references/harness-matrix.md` — 六 harness 路由表、安装路径、现成 package/extension/skill 生态（路由前必读）
- `references/patterns.md` — 编排模式库、质量杠杆、反模式、安全守则
- `references/research/*.md` — 各 harness 扩展机制调研原文（含来源 URL，生态信息过时以此复核）
- `scripts/wf-runner.mjs` — Tier-2 便携运行时（零依赖，Node ≥18）
- `tests/*.test.mjs` — 回归套件（parsers / resume / runtime / smoke，16 用例）；改 runner 必跑 `for f in tests/*.test.mjs; do node "$f"; done`
- `assets/examples/review-codebase.workflow.mjs` — 可改写的完整示例
