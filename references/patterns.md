# Patterns — 编排模式库与质量守则

> 模式源自 Claude Code dynamic workflows 的实践（fanout / adversarial / judge panel / loop-until-dry 等）与社区模式库（zircote/workflows-plugin、LEUNGUU/pi-agent-config）。决策树 / Eval 门 / Handoff 三节源自 [affaan-m/ECC dynamic-workflow-mode](https://github.com/affaan-m/ECC/blob/main/skills/dynamic-workflow-mode/SKILL.md)。模式选形状，脚本落 DSL（workflow-spec.md）。

## 何时值得开 workflow

满足任一条：**多独立 item**（文件/issue/URL/候选）｜**长循环**（优化到指标达标、反复实验）｜**可并行子任务**｜**需要验证**（writer→reviewer、改动→测试）｜**上下文装不下**｜用户明说要 workflow/fan-out/编排/批量。
不值得：单文件小改、问答式对话、结果一次性就能看全的小任务。

## 造 harness 决策树（要不要建、建多大）

1. **一次性任务**：留在会话内做完，别造 harness（别造 workflow、别提炼 skill）。
2. **重复任务、输入常变**：造 task-local harness（一段 workflow 脚本 / 循环），放项目临时区，跑完即弃。
3. **重复任务、跨会话/跨人/跨仓**：提炼成共享 skill（先写 `skills/<name>/SKILL.md`，命令壳只在需要旧式入口时才加）。
4. **涉及外部状态、队列、审批**：先补状态可见性（见下方 Handoff / 控制检查点），再加自动化。
5. **有安全风险**：先加 Eval 门 + 人工 merge 门，再允许自主执行。

配套的 harness 契约（task-local harness 写代码前先填）：**Objective**（交付什么/明确不交付什么）、**Inputs**（工作区、外部系统、凭证策略、用户约束）、**Outputs**（commit/报告/截图/状态文件）、**Eval**（至少一个任务相关的过/不过检查，"跑完了"不算）、**Handoff**（给下一个操作者的短交接物）。

## 七种基础形状

| 模式 | 形状 | 适用 |
|---|---|---|
| **fanout-synthesize** | map（每 item 一 agent）→ 汇总 agent | 调研、审计、每文件评审 |
| **classify-and-act** | 先分类 → 按类别路由不同 agent | issue triage、迁移决策 |
| **adversarial-verify** | 产出 → N 个反驳者投票，≥多数通过才收 | 结论可信度敏感：评审发现、安全问题 |
| **generate-and-filter** | 生成 N 个候选 → 并行打分 → 取优 | 方案设计、文案、重构策略 |
| **tournament** | 候选两两对比晋级 → 决赛合成 | 解法空间宽、优劣可比 |
| **loop-until-done** | 循环：改动 → 测试 → 不过继续，过则停 | 修 bug、优化、迁移 |
| **deep-research** | 多模态 sweep → 精读 → 合成 → 完备性批判 | 大问题调研（各 harness 多有内置 /deep-research） |

## 质量杠杆（按需叠加）

- **对抗校验**：每 finding 派 N 个独立反驳者，prompt 明确 "试图推翻它，不确定就判 false"；≥ 多数反驳即杀。
- **多镜头校验**：一个 finding 可能以多种方式出错时，给每个校验者不同镜头（正确性/安全/性能/可复现），比 N 个同质反驳者抓得多。
- **评审团**：N 个独立方案（MVP 先行/风险先行/用户先行）→ 并行评委打分 → 以冠军为骨架嫁接其余亮点。解法空间宽时优于单方案迭代。
- **loop-until-dry**：发现型任务连续 K 轮无新增即停（纯计数循环会漏尾巴）。去重对 `seen` 而不是 `confirmed`，否则被否的会反复回流、永不收敛。
- **多模态 sweep**：不同 agent 用不同检索角度（按容器/按内容/按实体/按时间），互相盲区互补。
- **完备性批判**：收尾一个 agent 专问 "漏了什么——没跑的模态、没验证的断言、没读的来源"，发现即下一轮工作。

## 反模式

- **假屏障**：`parallel()` 收齐再 map/filter 再 `parallel()`——中间转换不需要全量，写进 `pipeline` 的 stage。屏障只在真需要全量结果（去重、零则跳过、跨项对比）时用。
- **静默截断**：top-N、不重试、采样都必须 `log()` 丢弃量，否则读起来像全覆盖。
- **agent 干确定性活**：枚举、计数、diff、退出码、指标——代码/脚本自己算；agent 只做模糊判断（评审、改写、摘要、假设）。
- **契约缺失**：每个 agent 的 prompt 须写清目标、输入、允许动作、禁止动作、验收标准；机器要用的输出一律走 `schema`。
- **规模失配**："看看有没有 bug" = 少量 finder + 单票校验；"彻底审计" = 大 finder 池 + 3–5 票对抗 + 合成。宁可对调研/评审厚一点，对快速检查薄一点。

## 安全与预算

- 用户没明说要多代理编排就不要开大 workflow（数十上百代理、token 消耗大）；先报预估再问。
- 改文件的任务：先快照 → agent 只改允许路径 → diff → 测试/指标门 → accept 或 restore。需要隔离用 worktree/沙箱副本。
- 禁止让 workflow 跑任意破坏性命令（rm -rf、drop、force push）。
- `agents.json` 默认继承环境变量（CLI 兼容需要）会把密钥暴露给子代理——不需要时设 `inheritEnv: false` + 窄 `env`。
- 预算：`budget.total` 为 null 时 remaining 是 Infinity，动态 while 循环必须先守 `budget.total`，否则直奔 1000 代理上限。
