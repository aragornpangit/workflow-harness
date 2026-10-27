# Harness Matrix — 六个 harness 的执行路由与现成生态

> 调研依据见 `references/research/*.md`（2026-10 联网调研，含来源 URL）。生态信息会过时，行动前用链接复核。

## 总表

| Harness | 原生 workflow 引擎 | 本 skill Tier | 脚本落点 | 子代理/角色定义 | 现成编排生态（调研结论） |
|---|---|---|---|---|---|
| claude-code | ✅ 内置 `Workflow` 工具（2026-05 GA） | 1 | `.claude/workflows/`、`~/.claude/workflows/`、plugin `workflows/` | `.claude/agents/*.md` | zircote/workflows-plugin（20 模式库）、obra/superpowers、moismailzai orchestration 插件 |
| codebuddy | ✅ 内置 `Workflow` 工具（v2.105.0+） | 1 | `.codebuddy/workflows/`、`~/.codebuddy/workflows/` | `.codebuddy/agents/*.md` | 与 claude-code 同构，无独立编排插件需求 |
| pi-agent | ⚠️ 靠扩展（DSL 同族） | 1（有扩展）/ 2 | `.pi/workflows/*.js`（扩展的保存位置） | `.pi/agents/*.md` | **milanglacier/pi-dynamic-workflow**（npm 同名）、Michaelliv/pi-dynamic-workflows、QuintinShaw 增强版（★555）、LEUNGUU skill 版 |
| codex | ❌ | 2 | 项目任意目录（建议 `.wf/`） | `~/.codex/agents/*.toml` | omx（tmux 多 agent）、fab（supervisor+worktree）；官方走 SDK/app-server/subagents |
| opencode2 | ❌ | 2 | 项目任意目录（建议 `.wf/`） | `.opencode/agents/*.md`（`mode: subagent`） | @openspoon/subtask2、opencode-conductor、oh-my-opencode、goal-plugin |
| hermes | ❌（delegate_task 是原生多代理，但无脚本引擎） | 2（或 Tier-3 用 delegate_task） | 项目任意目录 | skills + delegate_task | 官方 1393 子代理重构实战范例；无同名 workflow 组件 |

## 各 harness 操作要点

### claude-code（Tier 1）
- 检测：`CLAUDECODE=1` / `~/.claude` / 会话自知。
- 执行：把 workflow 脚本交给内置 `Workflow` 工具（`script` 内联或 `scriptPath`）。触发：用户明说 "用 workflow" / "ultracode" 关键词 / 运行已保存 workflow `/<name>`。
- 保存复用：`/workflows` 选 run 按 `s` 存入项目 `.claude/workflows/`（团队共享）或 `~/.claude/workflows/`。
- 安装本 skill：`cp -r workflow-harness ~/.claude/skills/`；或做成 plugin 的 `skills/` + `workflows/`。
- 降级：无 Workflow 工具的版本（< v2.1.154）走 Tier 2（`claude -p --output-format json --no-session-persistence --permission-mode acceptEdits`）或 Tier 3。注意本机 claude 二进制在 `~/.claude/downloads/` 不在 PATH，用前先补 PATH 或覆写 `command` 绝对路径。
- 现成 package：`claude plugin install dynamic-workflows@dynamic-workflows`（zircote/workflows-plugin，含 20 编排模式参考）；官方 marketplace `claude-plugins-official`。

### codebuddy（Tier 1）
- 检测：`~/.codebuddy` / 会话自知。
- 执行：内置 `Workflow` 工具，参数 `script`（脚本正文）或 `scriptPath`；异步返回 runId，用 TaskOutput 拉结果。约束与 claude-code 同族（确定性沙箱、并发 ≤16、≤1000 代理、禁 Date.now/Math.random/eval/require）。
- 保存复用：`/workflows` 按 `s` 存 `.codebuddy/workflows/`；运行 `/<name>`；内置 `/deep-research`。
- 安装本 skill：`cp -r workflow-harness ~/.codebuddy/skills/`（或项目 `.codebuddy/skills/`）。
- 降级：Tier 2（`codebuddy -p -y --no-session-persistence --output-format json`；headless 带工具调用必须 `-y`，否则被权限拦截）。

