# Claude Code 扩展机制与 Dynamic Workflow 调研

> 调研日期：2026-10-26。调研人：res-claude-code。
> 一手来源：code.claude.com/docs（官方文档）、claude.com/blog（官方博客）、GitHub 社区仓库。

## TL;DR

**Claude Code 有内置的 "Dynamic Workflow"（动态工作流）机制**，2026-05-28 发布并已 GA：
Claude 根据任务描述**动态编写 JavaScript 编排脚本**，由运行时在后台执行，一个 run 可并行编排数十到数百个（上限 1000）子代理，循环/分支/中间结果保存在脚本变量里而不占用 Claude 上下文。这正是 "可动态生成并执行 workflow 脚本的工具"（工具名 `Workflow`；对子代理默认屏蔽）。此外还有 Skills、Plugins、Subagents、Agent Teams、Hooks、MCP、Agent SDK 等扩展面。

---

## 1. 官方扩展机制（与多步骤/多子代理编排相关）

### 1.1 Skills（含原 Slash Commands）
- 来源：https://code.claude.com/docs/en/skills 、https://code.claude.com/docs/en/slash-commands
- 形式：`SKILL.md`（首行 YAML frontmatter + Markdown 指令），懒加载；遵循 Agent Skills 开放标准（agentskills.io）。
- **自定义命令已并入 skills**：`.claude/commands/deploy.md` 与 `.claude/skills/deploy/SKILL.md` 均生成 `/deploy`。
- 安装位置：
  | 位置 | 路径 |
  |---|---|
  | 企业 | managed settings 目录下 `.claude/skills/<name>/SKILL.md` |
  | 个人 | `~/.claude/skills/<name>/SKILL.md` |
  | 项目 | `.claude/skills/<name>/SKILL.md`（可提交） |
  | 嵌套(monorepo) | `<subdir>/.claude/skills/<name>/SKILL.md` |
  | 插件 | `<plugin>/skills/<name>/SKILL.md` → `/plugin-name:skill-name` |
- frontmatter 关键字段：`name`、`description`（自动触发依据）、`when_to_use`、`arguments`/`argument-hint`（`$ARGUMENTS`、`$name`、`$1` 替换）、`allowed-tools`/`disallowed-tools`、`model`、`effort`、`context: fork`（在分叉子代理中运行）、`agent`（fork 时用哪个子代理类型）、`background`、`hooks`、`paths`、`disable-model-invocation`、`user-invocable`、`metadata`。
- 注意：在 claude.ai / Skills API / package_skill.py 等 Claude Code 之外，仅允许 `name/description/license/compatibility/metadata/allowed-tools`。

### 1.2 Subagents（子代理）与 Agent 工具
- 来源：https://code.claude.com/docs/en/sub-agents
- 形式：`agents/<name>.md`，frontmatter + body（= system prompt）。必填 `name`、`description`。
- 其他字段：`tools`/`disallowedTools`、`model`、`permissionMode`、`maxTurns`、`skills`（预载最多 32 个）、`mcpServers`、`hooks`、`memory`、`background`、`isolation: worktree`、`effort`、`color`、`initialPrompt`。
- 位置优先级：managed settings > `--agents` CLI > `.claude/agents/` > `~/.claude/agents/` > plugin `agents/`。
- **编排原语是 Agent 工具**（v2.1.63 前叫 Task 工具，别名兼容）：`Agent({ subagent_type, ... })`；支持并行研究、链式（reviewer→optimizer）、嵌套（默认最深 3 层，`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`），并发上限 `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`（默认 20）。
- 对每个子代理强制移除的工具里出现 `Workflow`——即 Workflow（动态工作流）工具不下发给子代理，仅供主会话使用。

### 1.3 Agent Teams（团队/teammates，实验特性）
- 来源：https://code.claude.com/docs/en/agent-teams
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 开启。一个 session 作 team lead，teammates 是独立 Claude Code 实例，用 mailbox（`~/.claude/teams/{team}/inboxes/{agent}.json`）互发消息 + 共享任务列表（pending/in-progress/completed + 依赖），自然语言动态决定团队规模与分工，可复用 subagent 定义派生 teammate。限制：每 session 一个 team、不能嵌套 team、lead 固定。适合 3–5 个并行独立任务；顺序/共享文件编辑不适合。

