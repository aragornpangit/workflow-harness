# CodeBuddy Code（CLI）扩展机制调研

> 调研人：res-codebuddy ｜ 日期：2026-10-26
> 主要来源：本机内置文档 `~/.nvm/versions/node/v24.16.0/lib/node_modules/@tencent-ai/codebuddy-code/dist/web-ui/docs/cn/cli/*.md`（亦有 `en/cli/` 英文版）
> 佐证来源：cnb.cool 仓库文档地图、agentskills.io 开放标准、opencode.ai / Codex 官方文档

---

## 0. 一句话结论

CodeBuddy Code 的扩展体系与 Claude Code 高度同构（`.codebuddy/` ≈ `.claude/`），核心是 **SKILL.md 技能**（Anthropic Agent Skills 开放标准的兼容实现）、自定义斜杠命令、子代理（agents）、Hooks、MCP、插件（marketplace）以及独有的 **Dynamic Workflows**（模型侧 `Workflow` 工具，脚本化编排数十上百个子代理）。Skill 目录/格式与 claude-code、codex、opencode 三家均有交集，具备"通用 skill"可移植性。

---

## 1. Skills（技能系统）

来源：内置文档 `cn/cli/skills.md`、`cn/cli/codebuddy-dir.md`；线上 `https://cnb.cool/codebuddy/codebuddy-code/-/git/raw/main/docs/skills.md`

### 1.1 本质与触发

- Skill = 封装好的领域知识/工作流模板，由 **AI 自动识别调用**（对比 Slash Command 是用户手动触发）。
- 选择依据：任务与 `description` 匹配度、工具需求、上下文相关性；**项目级 > 用户级**。

### 1.2 安装路径（关键）

| 级别 | 路径 | 说明 |
|---|---|---|
| 用户级 | `~/.codebuddy/skills/<name>/SKILL.md` | 全项目生效 |
| 项目级 | `<repo>/.codebuddy/skills/<name>/SKILL.md` | 随仓库共享，优先级更高 |
| 插件级 | `<plugin>/skills/<name>/SKILL.md` | 名称带命名空间 `/plugin-name:skill-name` |

每个 skill 是一个目录，可携带 `scripts/`、`references/`、`assets/` 等辅助文件（与 Agent Skills 标准的目录结构一致）。

### 1.3 SKILL.md frontmatter 字段（CodeBuddy 扩展集）

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 否（缺省取目录名） | Skill 名称 |
| `description` | 否 | 帮助 AI 判断何时使用 |
| `allowed-tools` | 否 | 工具白名单，支持 `Bash(git:*)`、`Edit(src/**/*.ts)` 模式 |
| `disable-model-invocation` | 否 | true 时仅 `/skill-name` 手动触发 |
| `user-invocable` | 否 | false 时从 `/` 菜单隐藏，仅供 AI/其他 skill 引用 |
| `context` | 否 | `fork` 时在隔离 subagent 上下文执行 |
| `agent` | 否 | fork 时指定 subagent 类型（`general-purpose`/`Explore`/`Plan`/`.codebuddy/agents/` 自定义） |
| `model` | 否 | fork 时使用的模型 |
| `hooks` | 否 | Skill 自带 hooks（仅 `context: fork` 生效） |

### 1.4 运行时特性

- **变量占位符**：`${CODEBUDDY_SKILL_DIR}`、`${CODEBUDDY_PLUGIN_ROOT}`（仅插件来源）、`${CODEBUDDY_SESSION_ID}`、`${ENV:-默认值}`；兼容别名 `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_SKILL_DIR}`/`${CLAUDE_SESSION_ID}`。
- **内联 shell**：`!`command`` 语法执行命令并注入输出；处理管道：`$ARGUMENTS` 替换 → shell 执行 → `@file` 引用处理。
- **产物声明（A2A artifact）**：Bash 执行时注入 `$CODEBUDDY_ARTIFACTS` 文件，脚本每行追加一个 JSON（uri/name/mimeType…），仅 A2A 被调场景生效；旧 `::codebuddy-artifact::` stdout 标记已废弃。
- **Context Fork**：隔离上下文跑子代理，结果回主对话；frontmatter `hooks` 生命周期随 fork subagent，`Stop` 自动重写为 `SubagentStop`。安全闸门：非内置来源的 frontmatter hooks 需 `settings.json` 设 `allowUntrustedFrontmatterHooks: true`。
- **可见性覆盖（skillOverrides）**：settings 中按 skill 名设 `on` / `name-only` / `user-invocable-only` / `off`，优先级 `settings.local.json > .codebuddy/settings.json > ~/.codebuddy/settings.json`；plugin skill 不受此影响。
- 调试：`/skills` 查看已加载 skill 与预估 token。

