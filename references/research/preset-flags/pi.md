# pi (earendil-works Pi coding agent) — preset flag 核对

- 可执行文件: `/home/<user>/.nvm/versions/node/v24.16.0/bin/pi`
  (symlink → `~/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`)
- 版本: `1.4.0`（`pi --version`）
- 核对日期: 2026-10-27。证据来自 `pi --help` 与安装包 bundle 源码（`dist/bundle/chunks/chunk-MM3LKT73.js`）。

## a) 非交互 / headless 单次执行

命令形式：`pi -p [options] [--] [messages...]`，prompt 位置参数与 stdin **都支持**。

帮助证据行：
- `--print, -p    Non-interactive mode: process prompt and exit`
- `pi [options] [--] [@files...] [messages...]`
- 示例：`# Non-interactive mode (process and exit) / pi -p "List all .ts files in src/"`
- `--   End option parsing; treat remaining arguments as messages/files`（prompt 以 `-` 开头时用 `pi -p -- "- ..."`）

stdin 证据（bundle 源码）：
- `readPipedStdin(){if(!process.stdin.isTTY)...process.stdin.on("data",...)...resolve(data.trim()||void 0)}`
- `stdinContent=await readPipedStdin(), stdinContent!==void 0&&appMode==="interactive"&&(appMode="print")`
  → 管道输入自动切入 print 模式，不加 `-p` 也能 headless。
- `buildInitialMessage`: `parts=[stdinContent, fileText, parsed.messages[0]].join("")` → stdin 内容与首个位置参数拼接为第一条消息；其余位置参数各作为独立一轮 `session.prompt`。
- 也支持 `@file` 引用（`pi @prompt.md "question"`）。

结论：prompt 从**位置参数或 stdin**均可；stdin 走管道全文读入。

## b) JSON 结构化输出

flag：`--mode <mode>`，取值 `text | json | rpc`。

帮助证据行：
- `--mode <mode>    Output mode: text (default), json, or rpc`

输出形态（源码 `runPrintMode`）：
- **JSONL 事件流（NDJSON，每行一个 JSON 对象）**，不是单个 JSON 文档。
- 首行是 session header：`writeRawStdout(JSON.stringify(header))`，形状
  `{"type":"session","version":N,"id":"<uuid>","timestamp":"...","cwd":"...","parentSession":...}`
  （`--no-session` 时仍在内存生成 header，该行照常输出）。
- 之后每个事件一行：`mode==="json"&&writeRawStdout(JSON.stringify(toJsonEvent(event)))`。
  关键事件类型：
  - `message_start` / `message_update`：`message_update` 行形如
    `{"type":"message_update","usage":{...},"assistantMessageEvent":{...}}`，
    `assistantMessageEvent` 内含 `text_delta`/`toolcall_start` 等增量事件；
  - `turn_end`：`{"type":"turn_end","message":<assistant message>,"toolResults":[...]}`；
  - `agent_end`：`{"type":"agent_end","messages":[...]}`。
- **最终 agent 文本字段**：assistant message 的 `content[]` 中 `type==="text"` 块的 `text` 字段。
  取法：最后一条 `agent_end` → `messages` 中最后一条 `role==="assistant"` → `content[].text`；
  或最后一条 `turn_end` → `message.content[].text`。
- text 模式输出形态（源码）：只打印最后一条 assistant 消息的全部 `type==="text"` 块
  （`writeRawStdout(content.text+"\n")`）；错误/中断/超长写 stderr 且 exitCode=1。
- 另有 `--mode rpc`（JSONL RPC 协议，stdin 收命令），供程序化驱动，一般 wf-runner 用 `json` 即可。

## c) 无会话 / 写权限 / sandbox 控制

- 无会话 flag：`--no-session`（帮助行：`--no-session   Don't save session (ephemeral)`）✅ 与预期用法一致。
  相关：`--session-dir <dir>` 可改存储目录；`-c/-r` 恢复会话（不需要）。
- **没有** `-s workspace-write` 之类的 sandbox/权限 flag。写权限靠工具 allowlist 控制：
  - `--tools, -t <tools>`：逗号 allowlist。帮助示例：
    `# Read-only mode (no file modifications possible)` /
    `pi --tools read,grep,find,ls -p "Review the code in src/"`
  - `--exclude-tools, -xt <tools>`：denylist（含 MCP 工具）；
    `--no-tools/-nt`、`--no-builtin-tools/-nbt` 全关。
- 内建工具名（帮助）：read/bash/powershell/edit/write/grep/find/ls；
  默认启用 read+bash+edit+write（grep/find/ls 默认关）→ **默认可写文件、可执行 bash**。
- 信任/隔离相关：`--approve, -a` / `--no-approve, -na`（信任 project-local 文件）、
  `--no-context-files/-nc`、`--no-mcp`、`--no-extensions/-ne`、`--no-skills/-ns`（可做更封闭的运行）。

## d) 指定模型

- `--model <pattern>`：Model pattern or ID（支持 `provider/id` 与 `:<thinking>` 简写，如 `sonnet:high`）。
- `--provider <name>`：配合 `--model` 搜索（requires --model）。
- `--thinking <level>`：off|minimal|low|medium|high|xhigh|max。
- 帮助示例：`pi --model openai/gpt-4o "Help me refactor this code"`。

## 推荐命令

text 模式（prompt 用 stdin，避免 shell 转义问题）：
```bash
printf '%s' "$PROMPT" | pi -p --no-session --model "<provider/model>" --tools read,grep,find,ls,write,bash,edit
# 或位置参数：
pi -p --no-session --model "<provider/model>" "$PROMPT"
```
（只读场景把 `--tools` 换成 `read,grep,find,ls`；不需要读 AGENTS.md/CLAUDE.md 可加 `-nc`，不需要 MCP 加 `--no-mcp`。）

JSON 模式（JSONL 事件流，取最后 agent_end 的 assistant text）：
```bash
printf '%s' "$PROMPT" | pi -p --no-session --mode json --model "<provider/model>"
# 解析：tail 过滤 type=="agent_end" 的行 → messages[-1].content[] | select(.type=="text") | .text
```

## 与预期用法 `pi -p --no-session` 的差异点

1. 预期用法**完全有效**：`-p` 与 `--no-session` 均原生支持，无差异。
2. JSON 输出需显式加 `--mode json`（默认 text），且是 **JSONL 事件流**而非单 JSON 文档；最终文本在
   `agent_end.messages[].content[].text`（或 `turn_end.message.content[].text`），不在顶层固定字段。
3. prompt 位置参数和 stdin 都支持（stdin 自动强制 print 模式）；prompt 以 `-` 开头要加 `--`。
4. 无 sandbox/permission 等价 flag（codex 的 `-s workspace-write` 之类不存在）；
   写控制用 `--tools` allowlist（如 `read,grep,find,ls` = 只读）。
5. 模型：`--model`（可带 provider 前缀 / `:thinking` 简写），可选 `--provider`。