### 1.4 Hooks
- 来源：https://code.claude.com/docs/en/hooks
- 配置位置：`~/.claude/settings.json`、`.claude/settings.json`、`.claude/settings.local.json`、plugin `hooks/hooks.json`、skill/subagent frontmatter 的 `hooks` 字段。多层 merge。
- 事件：`SessionStart/SessionEnd`、`UserPromptSubmit`、`Stop`/`StopFailure`、`PreToolUse`/`PostToolUse`（含 `PermissionRequest`、`PostToolUseFailure` 等）。agent teams 另有 `TeammateIdle`、`TaskCreated`、`TaskCompleted`（exit 2 可阻断/反馈）。
- handler 类型：`command` / `http` / `mcp_tool` / `prompt` / `agent`（实验）。
- 配置三层嵌套：`hooks.<Event>:[{matcher, hooks:[{type, command, ...}]}]`；占位符 `${CLAUDE_PROJECT_DIR}`、`${CLAUDE_PLUGIN_ROOT}`、`${CLAUDE_PLUGIN_DATA}`。
- `claude -p` / Agent SDK 下也可用 PreToolUse hook 放行 Workflow。

### 1.5 MCP
- 来源：https://code.claude.com/docs/en/mcp
- `claude mcp add --transport http|stdio ...`；配置：local（`~/.claude.json`）、project（`.mcp.json`）、user。plugin 内打包于 `.mcp.json` 或 manifest `mcpServers`（支持 .mcpb/.dxt 打包、remote https）。
- 与编排相关：**Channels**（MCP server 声明 `claude/channel` 能力 + `--channels`，向会话推送外部事件让 Claude 自主反应）、动态 tool 更新（`list_changed`）、MCP tasks（server 端长任务，v2.1.304+ beta）。

### 1.6 Agent SDK（程序化编排）
- 来源：https://code.claude.com/docs/en/agent-sdk
- Python：github.com/anthropics/claude-agent-sdk-python ；TypeScript：github.com/anthropics/claude-agent-sdk-typescript ；示例：anthropics/claude-agent-sdk-demos。
- 复用 Claude Code 的 agent loop/工具/上下文管理；编排原语：built-in tools、Hooks、**Subagents**（拆子任务）、MCP、Permissions、Sessions（resume/fork）、Skills/Commands/Memory、Plugins。
- 官方博客《A harness for every task — dynamic workflows in Claude Code》说明 Claude Code 团队内部就用动态工作流同时编排大量子代理。
- 非 Py/TS 语言可 subprocess 跑 CLI：`claude -p --output-format json`。

---

## 2. 内置 Dynamic Workflow（重点）

来源：https://code.claude.com/docs/en/workflows ；发布公告 https://claude.com/blog/introducing-dynamic-workflows-in-claude-code （2026-05-28，已 GA；早期 v2.1.154+ research preview）

### 2.1 机制
- 一个 **dynamic workflow = 一段 JS 编排脚本**：Claude 按任务描述写出脚本（含 fan-out 循环、分支、收集、对抗校验），运行时后台执行，只有最终答案回到对话。"脚本持有 loop/分支/中间结果，Claude 上下文只留最终答案"。
- 对比（谁掌握计划）：Subagents=Claude 逐轮决定；Skills=Claude 跟随指令；Agent Teams=lead 监督 peers；**Workflows=脚本决定**，结果存脚本变量，可重复的是编排本身，规模数十~数百/次（上限 1000 agents/run），中断可恢复（resumable）。
- 触发方式：直接说 "Create a workflow"；或开启 **ultracode**（effort 菜单里的 Claude Code 专属开关，effort=xhigh 并自动决定何时用 workflow）。Pro 需在 `/config` 打开 Dynamic workflows 行。适用：付费计划、API、Bedrock、Vertex、Foundry。token 消耗显著高于普通会话，首次触发需确认。

### 2.2 脚本 API
```js
export const meta = {
  name: 'audit-routes',
  description: 'Audit every route handler for missing auth checks',
}
const found = await agent('List every .ts file under src/routes/.', {
  schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } },
})
const audits = await pipeline(found.files, file =>
  agent(`Audit ${file} for missing authentication checks.`, { label: file }),
)
return audits.filter(Boolean)
```
- `agent(prompt, opts?)`：派一个子代理，opts 含 `schema`（结构化 JSON 输出）、`label`、`stallMs`；被停/不可恢复错误时 resolve `null`。
- `pipeline(items, fn)`：每 item 一个 agent；`parallel(tasks)`：并发等全部；`phase(title)`：进度分组（须与 meta.phases 一致）；`log(msg)`；`args`：调用方传入的全局输入。
- 社区 spec 还提到 `workflow()` 构造与 `budget` 全局（runtime 注入的工具元数据，见 zircote/workflows-plugin vendor）。
- 规则：`meta` 必须是第一个语句且为纯对象字面量；**确定性约束**：`Date.now()`/`Math.random()`/`new Date()` 抛错（保证重跑产生相同 agent 调用）；**禁止 `import()`**；schema 先验证后启动，输出校验失败重试 5 次（`MAX_STRUCTURED_OUTPUT_RETRIES`）后失败。