---

## 2. Slash Commands（自定义斜杠命令）

来源：`cn/cli/slash-commands.md`、`cn/cli/codebuddy-dir.md`

- **路径**：项目 `.codebuddy/commands/*.md`（调用 `/cmd`）；用户级 `~/.codebuddy/commands/*.md`；子目录按 `/group:cmd` 命名（如 `commands/git/commit.md` → `/git:commit`）。
- **frontmatter**：`description`、`argument-hint`、`allowed-tools`（如 `Bash(npm run:*)`，用 shell 内联时必须含 Bash）、`model`、`disable-model-invocation`。
- **参数**：位置参数 `$1 $2...` 与全量 `$ARGUMENTS`；空格分隔、支持引号。
- **正文能力**：`!`cmd`` 内联 shell（输出注入上下文）、`@file` 文件引用注入。
- 与 Skill 的区别：命令是用户主动快捷方式；Skill 是 AI 自动选择的专业能力。

---

## 3. Subagents（子代理）

来源：`cn/cli/sub-agents.md`

- **路径**：`.codebuddy/agents/*.md`（项目，最高）＞ CLI `--agents '{json}'` ＞ `~/.codebuddy/agents/*.md`（用户）。文件 = YAML frontmatter + 系统提示正文。
- **frontmatter 字段**：`name`（必填）、`description`（必填）、`tools`（逗号分隔，省略继承全部；支持 `Defer()/NoDefer()`）、`model`（ID/别名/`lite`/`reasoning`/`inherit`）、`permissionMode`、`skills`（启动自动加载）、`mcpServers`（子代理私有 MCP，引用全局或 inline stdio）、`disallowedTools`、`effort`、`maxTurns`、`background`、`initialPrompt`、`memory`（user/project/local 持久记忆作用域）。
- **限制**：嵌套深度 ≤5 层（默认不持有 Agent 工具）；根会话树默认并发 20 个子代理（`CODEBUDDY_CODE_MAX_CONCURRENT_SUBAGENTS`）；每会话 spawn 预算 200（`CODEBUDDY_CODE_MAX_SUBAGENTS_PER_SESSION`）。
- 内置 agent：`general-purpose`、`Explore`、`Plan`，可在 `/agents` 按 agent 粒度配模型；Skill 的 `context: fork` 可指定这些类型。

---

## 4. Hooks（钩子）

来源：`cn/cli/hooks.md`、`cn/cli/hooks-guide.md`

- **配置位置**：`~/.codebuddy/settings.json`（用户级）/`<项目>/.codebuddy/settings.json`（项目级）的 `hooks` 键；插件 `hooks/hooks.json`；Agent/Skill frontmatter `hooks`（受 allowUntrustedFrontmatterHooks 闸门，仅 fork skill 生效）。三者同事件**叠加合并**。
- **事件**：`PreToolUse`、`PostToolUse`、`Notification`（matcher：permission_prompt / idle_prompt）、`UserPromptSubmit`、`Stop`、`SubagentStop`、`PreCompact`、`PostCompact`、`SessionStart`（matcher：startup/resume/clear/compact）、`SessionEnd`。
- **结构**：`{ "<Event>": [ { "matcher": "工具名正则", "hooks": [ {...} ] } ] }`；matcher 仅部分事件支持，其余可省略。
- **hook type**：`command`（shell，stdin 收 JSON，可用 $CODEBUDDY_PROJECT_DIR；Windows 强制 Git Bash）、`prompt`（小模型语义判定，仅 Stop/UserPromptSubmit/PreToolUse）、`agent`（subagent 判定）、`http`（POST/PUT/PATCH）。
- **输出**：退出码 0/2 语义（2 = 阻止并提示）；JSON 输出可做 PreToolUse 放行/阻止决策、PostToolUse `updatedToolOutput` 替换工具结果、Stop 三态（含 `impossible`）；`continueOnBlock` 可让 Stop hook 驱动持续工作（`/goal` 即其封装）。
- MCP 工具 matcher 命名：`mcp__<server>__<tool>`。

