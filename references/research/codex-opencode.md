# 调研报告：OpenAI Codex CLI 与 opencode 的扩展机制（2025-2026）

> 调研日期：2026-10-26。来源：官方文档（developers.openai.com / learn.chatgpt.com、opencode.ai）与 GitHub。
> 注：OpenAI 开发者文档近期迁移到 learn.chatgpt.com 域名，developers.openai.com/* 会 302 到 learn.chatgpt.com/docs/*；文档页追加 ".md" 得 Markdown 版，总索引 /llms.txt（Codex 子索引 https://learn.chatgpt.com/docs/llms.txt ，含 codex-manual.md 机读手册）。

---

## A. OpenAI Codex CLI（codex）

### A1. AGENTS.md（项目指令）
- 开放标准：https://agents.md/ （"给 agent 的 README"，60k+ 开源项目采用，多 agent 通用）。
- Codex 官方文档：Custom instructions with AGENTS.md — https://learn.chatgpt.com/docs/agent-configuration/agents-md （入口 https://developers.openai.com/codex/agent-configuration/agents-md ）。
- 加载路径（越靠近工作目录优先级越高）：
  - ~/.codex/AGENTS.md — 全局个人偏好
  - <repo-root>/AGENTS.md — 团队规则（入库）
  - <subdir>/AGENTS.md — 目录级指令
- 用法：放构建/测试命令、评审期望、仓库约定、目录路由指引；配合 pre-commit/linter 强制执行。
- 五层定制综述（AGENTS.md、Memories、Skills、MCP、Subagents）：https://learn.chatgpt.com/docs/customization/overview

### A2. Custom prompts / 斜杠命令（注意：已弃用）
- 官方文档：Custom Prompts — https://learn.chatgpt.com/docs/custom-prompts — 明确标注 "Deprecated. Use skills for reusable prompts"（2026 现状）。
- 机制（仍可用）：mkdir -p ~/.codex/prompts，放顶层 Markdown 文件（子目录不扫描）；frontmatter 支持 description:、argument-hint:；占位符 $1..$9、$ARGUMENTS、命名参数 KEY=value、$$ 转义。调用 /prompts:<name>。只在本地 ~/.codex，不随仓库共享。
- 内置斜杠命令参考：https://learn.chatgpt.com/docs/developer-commands （/skills、/subagents、/plugins、/permissions 等）；CLI 界面定制：https://learn.chatgpt.com/docs/cli-customization

### A3. Profiles（配置档）
- 官方文档：Advanced Configuration — https://learn.chatgpt.com/docs/config-file/config-advanced
- 机制：codex --profile <name> 先加载 ~/.codex/config.toml，再叠加 ~/.codex/<name>.config.toml（顶层 TOML 键，不要写 [profiles.X]）。优先级：内置默认 < 用户 config < profile 覆盖层 < 项目 .codex/config.toml（仓库需 trust）< CLI flags / -c。
- v0.134.0 破坏性变更：旧的 [profiles.X] 内联表与 profile = "" 选择器已移除，迁移为独立 <name>.config.toml 文件。
- 项目级配置 .codex/config.toml 自动加载（需在用户配置 [projects."<path>"] trust_level = "trusted"，或首次信任提示）；provider/auth/otel 等键不允许在项目层设置。
- 配置参考：https://learn.chatgpt.com/docs/config-file/config-reference （config.toml 与 requirements.toml 全量键）；样例 /docs/config-file/config-sample；环境变量 /docs/config-file/environment-variables。

### A4. MCP
- 配置位置：~/.codex/config.toml 的 [mcp_servers.<id>]（TOML，不同于 Claude Desktop/Cursor 的 JSON）。
  - stdio 本地：command / args / [mcp_servers.x.env]；远程 HTTP：url、auth = "oauth" 或 "chatgpt"、bearer_token_env_var。
  - 控制键：enabled、required、startup_timeout_sec（默认 10）、tool_timeout_sec（60）、enabled_tools / disabled_tools、default_tools_approval_mode = "auto" | "prompt" | "writes" | "approve"。
- CLI：codex mcp add <name> -- <cmd...>、codex mcp list、codex mcp login（OAuth）。
- 官方 MCP 文档：https://learn.chatgpt.com/docs/extend/mcp
- 重要：codex mcp-server（把 Codex 暴露为 MCP server）已移除，官方迁移到 Codex app server（https://learn.chatgpt.com/docs/app-server ，app-server 协议嵌入 Codex）。

### A5. Skills（官方现推的扩展单元）
- 官方文档：Build skills — https://learn.chatgpt.com/docs/build-skills （基于开放标准 https://agentskills.io ）。
- 目录结构：

    my-skill/
    ├── SKILL.md            # 必需：YAML frontmatter(name, description) + Markdown 指令
    ├── scripts/            # 可选：可执行脚本
    ├── references/         # 可选：按需阅读的文档
    ├── assets/             # 可选：模板/资源
    └── agents/openai.yaml  # 可选：UI 外观、policy(allow_implicit_invocation)、dependencies.tools(MCP 依赖声明)

- 加载路径：REPO 层 .agents/skills（$CWD、父目录、仓库根）、USER 层 ~/.agents/skills、ADMIN 层 /etc/codex/skills、SYSTEM 捆绑。
- 调用：显式 /skills 或 $skill-name；隐式按 description 匹配。渐进披露：初始只注入 name/description（上限为上下文 2%，可配 skills.max_context_tokens ≤ 10000 tokens）。
- 禁用：~/.codex/config.toml 里 [[skills.config]] path = ".../SKILL.md" enabled = false。
- 内置 $skill-creator / $skill-installer（可从其他仓库安装技能）。

### A6. Plugins（分发机制）
- 官方文档：Plugins — https://learn.chatgpt.com/docs/plugins
- 概念：skills 是创作格式，plugins 是分发单元；一个 plugin 可捆绑 skills、MCP servers、browser extensions、hooks（生命周期钩子，跑在 Codex 运行时）。ChatGPT 与 Codex 共用一个通用插件目录。
- Codex CLI 通过 /plugins 浏览安装（IDE 扩展暂不支持 plugins）。Hooks 文件位置：~/.codex/hooks.json、~/.codex/config.toml 的 [[hooks.PreToolUse]] 等（matcher + type = command + command + timeout），项目层 hooks 需仓库 trusted。
- 构建插件：https://learn.chatgpt.com/docs/build-plugins ；插件提交：https://developers.openai.com/plugins/deploy/submission

### A7. Subagents / 多 Agent 编排
- 官方文档：Subagents — https://learn.chatgpt.com/docs/agent-configuration/subagents
  - 内置 agent：default、worker、explorer；自定义 agent = 每 agent 一个独立 TOML 文件，放 ~/.codex/agents/（个人）或 .codex/agents/（项目）。
  - 必填字段：name、description、developer_instructions；可选 model、model_reasoning_effort、features.shell_tool 等能力裁剪键。自定义 agent 继承父会话的权限/沙箱/MCP，不能覆盖。
  - CLI：提示词触发并行 subagent；/subagents 查看/切换线程。编排（spawn/路由/等待/回收）由 Codex 自动处理。
- 编程接口：Codex SDK — https://learn.chatgpt.com/docs/codex-sdk
  - npm install @openai/codex-sdk（TS）/ pip install openai-codex（Python）；codex.startThread() / thread.run() / resumeThread() 可编排 plan→impl→review 链；Python 支持 per-turn sandbox（Sandbox.read_only 等）做评审/验证工作流。
- 现成 workflow / multi-agent 编排 package（社区，非官方）：
  - omx (oh-my-codex) — https://github.com/akillness/jeo-skills （介绍 https://claudeskills.info/skills/akillness/jeo-skills/omx ）：30+ agent 角色、35+ workflow skills、tmux team 并行运行时（$plan、$team、$ralph、$ralplan），npm i -g oh-my-codex && omx setup。
  - fab（Go，tessro/fab）：多 Claude Code/Codex 实例 supervisor，worktree 池、任务自动派发（tk / GitHub Issues / Linear）、TUI 监控 — https://github.com/tessro/fab
  - "Codex 多 Agent 软件工厂" 资料包（Supervisor + 多角色 worktree 并行 + 质量门禁 + n8n）：https://aistacknav.com/?p=13451
  - openai/codex-action@v1（GitHub Actions）用于 CI 内 Codex 评审/任务。
  - 官方方向：SDK + app server + 原生 subagents；第三方 "Codex 当 MCP server 被编排" 的路线因 codex mcp-server 移除而需改用 app server。

---

## B. opencode（sst/opencode，含 v2）

> 官方站 https://opencode.ai ；GitHub https://github.com/sst/opencode （现由 anomalyco 维护）。v1 文档 /docs/*，v2 文档 /v2/docs/*。v1/v2 同名 opencode 命令不能并存。v2 安装：curl -fsSL https://opencode.ai/v2/install | bash；v1：https://opencode.ai/install 或 npm i -g opencode-ai。

### B1. Agents（一等支持）
- v1：https://opencode.ai/docs/agents ；v2：https://opencode.ai/v2/docs/agents
- 两类：primary agents（主对话，Tab 切换）与 subagents（主 agent 通过 subagent 工具派生，或 @mention 手动调用）。内置：Build / Plan（primary）、General / Explore / Scout（subagent）。
- 定义方式：
  - Markdown 文件：~/.config/opencode/agents/<name>.md（全局）、.opencode/agents/<name>.md（项目，嵌套路径成为 ID，如 team/reviewer）；frontmatter（description、mode: primary|subagent|all、model、permissions）+ 正文即 system prompt。
  - JSONC：opencode.json(c) 的 agents 键；default_agent 选默认。
- 权限按 action / resource / effect 细配（edit、shell、subagent 等）；subagent 权限控制父 agent 可派生哪些子 agent（如只允许 reviewer）。
- 子 agent 在独立子会话（前台/后台）跑，fresh context。

### B2. Commands（自定义斜杠命令）
- v1：https://opencode.ai/docs/commands （v2 同类）。
- Markdown 文件：.opencode/commands/<name>.md 或 ~/.config/opencode/commands/<name>.md；frontmatter 支持 description、agent、model；正文为模板。
- 占位符：$ARGUMENTS、$1..；shell 注入语法：感叹号加反引号包裹的命令（输出并入 prompt）。
- 也可在 opencode.json 的 command 键中定义（template / description / agent / model）。

### B3. Plugins（JS/TS 插件 API）
- v1：https://opencode.ai/docs/plugins ；v2：https://opencode.ai/v2/docs/plugins
- 加载：
  - 本地文件/目录：.opencode/plugins/（项目）、~/.config/opencode/plugins/（全局），自动加载 .ts/.js 或插件包目录（v2）。
  - npm 包：opencode.json 的 plugin（v1）/ plugins（v2）数组；v2 支持版本钉选、Git 包（github:、git+ssh://、::path: 子目录）、本地路径、带 options 的对象形式；opencode plugin add / list / check / update / remove 管理（v2）。npm 插件用 Bun 自动安装，缓存 ~/.cache/opencode/node_modules/；本地插件依赖写 .opencode/package.json（启动时 bun install）。
- 插件形态：导出 Plugin 函数（类型来自 @opencode-ai/plugin），ctx 含 project、client（SDK client）、$（Bun shell）、directory、worktree；返回 hooks 对象，如 tool.execute.before（可改写工具参数）、各类 event 钩子。
- v2 管理增强：plugins 数组按优先级叠加（~/.config/opencode/opencode.jsonc < 项目 < .opencode/），"-id" 前缀禁用、"*" / ".*" 通配；CLI 端专属插件放 cli.json；配置目录变更热重载。
- 生态列表：https://opencode.ai/docs/ecosystem/

### B4. MCP
- v2 文档：https://opencode.ai/v2/docs/mcp-servers
- CLI：opencode mcp add <name> --url <url>（远程，默认 OAuth，TUI 里 /mcps 登录）、opencode mcp add <name> -- <cmd>（本地 stdio）、opencode mcp list；加 --global 全局生效。
- 配置：opencode.jsonc → mcp.servers.<name>（v2；v1 是 mcp 下直接放名字）：type: "local" | "remote"、command 数组、cwd、environment（支持 {env:X} 引用环境变量）、url、disabled 等。项目配置高优先级会整对象替换同名 server。

### B5. Skills
- v1：https://opencode.ai/docs/skills ；v2：https://opencode.ai/v2/docs/skills
- 格式：.opencode/skills/<skill-id>/SKILL.md（YAML frontmatter：name、description、metadata.opencode/autoinvoke）；可带 scripts/、references/。v2 也接受 source 根下单文件形式（如 skills/review.md）。
- 发现路径：.opencode/skills、~/.config/opencode/skills，加 Claude 兼容 .claude/skills、~/.claude/skills，加 agent 兼容 .agents/skills、~/.agents/skills（从 cwd 向上走到项目根逐级发现）。
- v2 扩展源：skills 数组支持本地目录、~/ 路径、绝对路径、HTTP catalog（base URL + index.json（skills[].name / version / files），version 递增刷新缓存）。
- 通过 skill 工具按需加载（渐进披露）；disable-model-invocation: true 可只允许显式调用。

### B6. Workflow / orchestration 现成插件（官方生态页收录）
- @openspoon/subtask2 — "Extend opencode /commands into a powerful orchestration system with granular flow control"（把命令扩展成带细粒度流控的编排系统）：https://github.com/spoons-and-mirrors/subtask2
- opencode-conductor — "Protocol-Driven Workflow: Context → Spec → Plan → Implement 生命周期自动化"：https://github.com/derekbar90/opencode-conductor
- oh-my-opencode — background agents、预置 LSP/AST/MCP 工具、curated agents、Claude Code 兼容：https://github.com/code-yeongyu/oh-my-opencode
- opencode-goal-plugin — 会话级 /goal 工作流，目标常驻上下文、自动续跑到完成：https://github.com/willytop8/OpenCode-goal-plugin
- micode — Brainstorm → Plan → Implement 结构化工作流 + 会话连续性：https://github.com/vtemian/micode
- opencode-scheduler — cron 语法调度定时任务（launchd / systemd）：https://github.com/different-ai/opencode-scheduler
- 其他相关：opencode-daytona（隔离沙箱跑会话）、opencode-devcontainers（多分支隔离）；ayush-opencode（注入 4 个 subagent + orchestration prompt，配置 "plugin": ["ayush-opencode@0.2.2"] 钉版本安装）。
- 原生编排能力：v2 agents 的 mode: subagent + subagent 权限（可白名单特定子 agent）+ 后台子会话 + @mention；插件可通过 SDK client 注入编排指令。没有官方 "dynamic workflow engine"，编排靠 subagent 工具 + 社区插件。

---

## C. 对比速览

| 维度 | Codex CLI | opencode |
|---|---|---|
| 项目指令 | AGENTS.md（agents.md 开放标准；~/.codex / repo / 子目录） | 无专文件，靠 agents / commands / skills；兼容 .claude、.agents 目录 |
| 斜杠命令 | custom prompts ~/.codex/prompts/*.md → /prompts:name（已弃用，官方推 skills） | commands .opencode/commands/*.md + JSON command 键（一等支持） |
| 配置档 | profiles：~/.codex/<name>.config.toml + --profile；项目 .codex/config.toml | 多层 opencode.json(c) 叠加（全局 / 项目 / .opencode） |
| MCP | config.toml [mcp_servers.*] + codex mcp add/list/login | mcp.servers.* + opencode mcp add/list、/mcps OAuth |
| Skills | SKILL.md（.agents/skills、~/.agents/skills、/etc/codex/skills）+ agents/openai.yaml | SKILL.md（.opencode/skills + .claude / .agents 兼容）+ HTTP catalog（v2） |
| Plugins | 官方插件目录（ChatGPT 共用），含 skills/MCP/hooks/browser-ext；CLI /plugins | JS/TS plugin API（hooks 如 tool.execute.before），npm/Git/本地，opencode plugin add |
| Subagent/编排 | 原生 subagent 工作流 + 自定义 agent（TOML ~/.codex/agents/）+ SDK/app-server；社区 omx、fab | 原生 subagent（General/Explore/Scout）+ Markdown/JSONC agents + subagent 权限；社区 subtask2、conductor、oh-my-opencode |
| 现成 workflow 包 | omx（tmux 多 agent）、fab、"多 Agent 软件工厂"、codex-action | @openspoon/subtask2、opencode-conductor、micode、goal-plugin |
