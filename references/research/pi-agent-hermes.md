# 调研：pi-agent 与 hermes 两个 AI agent harness

调研日期：2026-10-26。来源为公开网络（GitHub / 官网 / 文档站）。

---

## A. pi-agent = Pi Coding Agent（earendil-works/pi）

**确认项目**：用户所说的 "pi-agent" 即 **Pi** —— 一个极简、可自定义的 agent harness / coding agent CLI。

- 官网：https://pi.dev/ （安装：`curl -fsSL https://pi.dev/install.sh | sh` 或 `npm i -g --ignore-scripts @earendil-works/pi-coding-agent`）
- 仓库：https://github.com/earendil-works/pi （monorepo，MIT，主要维护者 @badlogic / Mario Zechner，原 pi-mono）
- npm 包名：`@earendil-works/pi-coding-agent`；文档：https://pi.dev/docs/latest
- 定位："There are many agent harnesses but this one is yours" —— 默认**不带** sub-agents / plan mode，靠扩展补齐。
- 四种运行模式：interactive、print/JSON、RPC、TypeScript SDK。Node.js 22.19+。

### 扩展机制
1. **Extensions**（TS 扩展，可注册工具/命令/修改行为）：`packages/coding-agent/docs/extensions.md`
2. **Skills**（技能文档）：`docs/skills.md`
3. **Prompt templates**、**Themes**
4. **Pi packages**：把上述打包，通过 npm 或 git 分享分发（`pi install npm:xxx` / `pi install git:xxx`），目录 `~/.pi/agent/settings.json` 的 `packages` 字段可挂本地包；项目级 `.pi/`（agents/、workflows/ 等）。包清单（package.json 里的 `pi` 字段）声明 `"extensions": ["./src/index.ts"]`。热重载：`/reload`。
- 安全提示：Pi 包可执行代码，官方建议安装前审阅源码。无内置权限系统（可用 Gondolin 微虚拟机 / Docker / OpenShell 隔离）。

### 现成的 dynamic-workflow 实现（重点）
用户提到的 "pi-agent dynamic-workflow" 确实存在，且有多个实现/分支：

1. **milanglacier/pi-dynamic-workflow**（npm `pi-dynamic-workflow`，v0.3.0，2026-10-06，MIT）
   - 仓库：https://github.com/milanglacier/pi-dynamic-workflow
   - npm 页面：https://pi.dev/packages/pi-dynamic-workflow
   - 做法：`/workflow <task>` 注入 authoring brief，session LLM 现写一段 **JavaScript 编排脚本**，由 `workflow` tool 在 `node:vm` 沙箱执行；脚本调用 `agent()` 派生**完全隔离的 pi 子进程**（`pi --mode json -p --no-session`，独立上下文窗口）。
   - API：`agent(prompt, opts)`（opts：label/phase/model/tools/excludeTools/noMcp/cwd/schema/timeout/systemPrompt/agentType；失败返回 null 而非 reject）、`parallel(thunks)`、`pipeline(items, ...stages)`、`phase(title)`、`log()`、`args`、`budget`、`workflow(name, args)`（一层嵌套）。
   - 结构化输出：`opts.schema`（JSON Schema，经临时 emit_result 扩展强制校验）。
   - 工程化：journal 断点续跑（`~/.pi/agent/pi-dynamic-workflow/runs/<runId>.jsonl`，按位置索引回放缓存，`resumeFromRunId`）、后台运行（`background:true` + `/workflow-stop`）、预算（maxCost/maxTokens/maxAgents=200/maxConcurrency）、agent types（`.pi/agents/*.md`）、保存的 workflow（`.pi/workflows/*.js`）。确定性约束：禁 Date.now/Math.random/require/import/fs/网络。
   - 质量模式：adversarial verify、loop until clean、judge panel、multi-angle sweep。

2. **Michaelliv/pi-dynamic-workflows**（npm `npm:pi-dynamic-workflows`，v1.0.1）
   - 仓库：https://github.com/Michaelliv/pi-dynamic-workflows
   - "Claude-Code-style dynamic workflows for Pi"，灵感来自 Anthropic 在 Claude Code 中的 dynamic workflows。同样是 JS 脚本 + `agent()/parallel()/pipeline()/phase()` + vm 沙箱 + JSON Schema 结构化输出（底层 Pi structured_output tool, terminate:true）。子代理为 in-memory Pi session。原型阶段，无持久化/续跑、无 /workflows 管理器。包命名空间 @earendil-works。

3. **QuintinShaw/pi-dynamic-workflows**（★555，fork/增强版）与其 fork **KoSukeWork/pi-dynamic-workflows**
   - 介绍页：https://followagents.com/en/agents/pi-dynamic-workflows
   - 增强：模型路由（small/medium/big tier 或精确 provider:model）、journal 续跑 + 编辑后续跑（resumeFromRunId）、git worktree 隔离、成本核算、后台面板 + 交互式 `/workflows` TUI、`/ultracode`、内置 `/deep-research` `/adversarial-review` `/multi-perspective` `/code-review` `/codebase-audit` 等入口、运行时 helper（`verify()`/`judgePanel()`/`loopUntilDry()`/`completenessCheck()`/`retry()`/`gate()`/`checkpoint()`）、单次最多 1000 agent（并发 ≤16）、状态存 `~/.pi/workflows`。需要 Pi ≥ 0.80.8：`pi install npm:@quintinshaw/pi-dynamic-workflows`。