---

## 5. MCP

来源：`cn/cli/mcp.md`、`cn/cli/sub-agents.md`

- **传输**：stdio / SSE / http（`type` 字段；含 command 推断为 stdio）。
- **配置文件**：用户级 `~/.codebuddy/.mcp.json`；项目级 `<项目根>/.mcp.json`（推荐）；也可写 settings 的 mcpServers；子代理可声明 scoped/inline MCP。命令行 `codebuddy mcp add-json --scope user|project ...`。
- **审批**：项目 MCP 需本地批准（`.codebuddy/settings.local.json` 的 `enabledMcpjsonServers`，或 `--settings`）。
- **延迟加载**：MCP 工具默认 deferred（`ToolSearch` 发现 + `DeferExecuteTool` 调用），可 `defer_loading: false` 关闭。
- 另有 MCP Apps（UI Resource/App Tool/iframe）、MCP Prompts 集成（`cn/cli/mcp-apps.md`）。

---

## 6. Plugins（插件）

来源：`cn/cli/plugins.md`、`cn/cli/plugins-reference.md`、`cn/cli/plugin-marketplaces.md`

- **清单**：插件根目录 `.codebuddy-plugin/plugin.json`（name/version/description/author/homepage/repository/keywords/category…）。name 即技能命名空间（`/my-plugin:hello`）。
- **目录结构**（都在插件根，勿放进 `.codebuddy-plugin/`）：`commands/`（斜杠命令 .md）、`agents/`（子代理 .md）、`skills/`（SKILL.md 目录）、`hooks/hooks.json`、`.mcp.json`、`.lsp.json`、`bin/`（加入 Bash PATH）、`settings.json`（目前仅支持 `agent` 键，可把插件 agent 激活为主线程）。
- **市场与安装**：`/plugin marketplace add`（GitHub / Git 仓库 / 本地 / HTTP 四类市场）、`/plugin install`；settings 的 `enabledPlugins` + `extraKnownMarketplaces` 支持团队自动安装；`codebuddy --plugin-dir ./my-plugin` 本地试跑；`/reload-plugins` 热加载；`/plugin-validate` 校验。
- 插件 hooks（hooks.json）**不受** allowUntrustedFrontmatterHooks 闸门约束；frontmatter hooks 受约束。

---

## 7. Dynamic Workflows（动态工作流，工具名 `Workflow`）

来源：`cn/cli/workflows.md`、`cn/cli/tools-reference.md`