### pi-agent（Tier 1 优先）
- 检测：`~/.pi` / `pi --version` / 会话自知。
- 首选装扩展：`pi install npm:pi-dynamic-workflow`（milanglacier 版，/workflow 命令、journal 续跑、后台运行、预算控制）或 `pi install npm:@quintinshaw/pi-dynamic-workflows`（增强版：模型路由、worktree、/workflows TUI）。装后 ``/reload``。
- 执行：扩展注册的 workflow 工具吃同一 DSL（meta/agent/parallel/pipeline/phase/log/args/budget），脚本存 `.pi/workflows/`。
- 无扩展时：Tier 2（`pi -p --no-session` 适配）。
- 安装本 skill：`cp -r workflow-harness ~/.pi/skills/` 或做成 Pi package。

### codex（Tier 2）
- 检测：`CODEX_HOME` / `~/.codex` / `codex --version`。
- 执行：`node <skill>/scripts/wf-runner.mjs wf.mjs --agents agents.json`，preset `codex` = `codex exec --ephemeral --skip-git-repo-check -s workspace-write --json -`（stdin 送 prompt；JSONL 事件流，最终文本取最后一条 `item.completed` 且 `item.type=="agent_message"` 的 `item.text`）。
- 沙箱/权限：子代理继承父会话权限，写操作用 `-s workspace-write`；只读调研改 `-s read-only`。
- 安装本 skill：`cp -r workflow-harness ~/.codex/skills/`（或 `~/.agents/skills/`，agentskills.io 标准路径）。显式调用 `$workflow-harness`。
- 现成 package：omx、fab（多实例 supervisor）——需要 tmux/多实例而非单脚本 fan-out 时用它们；SDK（`@openai/codex-sdk`）可程序化编排 plan→impl→review 链。

### opencode2（Tier 2）
- 检测：`~/.config/opencode` / `opencode --version`。
- 执行：Tier 2，preset `opencode` = `opencode run --format json --auto`（v2.1.3 实测；输出是 JSONL 事件流，最终文本聚合 `type:"text"` 事件的 `part.text`；无 no-session flag，每次 run 落 session）。
- 备选：opencode 原生 subagent（`.opencode/agents/*.md` + `mode: subagent`）+ Tier 3 会话内编排；或社区插件 @openspoon/subtask2（命令编排+流控）、opencode-conductor（Spec→Plan→Implement）。
- 安装本 skill：`cp -r workflow-harness ~/.config/opencode/skills/`（或 `.opencode/skills/`；也兼容 `.claude/skills`、`.agents/skills` 发现路径）。

### hermes（Tier 2 或 Tier 3）
- 检测：`~/.hermes` / `hermes --version`。
- 执行：Tier 2，preset `hermes` = `hermes chat --oneshot -Q --query-file -`（官方文档核对：`chat -q` 在 TTY 下不退出，必须 `--oneshot`；JSON 走 `--format stream-json` 取 `type=="result"` 的 `.text`）。本机未安装 hermes，装后先 `hermes --help` 复核。
- Tier 3 备选：hermes 原生 `delegate_task` 子代理（默认并发 3）+ `/goal` 常驻目标 + `-w` git worktree 隔离编辑——官方 1393 子代理重构即此路线（切非重叠任务组、worktree 编辑、脚本化校验）。
- 安装本 skill：hermes skills 兼容 agentskills.io，`cp -r workflow-harness ~/.hermes/skills/`。

## 可移植性守则（写 skill/脚本时遵守）

1. SKILL.md 只用标准 frontmatter 子集：`name`（小写连字符 = 目录名）、`description`（≤500 字符，取各家最小上限）。`allowed-tools`/`context`/`hooks` 等私有字段在部分 harness 会被忽略——依赖它们的能力必须有纯指令降级路径。
2. workflow 脚本严格按 workflow-spec.md 的契约写（以 pi 系签名为基准；claude-code / codebuddy 原生引擎按该文的兼容矩阵改写），别用 `workflow()` 嵌套、`isolation`、`budget` 之外的引擎私有扩展。
3. 占位符（`${CLAUDE_SKILL_DIR}` 等）是私有实现——需要路径时让 agent 从 skill 实际安装位置推导。
4. CLI flag 会漂移：preset 命令是起点不是契约。六个 preset 已于 2026-10-27 对本机真实 CLI 逐条核对（证据：`references/research/preset-flags/*.md`），CLI 升级后重跑核对并在 agents.json 覆写。
