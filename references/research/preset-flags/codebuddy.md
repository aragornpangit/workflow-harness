# preset-flags: codebuddy（腾讯 CodeBuddy Code）

- 核对日期：2026-10-27
- 可执行文件：`/home/<user>/.local/bin/codebuddy`（`command -v codebuddy`；别名 `cbc`）
- 版本：`codebuddy --version` → `2.177.0`
- 证据来源：`codebuddy --help`（2.177.0 实测）+ 内置文档 headless.md / sdk-typescript.md（`<node_modules>/@tencent-ai/codebuddy-code/dist/web-ui/docs/`）

## 与预期用法的比对

预期 `codebuddy -p --output-format json` —— **完全正确**，与帮助一致：
```
-p, --print        Print response and exit (useful for pipes) (default: false)
--output-format <format>   Output format (only works with --print): "text" (default), "json" (single
                   result), or "stream-json" (realtime streaming) (default: "text")
```
差异点：仅提醒 headless 下带工具调用时**必须加 `-y`**（见 c），否则文件/命令操作会被权限拦截。

## a) 非交互/headless 单次执行

- 命令形式：`codebuddy -p [prompt]`。证据（--help）：
  `Usage: codebuddy|cbc [options] [command] [prompt]` / `prompt   Your prompt`
- prompt 来源：**位置参数或 stdin 都支持**（文档 headless.md「输入格式」）：
  `codebuddy -p "解释这段代码"` 与 `echo "解释这段代码" | codebuddy -p`
  管道场景（如 `gh pr diff | codebuddy -p`）用 stdin 更顺。
- 一次执行后打印结果并退出；可配 `--max-turns <number>`（`Limit the number of agentic turns`）兜底。

## b) JSON 结构化输出

- flag：`--output-format json`（单条结果 JSON 对象，一次性）或 `--output-format stream-json`（JSONL 事件流）。
- `json` 模式输出为**单个 JSON 对象**（非 JSONL），关键字段（headless.md 用 jq 演示）：
  - `result`：**最终 agent 文本**（`jq -r '.result'`）
  - `session_id`、`total_cost_usd`、`duration_ms`、`num_turns`
  - `structured_output`：仅在配 `--json-schema '<schema>'` 时出现（结构化输出校验）
  - 文档示例：`codebuddy -p "总结这个项目" --output-format json | jq -r '.result'`
- `stream-json` 形态（headless.md）：以 `init` 系统消息开始 → user/assistant 消息列表 → **最终 `result` 系统消息**（每条一行 JSON）。result 消息字段（sdk-typescript.md 类型）：
  `type:"result"`, `subtype:"success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd"`, `result:string`, `session_id`, `total_cost_usd`, `duration_ms`, `num_turns`。
- 提示：result 消息的 `subtype` 可判成败；`error_*` 表示执行中出错/超轮数/超预算。

## c) 无会话 / 写权限 / sandbox

- **不留会话**：`--no-session-persistence`（--help）：`Disable session persistence - sessions stay in memory and are not saved to disk`。（没有 `--no-session`/`--ephemeral`，这是最接近的；需要可控 id 可配 `--session-id <uuid>`，多轮用 `--resume <id>`。）
- **写权限/授权**（headless 必读）：
  - `-y, --dangerously-skip-permissions`：`Bypass permission prompts (HIGH/CRITICAL still ask). Isolated-sandbox full pass: CODEBUDDY_IS_SANDBOX=1 (process env only; high-risk).`
    文档明确：**`-p` 非交互模式必须加 `-y` 才能执行需授权操作（文件读写/命令执行/网络）**，否则被阻止；HIGH/CRITICAL 仍会问，隔离沙箱内真不问用 `CODEBUDDY_IS_SANDBOX=1`（高危，仅进程环境）。
  - `--permission-mode <mode>`：`acceptEdits, bypassPermissions, default, plan, dontAsk, auto`（只影响本次进程，不写 settings）。
  - `--allowedTools <tools...>` / `--disallowedTools <tools...>`（如 `"Bash(git:*) Edit"`）、`--tools <value>`（限用内建工具，`""` 全禁）。
  - `--add-dir <directories...>`：放开额外目录的工具访问（类比 sandbox 的 workspace-write 范围控制）。
- 真沙箱（可选）：`--sandbox container`（Docker/Podman）或 E2B URL；`--sandbox-kill` 退出即销毁。

## d) 模型指定

- `--model <model>`（--help 实测当前支持：hy3, deepseek-v4.1-flash, step-5-preview, minimax-m3.1-flash, mimo-v2.6-pro, glm-5.3-flash, minimax-m3, minimax-m2.7, custom-local:*）
- 另有 `--fallback-model <model>`（仅 `--print`）、`--effort <level>`（minimal…max）。

## 推荐命令（wf-runner preset）

**text 模式：**
```bash
codebuddy -p -y --no-session-persistence "<prompt>"   # 或 echo "<prompt>" | codebuddy -p -y --no-session-persistence
```
**JSON 模式：**
```bash
codebuddy -p -y --no-session-persistence --output-format json "<prompt>" | jq -r '.result'
# 需要结构化返回时加：--json-schema '<schema>'，取 .structured_output
```
可选追加：`--model <model>`（选模型）、`--max-turns <n>`（限轮数）、`--allowedTools "Bash,Read,Edit,Write"`（精确授权，替代全放 `-y` 的更保守做法：`--permission-mode acceptEdits` + `--allowedTools`）。