### 2.3 存放/分发/调用
| 范围 | 位置 | 调用 |
|---|---|---|
| 项目共享 | `.claude/workflows/`（monorepo 取离 cwd 最近者） | `/<name>` |
| 个人 | `~/.claude/workflows/`（或 `${CLAUDE_CONFIG_DIR}/workflows/`） | `/<name>`（与项目重名时项目优先） |
| 插件 | plugin 根 `workflows/` 目录，或 manifest `workflows` 字段指定 | `/<plugin-name>:<meta.name>`，如 `/acme-tools:release-audit` |
- 保存：`/workflows` 选 run 按 `s`，Tab 切换保存位置；运行：`/<name>`（可带 args，如 `Run /triage-issues on issues 1024...`）。
- 审批：Yes, run it / Yes, and don't ask again / View raw script / No；`Ctrl+G` 开编辑器。Auto 模式仅首次；`claude -p`/SDK 不提示，可用权限规则 `Workflow`、`Workflow(<name>)`、PreToolUse hook 返回 "allow"、`--permission-prompt-tool`/`canUseTool`。
- 恢复：`/workflows` 按 `p` 恢复暂停 run；停止的 run 让 Claude 重发同脚本；已完成且 prompt 未变的 agent 直接返回缓存结果，从第一个 prompt 变化的 agent 起重跑。
- 文档还提到 `claude plugin validate <dir>` 校验插件。

---

## 3. 社区现成方案（GitHub）

| 仓库/站点 | 是什么 & 怎么工作 | 安装 |
|---|---|---|
| **zircote/workflows-plugin** https://github.com/zircote/workflows-plugin | 针对 Workflow 工具的 `dynamic-workflows` skill：`reference/api.md`（Anthropic 官方机制蒸馏：7 个核心构造、pipeline vs parallel、审批/成本/恢复）+`reference/patterns.md`（20 个编排模式 4 族 + 8 反模式，GoF 风格）+ evals；vendor 官方文档并用 VENDOR.lock 记 sha256 | `claude plugin marketplace add zircote/workflows-plugin` && `claude plugin install dynamic-workflows@dynamic-workflows` |
| **vinnie357/claude-skills（claude-workflows）** https://www.skills.sh/vinnie357/claude-skills/claude-workflows | 教 dynamic workflow 概念与写法的 skill（面向 Claude Code v2.1.154+） | `npx skills add https://github.com/vinnie357/claude-skills --skill claude-workflows` |
| **moismailzai/claude-code（plugins/orchestration）** https://github.com/moismailzai/claude-code/blob/main/plugins/orchestration/README.md | "Orchestration Plugin"：把编排知识做成可复用 skills——并行多模型执行（经 Claudish 代理 3–5x）、多代理协调（串行 vs 并行）、质量门/迭代循环、错误恢复、TodoWrite 阶段跟踪 | `/plugin install orchestration@mag-claude-plugins`；skill 形如 `orchestration:multi-model-validation` |
| **baryhuang/claude-code-by-agents（Agentrooms）** https://github.com/baryhuang/claude-code-by-agents 、https://claudecode.run/ | 多代理工作区：内置 orchestrator、@agent-name 直接路由、自动任务分解、本地+远程 agents（HTTP 到各自端口）、web UI 动态增删 agent | 克隆后 Deno 起 backend + npm 起 frontend；也提供桌面 App |
| **obra/superpowers** https://github.com/obra/superpowers | agentic skills 框架（v7.0.1）：brainstorming→writing-plans→**subagent-driven-development**（每任务派新子代理 + 两阶段评审）/ executing-plans，**dispatching-parallel-agents**（并发子代理工作流）、TDD、code-review 闭环；跨多 harness 的插件格式 | `/plugin install superpowers@claude-plugins-official` 或 obra/superpowers-marketplace |
| 目录/榜单 | mtangoz/awesome-claude-code-plugins（有 "Workflow Orchestration" 分类：agent-triforce、artel、equilateral-agents、launch-swarm、nexus-agents、pro-workflow 等）https://github.com/mtangoz/awesome-claude-code-plugins ；claudemarketplaces.com（23k+ skills / 2.7k+ marketplaces 目录）；skills.sh | 各仓库自带安装说明 |
| SuperClaude https://superclaude.sh/ | GitHub 工作流增强的商业/开源框架（未深入核实） | — |

