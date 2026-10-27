# preset-flags: hermes（NousResearch hermes-agent）

- 核对日期：2026-10-27
- 可执行文件：**NOT_FOUND**（本机未安装）
  - 已搜：PATH、`~/.local/bin`、`~/.cargo/bin`、`~/miniconda3/bin`、npm 全局、pip/pipx/uv tools、`~/go/bin`、`/usr/local/bin`、全盘 `find -name 'hermes*'`（maxdepth 6）——均无
  - 注意：`~/.hermes/` 存在（config.yaml + skills/ 软链，无 venv、无 hermes-agent 代码），只是遗留配置目录；按官方安装布局，代码应位于 `~/.hermes/hermes-agent/`、启动器为 `~/.local/bin/hermes`，均缺失
- 预期用法：`hermes chat -q` —— **基本正确但不完整**，TTY 下不退出（见差异点 1）
- 证据来源：本机无二进制、无法跑 `--help`；flag 证据行引自官方 CLI 参考
  https://hermes-agent.nousresearch.com/docs/reference/cli-commands/（2026-10-27 抓取）与官方安装文档 https://hermes-agent.nousresearch.com/docs/getting-started/installation

## 安装建议（最近似）

```bash
# 推荐（git 安装器；binary → ~/.local/bin/hermes，代码 → ~/.hermes/hermes-agent/，数据 → ~/.hermes/）
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
# 或 PyPI（官方 GitHub docs：pip install hermes-agent；uv pip install hermes-agent 更快）
pip install hermes-agent
# 配置 provider + 核验
hermes setup && hermes --version
```

## a) 非交互/headless 单次执行

```
hermes chat [options]
  -q, --query "..."       Seed the session with a prompt. ... With --oneshot, -Q, or
                          non-TTY stdio it answers and exits.
  --query-file PATH       Read the query from a file (- = stdin). ... Mutually exclusive with -q.
  --oneshot               With -q / --query-file: answer the query and exit ... Implied on
                          non-TTY stdio and by -Q.
  -Q, --quiet             Programmatic mode: suppress banner/spinner/tool previews.
```

- prompt 来源：**位置参数（`-q TEXT`）或文件/stdin（`--query-file PATH`，`-` = stdin）**，二者互斥。stdin 形式：`hermes chat --oneshot -Q --query-file -`
- **TTY 陷阱**：真实 TTY 下 `hermes chat -q "..."` 只把 prompt 提交为交互会话第一轮、会话保持打开不退出——wf-runner 必须显式 `--oneshot`（或 `-Q`、或确保 stdout 非 TTY）
- 更纯的 text 单发入口：`hermes -z "PROMPT"`（scripted one-shot，"single prompt in, final response text out, nothing else on stdout or stderr"；prompt 仅位置参数；退出码 0=完成 / 1=完成但无文本 / 2=失败、partial、超预算、用法错误 / 130=中断——与 `chat -q` 的 0/1/130 语义不同）

## b) JSON 结构化输出

```
  --format stream-json    Emit structured JSONL for a -q / --query invocation. Implies --quiet;
                          cannot be combined with --tui.
```

- 形态：**JSONL 事件流**（每行一个 JSON 对象），不是整段单对象 JSON；诊断与 `session_id:` 行在 **stderr**，只解析 stdout
- 事件 schema（每个事件带 `timestamp` = Unix epoch ms）：

| type | 字段 |
|---|---|
| `system` | `subtype: "init"`, `model`, `session_id` |
| `text` | `text` —— 流式 assistant **增量 delta** |
| `tool_use` | `name`, `input` |
| `tool_result` | `name`, `output`（截断至 5000 字符）, `duration_ms`, `is_error` |
| `result` | `session_id`, `exit_code`, **`text`（最终全文）**, `tokens`{`input`,`output`,`total`,`cache_read`,`cache_write`}, `duration_ms`, `error`?, `replay_gap`? |