- **定位**：模型为任务现场编写一段 JavaScript 编排脚本，运行时在隔离环境后台调度数十~数百个子代理；中间结果留在脚本变量，不进主上下文。研究预览，需 v2.105.0+，默认开启（`/config` "Dynamic workflows"、`disableWorkflows`、`CODEBUDDY_DISABLE_WORKFLOWS=1`、托管设置可关）。
- **工具接口**：模型侧工具名 `Workflow`——**入参承载编排脚本（`script` 直接给脚本正文，或 `scriptPath` 指向脚本文件）**，启动后立即返回 runId 异步执行，结果用 `TaskOutput` 拉取（tools-reference 原文：`Workflow | 启动 Dynamic Workflow 异步运行，立刻返回 runId 并在后台执行；通过 TaskOutput 拉取结果`）。每次 run 的脚本落盘在 `~/.codebuddy/projects/<session>/` 下，可读、可 diff、可改后重跑。
- **触发方式**：内置 `/deep-research <问题>`；提示词带 `ultracode` 关键词（或"用一个 workflow 跑"）；`/effort ultracode` 全会话自动编排；或直接运行已保存的 Workflow 命令 `/<name>`。
- **脚本 API（全局）**：`agent(prompt, {tools, maxTurns, schema, model})`、`parallel(items)`（≤16 并发）、`pipeline(items)`、`phase(name, body)`、`log(...)`、`args`（调用方传参）、`workflow(name, args?)`（嵌套调用已保存 workflow，仅父级）。
- **约束**：运行中不接受用户输入；workflow 自身无文件/shell 能力（一切由子代理做）；并发 ≤16；单 run ≤1000 个代理；**确定性沙箱**（禁 `Date.now()`/`Math.random()`/`eval`/`Function`/`require`/`process`，编译期扫描 + 运行时拦截）——这是 resume 缓存命中的前提。
- **保存复用**：`/workflows` 选中 run 按 `s` 存为命令 → 项目 `.codebuddy/workflows/`（团队共享）或 `~/.codebuddy/workflows/`（个人）；同名项目级优先；通过全局 `args` 传参。
- **运行管理**：`/workflows` 进度视图（按 phase 聚合，p 暂停/恢复、x 中止、r 重启 agent、可恢复仅限同会话）；运行前批准视权限模式（bypass/`-p`/SDK 免问），子代理恒在 acceptEdits 跑并继承工具白名单。
- **相关**：`cn/cli/workflow-stdio-protocol.md`（与 Claude Code 2.1.220 对齐的 workflow stdio 接入协议、abort 控制流、消息参考）。

---

## 8. 目录结构与优先级总览

来源：`cn/cli/codebuddy-dir.md`

```
~/.codebuddy/                      # 用户级
├── settings.json                  # 全局配置（hooks、skillOverrides、allowUntrustedFrontmatterHooks…）
├── CODEBUDDY.md                   # 用户记忆
├── agents/  rules/  skills/  commands/  workflows/
├── .mcp.json                      # 用户级 MCP
└── projects/ sessions/ plans/ logs/ traces/ file-history/ tasks/ teams/ plugins/ …  # 运行时数据

<repo>/.codebuddy/                 # 项目级（可提交）
├── settings.json / settings.local.json（自动 gitignore）
├── CODEBUDDY.md                   # 项目记忆（根目录 CODEBUDDY.md 等效）
├── agents/  rules/  skills/  commands/  workflows/
└── agent-memory/<name>/
```

配置优先级：CLI 参数 ＞ `.codebuddy/settings.local.json` ＞ `.codebuddy/settings.json` ＞ `~/.codebuddy/settings.json` ＞ 内置默认。代理/技能/规则：**项目级 > 用户级 > 插件级**。

---

## 9. 跨 harness 兼容性（"通用 skill"可移植性）

### 9.1 开放标准：Agent Skills（Anthropic 发起，现为开放标准）

来源：https://agentskills.io/ 、https://agentskills.io/specification

- Skill = 目录 + `SKILL.md`（YAML frontmatter + Markdown 正文）+ 可选 `scripts/`、`references/`、`assets/`。
- 标准 frontmatter：`name`（必填，≤64 字符，小写字母数字连字符、不以连字符开头结尾、无连续连字符、**须与目录名一致**）、`description`（必填，≤1024 字符）、`license`、`compatibility`（≤500）、`metadata`（string→string map）、`allowed-tools`（实验性，空格分隔）。
- 渐进披露三段：Discovery（只载 name+description）→ Activation（匹配后读全文）→ Execution（跑脚本/引用文件）。

### 9.2 各 harness 对照