官方编排向插件（anthropics/claude-plugins-official）：`feature-dev`（特性开发工作流）、`code-review`、`commit-commands`、`security-guidance`、`agent-sdk-dev`、`pr-review-toolkit`。

---

## 4. 安装位置与格式汇总

### 4.1 Plugin 目录结构（来源：https://code.claude.com/docs/en/plugins 、.../plugins/components）
```
my-plugin/
├── .claude-plugin/plugin.json      # manifest（唯一必填 name）
├── .claude-plugin/marketplace.json # 若本仓是 marketplace（catalog 即此文件）
├── skills/<name>/SKILL.md
├── commands/<file>.md              # 旧式 slash command
├── agents/<name>.md                # 子代理（递归扫描，子目录名用 : 连接）
├── hooks/hooks.json                # hooks（+ modules 键=JS "mods"）
├── workflows/<name>.js             # ★ 动态工作流编排脚本
├── monitors/monitors.json          # 后台 shell（experimental）
├── output-styles/<name>.md、themes/<slug>.json、bin/、scripts/
├── .mcp.json / .lsp.json / settings.json / package.json
```
- `plugin.json` 主要字段：name(必填)、displayName、version、description、author{name,email,url}、homepage、repository、license、keywords、metadata、icon、defaultEnabled、dependencies、userConfig、types、channels、`skills/commands/agents/hooks/mcpServers/lspServers/outputStyles/workflows`（path|array|inline，替代或合并默认目录扫描）、experimental{themes,monitors,evals}。
- 装载三层：settings（marketplaces + plugins enabled）→ 磁盘 `~/.claude/plugins/` → session 加载。scope：user / project（`.claude/settings.json` 提交）/ local。
- 开发免 marketplace：`--plugin-dir <dir>`。

### 4.2 Marketplace
- marketplace = 含 `.claude-plugin/marketplace.json` 的 repo/目录。添加：`/plugin marketplace add <owner>/<repo>`；安装：`/plugin install <name>@<marketplace>` 或 `claude plugin install ...`（另有 `claude plugin marketplace add` CLI）。
- 官方三分（来源：https://code.claude.com/docs/en/plugins/anthropic-marketplaces）：
  - Official：**anthropics/claude-plugins-official**，marketplace 名 `claude-plugins-official`，首个交互会话自动添加。
  - Community：**anthropics/claude-plugins-community**，marketplace 名 `claude-community`（注意与 repo 名不同）。
  - Demo：anthropics/claude-code（repo 的 plugins/ 目录），名 `claude-code-plugins`。
  - 其余为 third-party。官方名保留给 github.com/anthropics/ 下仓库。Web 目录：https://claude.com/marketplace/plugins 。

### 4.3 常用速查
- Skill：`SKILL.md` + frontmatter（name/description/context/agent/background/hooks/...）；位置 `~/.claude/skills`、`.claude/skills`、plugin `skills/`。
- Subagent：`agents/<name>.md` frontmatter（name/description/tools/model/...）；位置 `~/.claude/agents`、`.claude/agents`、plugin `agents/`。
- Workflow：`workflows/<name>.js`（`export const meta` + 脚本体）；位置 `.claude/workflows`、`~/.claude/workflows`、plugin `workflows/`。
- Hooks：settings.json `hooks` 或 plugin `hooks/hooks.json`。
- MCP：`.mcp.json`（project）/`~/.claude.json`（local/user）。

## 5. 来源 URL
- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/slash-commands
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/agent-teams
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/workflows （★ dynamic workflows）
- https://code.claude.com/docs/en/agent-sdk
- https://code.claude.com/docs/en/plugins
- https://code.claude.com/docs/en/plugins/components
- https://code.claude.com/docs/en/plugins/manifest-reference
- https://code.claude.com/docs/en/plugins/anthropic-marketplaces
- https://claude.com/blog/introducing-dynamic-workflows-in-claude-code （2026-05-28 GA 公告；含 Bun 用 dynamic workflows 从 Zig 移植 Rust 案例）
- https://github.com/zircote/workflows-plugin
- https://github.com/obra/superpowers
- https://github.com/moismailzai/claude-code/tree/main/plugins/orchestration
- https://github.com/baryhuang/claude-code-by-agents （https://claudecode.run/）
- https://github.com/mtangoz/awesome-claude-code-plugins
- https://claudemarketplaces.com/
- https://www.skills.sh/vinnie357/claude-skills/claude-workflows
- https://claude.com/marketplace/plugins