4. **Skill 形态（不装扩展也能用）**：LEUNGUU/pi-agent-config 的 `skills/dynamic-workflows`
   - https://github.com/LEUNGUU/pi-agent-config/tree/main/skills/dynamic-workflows （收录：https://skillsmp.com/creators/leunguu/pi-agent-config/skills-dynamic-workflows）
   - 移植自 Thariq Shihipar "A harness for every task: dynamic workflows in Claude Code"（https://x.com/trq212/status/2061907337154367865）的 6 种编排模式：fanout-synthesize / classify-and-act / adversarial-verify / generate-and-filter / tournament / loop-until-done / deep-research。
   - 实现极简：`runAgent()` 用 `pi --mode json -p --no-session` 起子进程 + `mapLimit` 有界并发；每个 .mjs 既是 CLI 又是可组合 ES module（deep-research 即 import verify + mapLimit 合成）。

**参考价值**：workflow = LLM 现写确定性 JS 编排脚本（vm 沙箱） + `agent()/parallel()/pipeline()/phase()` 原语 + 隔离子会话（子进程或 in-memory session）+ JSON Schema 结构化返回 + journal 缓存续跑 + 预算/并发上限 + worktree 隔离编辑。

---

## B. hermes = Hermes Agent（NousResearch/hermes-agent）

**确认项目**：用户所说的 "hermes" 应为 **Nous Research 的 Hermes Agent** —— 开源（MIT）自主 agent CLI/TUI，Python 实现。

- 仓库：https://github.com/NousResearch/hermes-agent
- 文档：https://hermes-agent.nousresearch.com/docs/... （CLI: /docs/user-guide/cli.md；功能总览: /docs/user-guide/features/overview；子代理: /docs/user-guide/features/delegation）
- 官网：https://hermes-agent.nousresearch.com/ ；安装 `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`，`hermes setup`。
- 定位：不只是 coding copilot，是常驻（服务器/消息平台）的自主 agent：Telegram/Discord/Slack/WhatsApp/Signal/Email/CLI 网关、持久记忆（MEMORY.md/USER.md）、自动技能、cron 定时任务、语音、浏览器自动化、5 种沙箱后端（local/Docker/SSH/Singularity/Modal）。
- 命令：`hermes`/`hermes chat -q`/`hermes model`/`hermes tools`/`hermes gateway`/`hermes setup`/`hermes doctor`/`hermes worktree list|prune|restore`；会话 `--resume/-c/--continue`；`-w` 在隔离 git worktree 中跑（自动 .worktrees/ 生命周期管理、6 小时清扫、归档可恢复）。

### 扩展机制
1. **Skills System**：按需加载的知识文档（渐进式披露省 token），兼容 agentskills.io 开放标准；agent 会在工作中**自动写/修订技能**（自成长）。
2. **Tools & Toolsets**：按平台启用/禁用的工具集（web 搜索、终端、文件编辑、记忆、delegation 等），`hermes tools` 配置。
3. **Context files**：自动加载 `.hermes.md`/AGENTS.md/CLAUDE.md/SOUL.md/.cursorrules；`@ref` 上下文引用。
4. **Event Hooks**：gateway hooks（日志/告警/webhook）+ plugin hooks（工具拦截/指标/护栏）。
5. **execute_code**：agent 写 Python 脚本经沙箱 RPC 调用 Hermes 工具，多步流程压成一轮。
6. **Batch Processing**：批量 prompt 并行跑，产出 ShareGPT 轨迹数据。

### 现成 workflow / 多代理方案
- **Subagent Delegation（delegate_task）**：派生子 AIAgent 实例，独立上下文、继承工具、自己的终端会话；只把最终摘要回填父上下文。顶层模型调用后台自动执行，父立即拿到 handle 继续对话，完成后回投消息。默认并发 3（可配）。编排型子代理会等自己的 worker 汇总后再返回。文档：https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation
- **/goal**：给 agent 一个常驻目标，停了会自动继续 —— 大型编排的主要驱动方式。
- **实战范例（Nous 官方博客）**："Refactoring Hermes with 1,393 agents"（https://nousresearch.com/refactoring-hermes-with-1393-agents）：主 agent 编排，切 36 组非重叠任务，1393 个子代理（峰值并发 218），worker 用 git worktree 隔离编辑、三层委派、脚本化集成与校验（JSON schema 字节级对比、--help 输出比对），19 活跃小时、约 $19.3k 模型成本、代码量 -34.4%。这是 Hermes 版"dynamic workflow"的现实样板。
- **注意**：Hermes **没有**名为 "dynamic-workflow" 的现成组件；其多代理编排 = delegate_task + worktree + execute_code + /goal + skills 里的流程沉淀（如 hermes-agent-dev 技能）。若要做 JS 编排脚本式 workflow，需要照 pi-dynamic-workflow 的思路自建（或直接参考 Claude Code dynamic workflows 原始设计）。

---

## 结论速览
| 名字 | 真实项目 | 语言 | 扩展机制 | dynamic-workflow 现成方案 |
|---|---|---|---|---|
| pi-agent | Pi Coding Agent（earendil-works/pi，pi.dev，@badlogic） | TypeScript | extensions/skills/prompt templates/themes + Pi packages（npm/git） | 有：milanglacier/pi-dynamic-workflow（npm pi-dynamic-workflow）、Michaelliv/pi-dynamic-workflows、QuintinShaw 增强版、LEUNGUU skill 版 |
| hermes | Hermes Agent（NousResearch/hermes-agent） | Python | skills(agentskills.io)/tools/toolsets/hooks/plugins/execute_code | 无同名组件；delegate_task 子代理 + /goal + worktree + 官方 1393-agent 重构实战 |