- **最终 agent 文本字段：终止 `result` 事件的 `.text`**（`text` 事件是 delta，勿混用；官方："text is a delta; result.text is the final answer"）
- 取值：`jq -r 'select(.type=="result") | .text' run.jsonl`；`result` 记录是完成信号，其 `exit_code` 与进程退出码一致（0 完成 / 1 失败、partial、超预算 / 130 中断；kanban worker 限流时 75=EX_TEMPFAIL）
- 无 claude 式单对象 `--output-format json`；`--format` 文档显式值只有 `stream-json`（不指定即纯文本默认；第三方文档记 `text` 为默认值名）
- 附加：`hermes -z "..." --usage-file out.json` 运行后写 JSON usage 报告（tokens/cost/model/provider/session_id/completed 等，失败也写）

## c) 无会话/写权限与 sandbox

- **无 `--no-session` / `--ephemeral`**。会话总是落盘（`~/.hermes/sessions/*.jsonl` + `~/.hermes/state.db`）。近似方案：
  - 一次性运行默认 source 标签 `oneshot`（picker 隐藏）；`--source tool`：*"third-party integrations that should not appear in user session lists"*——不进用户会话列表
  - 事后清理：`hermes sessions delete ID` / `hermes sessions prune --older-than N days`（另有 sessions list/browse/export/rename）
  - 完全隔离跑：`--ignore-user-config --ignore-rules`（"fully isolated run"，CI 场景官方推荐）、`--safe-mode`（禁一切自定义，需显式 `--model`）；测试式隔离可把 `HERMES_HOME` 指向临时目录
- 审批/写权限：
  ```
    --yolo    Skip approval prompts.
  ```
  （env 等价：`HERMES_YOLO_MODE=1`；config：`approvals.mode: manual|smart|off`，off ≈ --yolo）
- **无 `--workspace-write` 类 flag**；沙箱走 config `terminal.backend`（local/docker/ssh/modal/…）。相关：`--worktree`（隔离 git worktree）、`--checkpoints`（破坏性文件变更前快照）

## d) 指定模型

```
  -m, --model <model>     Override the model for this run.（如 anthropic/claude-sonnet-4.6）
  --provider <provider>   Force a provider（auto/openrouter/nous/anthropic/openai-api/ollama-cloud/... 长列表）
  --base-url <url> / --api-key <key>   --provider custom 的显式 OpenAI 兼容端点
```
`hermes -z` 同样支持 `-m`/`--provider`；env：`HERMES_INFERENCE_MODEL`。

## wf-runner 推荐命令

- **text 模式**：`hermes chat --oneshot -Q -q "PROMPT"`
  - prompt 走 stdin：`hermes chat --oneshot -Q --query-file -`
  - 只要最终文本、纯净 stdout：`hermes -z "PROMPT"`（退出码语义不同，见 a）
- **JSON 模式**：`hermes chat --oneshot -q "PROMPT" --format stream-json`
  - 最终文本：`jq -r 'select(.type=="result") | .text'`；成功判定：`select(.type=="result") | .exit_code == 0`
  - 需工具可见性时可加 `--source tool`（隐藏 session）；带文件写操作时可加 `--yolo`

## 与预期用法（`hermes chat -q`）的差异点

1. **TTY 下不退出**：`hermes chat -q` 在真实 TTY 只是播种交互会话；wf-runner 必须加 `--oneshot`（或 `-Q` / 非 TTY）
2. **JSON 模式是 JSONL 事件流**（`--format stream-json`），非单对象 JSON；最终文本在终止 `result` 事件 `.text`，且 stdout 只有 JSON、诊断在 stderr
3. **无 --no-session**：会话必落盘，用 `--source tool` 隐藏 + `hermes sessions delete/prune` 清理
4. **本机 NOT_FOUND**：需先 `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`（或 `pip install hermes-agent`）再核验
