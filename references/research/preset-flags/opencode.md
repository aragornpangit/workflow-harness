# opencode — wf-runner CLI 适配核对

- 目标 CLI：opencode（sst/opencode）
- 可执行文件：`~/.opencode/bin/opencode`（`command -v opencode` 命中）
- 版本：`opencode v2.1.3`（`opencode --version`）
- 核对方式：只读 `opencode --help` / `opencode run --help` + v2.1.3 tag 源码（packages/cli/src/commands/commands.ts、src/run/run.ts、src/run/noninteractive.ts），未发真实 prompt、未消耗 token
- 预期用法：`opencode run --format json` —— **基本吻合**（flag 存在且名字一致），但输出形态需注意（见 b）

## a) 非交互/headless 单次执行

命令形式：`opencode run [flags] [<message...>]`

- `opencode run --help` 证据行：
  - `USAGE
  opencode run [flags] [<message...>]`
  - `message... string    Message to send (optional)`
- prompt 来源：**位置参数 + stdin 都支持，二者合并**。源码（v2.1.3 packages/cli/src/run/run.ts）：
  - `const message = mergeInput(formatMessage(input.message), process.stdin.isTTY ? undefined : await readStdin())`
  - `mergeInput`：`return message + "\n" + piped`（位置参数在前、stdin 追加在后；只给其一即可）
  - 两者都空时报错：`if (!message?.trim()) fail("You must provide a message")`
- `--` 之后的参数也并入 message（handlers/run.ts：`process.argv.indexOf("--", 2)`）
- 附件：`--file, -f string   File to attach to the message`（≤100 个，单文件 ≤10 MiB）

## b) JSON 结构化输出

flag：`--format choice   Output format (choices: default, json)`

- 输出形态：**JSONL 事件流（每行一个 JSON 对象），不是单个 JSON，也不是单个 result 对象**。docs 原文："Format: default (formatted) or json (raw JSON events)"
- 每行结构（源码 noninteractive.ts emit）：`JSON.stringify({ type, timestamp, sessionID, ...data })` 一行一条
- 事件 `type` 取值（emit 调用点汇总）：`text`、`reasoning`（仅加 `--thinking` 时）、`step_start`、`tool_use`、`step_finish`、`error`
- **最终 agent 文本**：取 `type:"text"` 事件的 `part.text`。每个 text part 在 `session.text.ended` 时一次性发出完整文本（非增量），结构：
  `{"type":"text","timestamp":T,"sessionID":"...","part":{"id":"prt_...","sessionID":"...","messageID":"msg_...","type":"text","text":"<完整段文本>","time":{"start":...,"end":...}}}`
  → 按 `part.messageID` 归组、按出现顺序拼接 `part.text` 即最终回复（一轮可能多段 text）
- 错误事件：`{"type":"error","timestamp":T,"sessionID":"...","error":{"type":"unknown","message":"..."}}`；出错 exit code 1，SIGINT 退出 130
- `tool_use` 事件的 `part` 含 `tool`/`state.input`/`state.output`/`state.status` 等，可用于工作流判读

## c) 无会话 / 写权限 / sandbox

- **无 `--no-session` / `--ephemeral` 类 flag**（help 中 session 相关仅 `--continue/-c`、`--session/-s`、`--fork`、`--title`）
- 会话行为：每次 `run` 默认**新建并持久化 session**；JSON 事件每行带 `sessionID` 字段可供 wf-runner 捕获
  - 可控方案：`--session <id>`（"Session ID to continue, or to create if it does not exist"）指定自定义 ID，跑完 `opencode session delete <id>` 清理
- 写权限/审批控制（help 证据行）：
  - `--auto    Auto-approve permissions that are not explicitly denied`
  - 隐藏 flag（help 不显示，源码 commands.ts PermissionParams）：`--yolo`、`--dangerously-skip-permissions`，与 `--auto` 等价（handlers/run.ts：`input.auto || input.yolo || input.dangerouslySkipPermissions`）
  - **无 codex 式 `-s workspace-write` / sandbox 级别 flag**；权限粒度走配置/agent（docs：env `OPENCODE_PERMISSION` = 内联 json 权限配置；`opencode agent create --permissions` 可按工具粒度放行）
- 其他相关：`--standalone`（私有 server，不走后台 service）、`--agent string`（选 agent）

## d) 指定模型

- `--model, -m string    Model to use in the format provider/model#variant`（help 原文；`#variant` 为可选推理强度后缀）
- 可选：`--agent string   Agent to use`；模型枚举用 `opencode models`

## 推荐命令

- text 模式（默认格式，非 TTY 下最终文本逐段纯文本输出，无 ANSI；但工具行也会混入 stdout，需容忍）：
  ```sh
  opencode run --auto --model provider/model "PROMPT"
  # 或 stdin：printf '%s' "$PROMPT" | opencode run --auto --model provider/model
  ```
- JSON 模式（JSONL 事件流）：
  ```sh
  opencode run --format json --auto --model provider/model "PROMPT"
  # 或 stdin：printf '%s' "$PROMPT" | opencode run --format json --auto --model provider/model
  ```
- 需要会话可回收时追加 `--session <预生成ID>`，结束后 `opencode session delete <ID>`

## 与预期用法的差异点

1. `opencode run --format json` flag 名一致，但**输出是 JSONL 事件流**（type: text/step_start/tool_use/step_finish/error），不是整段 JSON；最终文本要从 `type:"text"` 事件的 `part.text` 聚合
2. prompt 位置参数与 stdin 均可（stdin 会被合并追加到位置参数之后），比"只支持位置参数"的预期更宽松
3. **无无会话 flag**：session 必然持久化；用 `--session <id>` + `opencode session delete` 兜底
4. **无 sandbox/写权限分级 flag**：只有 `--auto`（+隐藏 `--yolo`/`--dangerously-skip-permissions`）
5. 模型 flag 为 `-m/--model provider/model#variant`
