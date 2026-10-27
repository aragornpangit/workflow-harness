# codex (OpenAI Codex CLI) — preset flags 核对

- 核对日期: 2026-10-27
- 可执行文件: /home/<user>/.nvm/versions/node/v24.16.0/bin/codex（npm 包 @openai/codex，原生二进制在 @openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex）
- 版本: codex-cli 0.163.0（codex --version）
- 核对方式: 仅读 codex --help / codex exec --help + 二进制内 serde 事件名字符串 + 公开文档佐证；未发真实 prompt、未消耗 token

## a) 非交互/headless 单次执行

命令形式: codex exec [OPTIONS] [PROMPT]（别名 codex e）。

证据（codex exec --help）:

    Run Codex non-interactively
    Usage: codex exec [OPTIONS] [PROMPT]
    Arguments:
      [PROMPT]
              Initial instructions for the agent. If not provided as an argument (or if "-" is used), instructions are read from
              stdin. If stdin is piped and a prompt is also provided, stdin is appended as a "<stdin>" block

结论: prompt 走 stdin 用 "-"（或省略位置参数）即可；位置参数与 stdin 两种都支持，可混用（stdin 会追加为 <stdin> block）。

## b) JSON 结构化输出

flag: --json（在 codex exec 上；codex 顶层无此 flag）。

证据（codex exec --help）:

      --json
          Print events to stdout as JSONL

输出形态: JSONL 事件流（每行一个 JSON 对象，写 stdout）。顶层 type 取值（二进制 serde 字符串证据 + 公开文档一致）:
thread.started / turn.started / turn.completed / turn.failed / item.started / item.updated / item.completed / error

item 自身 type 取值: agent_message / reasoning / command_execution / file_change / mcp_tool_call / collab_tool_call / web_search / todo_list / error

最终 agent 文本所在字段: item.completed 事件中 item.type == "agent_message" 的 item.text。

    {"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"<最终回复>"}}

取最终文本: 取最后一条满足 .type=="item.completed" and .item.type=="agent_message" 的 .item.text。

其他关键字段:

- {"type":"thread.started","thread_id":"..."} — 会话 id（--ephemeral 下也不落盘）
- {"type":"turn.completed","usage":{"input_tokens","cached_input_tokens","cache_write_input_tokens","output_tokens","reasoning_output_tokens"}}
- command_execution item: command / aggregated_output / exit_code（declined 时 exit_code 为 null）/ status

另有可选兜底: -o, --output-last-message <FILE> —— "Specifies file where the last message from the agent should be written"，把最终 agent 文本直接写文件，不依赖 JSONL 解析。

## c) 无会话/不留 session 与 sandbox 控制

证据（codex exec --help）:

      --ephemeral
          Run without persisting session files to disk
      --skip-git-repo-check
          Allow running Codex outside a Git repository
  -s, --sandbox <SANDBOX_MODE>
          Select the sandbox policy to use when executing model-generated shell commands
          [possible values: read-only, workspace-write, danger-full-access]

- 不留 session: --ephemeral ✓
- 跳过 git 仓库检查: --skip-git-repo-check ✓
- 写权限: -s workspace-write ✓（也可 read-only / danger-full-access）
- 工作目录: -C, --cd <DIR>（"Tell the agent to use the specified directory as its working root"）
- 相关: --ignore-user-config（不加载 $CODEX_HOME/config.toml）、--ignore-rules（不加载 execpolicy .rules）可做隔离；--approve-for-me 可让 workspace-write 下的审批走自动复核。注意 codex exec 无 -a/--ask-for-approval（那是交互模式 flag）。

## d) 指定模型

flag: -m, --model <MODEL>（"Model the agent should use"，codex exec 同样支持）。另有 -p, --profile <CONFIG_PROFILE_V2> 套配置档、--oss / --local-provider 走本地 provider。

## 推荐命令

text 模式（最终文本走 stdout）:

    codex exec --ephemeral --skip-git-repo-check -s workspace-write --color never -

（prompt 从 stdin 喂入；--color never 去掉 ANSI 码，人类可读输出直接落 stdout）

JSON 模式（JSONL 事件流走 stdout）:

    codex exec --ephemeral --skip-git-repo-check -s workspace-write --json -

最终文本解析: jq -r 'select(.type=="item.completed" and .item.type=="agent_message") | .item.text' events.jsonl | tail -n 1
可选加 -o last_message.txt 兜底拿最终回复，或加 -m <model> 指定模型。

## 与预期用法的差异

预期用法 codex exec --ephemeral --skip-git-repo-check -s workspace-write -（stdin）与 --json 变体全部成立，零差异：

- codex exec 非交互单跑 ✓；"-" = stdin prompt ✓；--ephemeral ✓；--skip-git-repo-check ✓；-s workspace-write ✓；--json = JSONL 事件流 ✓

补充差异点/建议（非阻塞）:

1. text 模式建议加 --color never（默认 color=auto）。
2. JSON 模式最终文本 = 最后一条 item.completed / agent_message 的 item.text；建议同时用 -o 兜底。
3. 0.163.0 的 item.type 比 0.157.1 公开文档多了 collab_tool_call、error，解析时按 item.type=="agent_message" 白名单取文本即可。
4. codex exec 不支持 -a never；审批控制走 -s + --approve-for-me（自动化环境可选 --dangerously-bypass-approvals-and-sandbox，不推荐）。
