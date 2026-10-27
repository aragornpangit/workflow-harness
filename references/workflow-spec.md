# Workflow Spec — 跨 harness 共享 DSL 契约

一份 workflow 脚本 = 一段普通 JavaScript，声明 `export const meta` 后顺序执行，调用固定几个全局原语派生子代理。
该 DSL 以 **pi-dynamic-workflow 系的签名**为基准，也是本 skill Tier-2 运行时（`scripts/wf-runner.mjs`）实现的接口。
它**不是** claude-code / codebuddy 原生引擎的严格公共子集——三家签名有差异，迁移时按下面的兼容矩阵改写：

| 原语 | 本契约（pi 系） | claude-code 原生 | codebuddy 原生 | Tier-2 运行时 |
|---|---|---|---|---|
| `phase` | `phase(title)` | `phase(title)` ✅ | `phase(name, body)` ⚠️ | 两种都接受 |
| `parallel` | `parallel(thunks)` | `parallel(tasks)` ✅ | `parallel(items)` ⚠️ | thunk 与 promise 都接受 |
| `pipeline` | `pipeline(items, ...stages)` | `pipeline(items, fn)` 单 stage | `pipeline(items)` | 多 stage |

⚠️ = 需要改写：codebuddy 的 `phase` 要写成 `phase('X', () => { ... })`（Tier-2 两种写法都吃），`parallel` 要么传 thunk 要么传已启动的 promise。

## 脚本骨架

```js
export const meta = {
  name: 'audit-routes',                        // 必填，小写连字符
  description: 'Audit every route for auth',   // 必填，一行
  phases: [                                    // 可选，须与 phase() 调用同名
    { title: 'Enumerate', detail: 'list routes' },
    { title: 'Audit', detail: 'one agent per route' },
  ],
}

phase('Enumerate')
const found = await agent('List every .ts file under src/routes/. Return JSON {"files":[...]}.', {
  label: 'inventory',
  schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } },
})

phase('Audit')
const audits = await pipeline(found.files, (file) =>
  agent(`Audit ${file} for missing auth checks.`, { label: file, schema: FINDINGS }),
)

return { audits: audits.filter(Boolean) }
```

## 全局原语

| 原语 | 语义 |
|---|---|
| `agent(prompt, opts?)` | 派生一个隔离子代理，返回其最终输出。被中止/出错时返回 `null`（不抛出）——用 `.filter(Boolean)` 过滤 |
| `pipeline(items, ...stages)` | 每个 item 独立流过所有 stage，stage 间无屏障。stage 签名 `(prev, originalItem, index)`。某 item 的 stage 抛错则该 item 变 `null` |
| `parallel(items)` | 并发执行 `() => agent(...)` thunk 数组（也接受已启动的 promise），**屏障**：等全部完成。单项抛错得 `null`，结果保持输入顺序 |
| `phase(title, body?)` | 开始新进度分组；title 建议与 `meta.phases` 对齐（Tier-2 不校验）。传 `body` 函数时同步执行并返回其结果（codebuddy 风格） |
| `log(msg)` | 进度叙述行 |
| `args` | 调用方传入的全局输入（原样字符串或 JSON） |
| `budget` | `{ total, spent(), remaining() }` 令牌预算；`total` 为 `null` 表示未设上限 |
| `workflow(nameOrRef, args?)` | 嵌套调用已保存 workflow（仅原生引擎支持，Tier-2 不支持） |

`agent` 的 `opts`：`label`（进度显示名）、`schema`（JSON Schema，强制结构化输出）、`model`（模型覆盖，默认省略）、`phase`（在 pipeline/parallel 内显式指定分组）、`agentType`/agent 角色（映射 agents.json 角色名）、`cwd`、`timeout`、`isolation: 'worktree'`（原生引擎专属）。

## 硬性约束（各引擎一致，违反即失去 resume 缓存）

- `meta` 必须是**纯对象字面量**且是第一个语句：无变量、无函数调用、无展开、无模板插值。
- 禁用 `Date.now()` / `Math.random()` / `new Date()` / `import()` / `require()` / `eval`。
  时间戳在脚本跑完后由外面盖章；随机性用索引/label 差异代替。
  Tier-2 的静态检查**只扫可执行代码**：注释与字符串/模板字面量里的这些词不会误杀（prompt 里写 "check Math.random()" 是合法的）。
- 脚本自身**不提供**文件与 shell 原语——枚举、读写、测试、diff 全部交给子代理或 Tier-2 运行时外层命令。
  原生引擎（claude-code / codebuddy）是编译期扫描 + 运行时拦截的确定性沙箱；**Tier-2 的 `vm` 只做确定性约束，不是安全边界**（已关闭 `codeGeneration` 字符串求值，但注入的宿主函数仍可能被构造器链利用）。workflow 脚本属于受信输入。
- 脚本体是 async 上下文，直接 `await`；顶层 `return` 返回最终结果。
- 并发上限默认 min(16, CPU-2)，Tier-2 可用 `--concurrency n` 覆盖（上限 64）；单次 run 代理总数 ≤1000。

## schema 契约

- **信息型 stage**（评审、分类、摘要）：用 `opts.schema` 让子代理返回机器可读 JSON，脚本聚合。
  schema 只校验形状不校验真伪；客观事实（diff、退出码、指标）必须由脚本/命令自己算。
- **产出型 stage**（改代码、迁移）：让子代理直接编辑 `cwd` 内允许的文件，流程自己 snapshot → diff → 测试 → accept/reject。
- Schema 校验失败重试若干次后该 agent 得 `null`（原生引擎 5 次；wf-runner 2 次）。

## Tier 选择（详见 harness-matrix.md）

| Tier | 适用 | 执行方式 |
|---|---|---|
| 1 原生引擎 | claude-code、codebuddy、装了 pi-dynamic-workflow 的 pi-agent | 把脚本交给内置 `Workflow` 工具 / 扩展的 workflow 工具 |
| 2 便携运行时 | codex、opencode2、hermes、无扩展的 pi-agent | `node <skill>/scripts/wf-runner.mjs <wf.mjs> [--agents agents.json]` |
| 3 会话内降级 | 任何 harness，任务小或无 Node 时 | 用原生子代理工具按 patterns.md 的检查单手动 fan-out |

Tier-2 运行时细节：

- 布局：运行目录 `<out>/<run-name>/`，含 `run.json`、`events.jsonl`、`journal.jsonl`、`result.json`、可选 `report.md`（脚本返回值含 `report` 字符串时写出）、`prompts/`、`outputs/`、`errors/`。
- 续跑：`--resume` 回放 `journal.jsonl`（按调用序号索引，后写覆盖先写）。命中条件 = 调用序号 + prompt 哈希一致且上次非失败（null）；**前缀失效**：首个未命中的调用起，其后所有调用全部重跑（不混用新旧结果）；失败/校验不过的调用不缓存，续跑自动重试。语义回归：`node tests/resume.test.mjs`。
- 并发与超时：`--concurrency n` 限制同时运行的子进程数（计数信号量，`parallel`/`pipeline` 扇出同样受控）；单个 agent 的 `timeoutMs` 到期后按**进程组** SIGKILL（连带孙进程），该 agent 记 `null`。
- 适配：`agents.json` 配角色 → preset（`claude`/`codex`/`pi`/`codebuddy`/`opencode`/`hermes`）或自定义 `command`。模板见 `assets/agents.json`。CLI flag 随版本变化——**首次使用前用 `--help` 核对各 preset 的命令行**，不符就在 agents.json 覆写 `command`/`jsonCommand`。
- 汇总：跑完读 `result.json` 与 `report.md`，不要凭对话记忆总结。