| 维度 | CodeBuddy Code | Claude Code | Codex CLI | OpenCode |
|---|---|---|---|---|
| skill 目录 | `~/.codebuddy/skills/`、`.codebuddy/skills/` | `~/.claude/skills/`、`.claude/skills/` | `~/.codex/skills/`、`$REPO_ROOT/.codex/skills/`、`/etc/codex/skills/` | `~/.config/opencode/skills/`、`.opencode/skills/`，并**直接兼容** `.claude/skills`、`~/.claude/skills`、`.agents/skills`、`~/.agents/skills` |
| 文件 | `SKILL.md`（同标准目录结构） | `SKILL.md` | `SKILL.md` | `SKILL.md` |
| name 约束 | 未强制（默认取目录名） | 与标准一致（≤64） | ≤100 字符，单行 | 与标准一致（`^[a-z0-9]+(-[a-z0-9]+)*$` 且匹配目录名） |
| description | 可选但推荐 | 必填 ≤1024 | 必填 ≤500 | 必填 ≤1024 |
| 扩展字段 | allowed-tools、context/agent/model、hooks、user-invocable、disable-model-invocation | allowed-tools、model、context、hooks 等（CodeBuddy 有意对齐） | 仅 metadata（无 allowed-tools/model/context/hooks） | 基本字段，未知字段忽略 |
| 触发 | AI 自动 + `/skill-name` | AI 自动 + `/skill-name` | `$skill-name` 显式（亦有自动） | `skill` 工具按需加载 |
| 冲突规则 | 项目 > 用户 > 插件 | 项目 > 用户 | scope 优先级 ADMIN/REPO/USER/内置 | 目录逐级向上发现 |

（Codex 数据来源：skillmd.ai 对 Codex SKILL.md schema 的整理与 Codex 发布说明 "Agent skills in Codex"；OpenCode 数据来源：https://opencode.ai/docs/skills/）

### 9.3 可移植性结论

1. **标准子集完全可移植**：只用 `name` + `description` + Markdown 正文（+ 可选 `metadata`/`license`/`compatibility`）的 SKILL.md，在 codebuddy / claude-code / codex / opencode 四家都能加载；注意 name 取**小写连字符且等于目录名**、description ≤500（取各家最小上限）。
2. **目录命名差异需适配**：`~/.codebuddy/skills` vs `~/.claude/skills` vs `~/.codex/skills` vs `~/.config/opencode/skills`；opencode 与 codebuddy 都兼容/可对齐 `.claude/skills`，`.agents/skills` 被 opencode 原生扫描，可作为跨工具落点。
3. **能力字段不可移植**：CodeBuddy/Claude 的 `allowed-tools`、`context: fork`、`agent`、`model`、`hooks` 在 Codex/OpenCode 上会被忽略（Codex 无 allowed-tools），依赖这些特性的 skill 在别家降级为"纯指令"。占位符 `${CODEBUDDY_SKILL_DIR}`/`${CLAUDE_SKILL_DIR}` 是各家私有实现。
4. **触发语义差异**：Codex 用 `$skill-name` 显式调用，其他家用 `/skill-name` 或自动发现；移植时 description 的"何时使用"措辞决定自动触发效果。

---

## 10. 来源清单

**本机内置文档**（`~/.nvm/versions/node/v24.16.0/lib/node_modules/@tencent-ai/codebuddy-code/dist/web-ui/docs/`）：
- `cn/cli/skills.md`、`cn/cli/slash-commands.md`、`cn/cli/sub-agents.md`、`cn/cli/workflows.md`、`cn/cli/workflow-stdio-protocol.md`、`cn/cli/hooks.md`、`cn/cli/hooks-guide.md`、`cn/cli/mcp.md`、`cn/cli/mcp-apps.md`、`cn/cli/plugins.md`、`cn/cli/plugins-reference.md`、`cn/cli/plugin-marketplaces.md`、`cn/cli/codebuddy-dir.md`、`cn/cli/tools-reference.md`

**线上**：
- 文档地图：https://cnb.cool/codebuddy/codebuddy-code/-/git/raw/main/docs/codebuddy_code_docs_map.md
- 仓库文档：https://cnb.cool/codebuddy/codebuddy-code/-/git/raw/main/docs/skills.md （及 plugins.md / slash-commands.md / hooks.md / mcp.md / sub-agents.md）
- Agent Skills 开放标准：https://agentskills.io/ 、https://agentskills.io/specification
- OpenCode Skills：https://opencode.ai/docs/skills/
- Codex skills：Codex 发布说明 "Agent skills in Codex"（CLI + IDE，`$skill-name` 调用）；schema 整理见 https://skillmd.ai/skills/meta-unify-core（Codex SKILL.md schema 段）
