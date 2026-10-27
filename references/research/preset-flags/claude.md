# preset-flags: claude (Anthropic Claude Code CLI)

- 核对日期: 2026-10-27
- 可执行文件: `~/.claude/downloads/claude-2.1.165-linux-x64`（不在 PATH；`command -v claude` 无结果）
  - 版本: `2.1.165 (Claude Code)`（`--version` / `-v`）
  - 备注: `~/.claude/downloads/` 另有未解压的 `claude-2.1.300-linux-x64.zst`
- 预期用法: `claude -p --output-format json` — **核对通过**，flag 均真实存在

## a) 非交互/headless 单次执行

`-p, --print`：Print response and exit (useful for pipes)。

> 证据行（--help）:
> `-p, --print   Print response and exit (useful for pipes). Note: The workspace trust dialog is skipped when Claude is run in non-interactive mode (via -p, or when stdout is not a TTY, e.g. piped or redirected output).`

- prompt 来源：**位置参数或 stdin 均可**。用法行 `Usage: claude [options] [command] [prompt]` + `Arguments: prompt   Your prompt`；stdin 走管道（help 明言 "useful for pipes"）。
- 两种等价形式：
  - `claude -p "PROMPT"`
  - `echo "PROMPT" | claude -p`（stdin；不带位置参数时读 stdin）
- 可选 `--input-format <format>`：`text`（默认）或 `stream-json`（流式输入，仅 --print）。

## b) JSON 结构化输出

`--output-format <format>`（仅 --print）：`text`（默认）、`json`（single result）、`stream-json`（realtime streaming）。

> 证据行（--help）:
> `--output-format <format>   Output format (only works with --print): "text" (default), "json" (single result), or "stream-json" (realtime streaming) (choices: "text", "json", "stream-json")`

- **整段 JSON（单对象）**，不是 JSONL 事件流；事件流用 `stream-json`。
- 最终 agent 文本字段：`result`。
- 结果对象形态（字段名经二进制字符串核验存在: duration_ms / is_error / modelUsage / num_turns / permission_denials / session_id / total_cost_usd）:
  ```json
  {
    "type": "result",
    "subtype": "success",
    "is_error": false,
    "duration_ms": 12345,
    "num_turns": 3,
    "result": "<最终 agent 文本>",
    "session_id": "<uuid>",
    "total_cost_usd": 0.0123,
    "usage": { "...": "token 用量" },
    "modelUsage": { "...": "per-model 用量" },
    "permission_denials": []
  }
  ```
- `--json-schema <schema>` 可对结构化输出做 JSON Schema 校验（可选）。
- stream-json 形态补充 flag：`--include-partial-messages`（增量文本块）、`--include-hook-events`（hook 生命周期事件，仅 stream-json）。

## c) 无会话 / 写权限 / sandbox 控制

- **无会话**: `--no-session-persistence`
  > 证据行: `--no-session-persistence   Disable session persistence - sessions will not be saved to disk and cannot be resumed (only works with --print)`
  - 对应预期中的 --no-session/--ephemeral 语义；仅 --print 生效。
- **写权限/sandbox**（claude 无 codex 式 `-s workspace-write`，用 permission-mode 体系）:
  - `--permission-mode <mode>`：choices `acceptEdits | auto | bypassPermissions | default | dontAsk | plan`
    > 证据行: `--permission-mode <mode>   Permission mode to use for the session (choices: "acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan")`
  - `--dangerously-skip-permissions`：绕过全部权限检查（仅限无网沙箱；另有 `--allow-dangerously-skip-permissions` 只把该选项变为可选而不默认开启）
  - 工具/目录粒度：`--allowedTools, --allowed-tools <tools...>`（如 `"Bash(git *) Edit"`）、`--disallowedTools`、`--tools <tools...>`（`""` 全禁 / `default` 全开 / 列名字）、`--add-dir <directories...>`（追加可写可访问目录）
  - headless 稳妥选择：`--permission-mode acceptEdits`（自动接受编辑但不全免权限）或受控沙箱下 `bypassPermissions`
- 隔离增强（可选）: `--bare`（极简模式，跳过 hooks/插件/CLAUDE.md 自动发现，auth 仅 ANTHROPIC_API_KEY）

## d) 指定模型

- `--model <model>`：别名（`sonnet`/`opus`）或全名（`claude-opus-4-8`）
  > 证据行: `--model <model>   Model for the current session. Provide an alias for the latest model (e.g. 'sonnet' or 'opus') or a model's full name (e.g. 'claude-opus-4-8').`
- `--fallback-model <model>`：逗号分隔候选，过载时自动降级（仅 --print）；`--effort <level>`：low|medium|high|xhigh|max

## 推荐命令（preset）

**text 模式**（位置参数 prompt）:
```bash
claude -p --no-session-persistence --permission-mode acceptEdits --model sonnet "PROMPT"
```
（prompt 亦可走 stdin: `echo "PROMPT" | claude -p --no-session-persistence --permission-mode acceptEdits`）

**JSON 模式**（整段 JSON，agent 文本在 `.result`）:
```bash
claude -p --output-format json --no-session-persistence --permission-mode acceptEdits --model sonnet "PROMPT"
```
解析: `jq -r .result`

## 与预期用法的差异点

- 预期 `claude -p --output-format json` **完全成立**，无需改写。
- 差异/补充: ① prompt 位置参数与 stdin 双支持（预期未指明）；② 无 `--no-session`，实际叫 `--no-session-persistence`；③ 无 `-s workspace-write`，写权限用 `--permission-mode`（acceptEdits/bypassPermissions 等）+ `--allowedTools`/`--add-dir`；④ JSON 为单对象（agent 文本字段 `result`），事件流需改用 `stream-json`。
