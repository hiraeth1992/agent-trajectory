# Agent Trajectory 与 DeepSeek Harness 当前实现对比

> 调研日期：2026-10-25
>
> 本地基线：`HEAD=28ffb1566f6d647497777d968fe24d4690046163`、版本
> `0.1.0`，加当前工作区全部 tracked/untracked 变更
>
> 上游基线：DeepSeek Harness `0.2.1-rc.3`，
> [`22ddee3792402c3e70ec5f86a63c3e3e895a2f60`](https://github.com/deepseek-ai/deepseek-harness/tree/22ddee3792402c3e70ec5f86a63c3e3e895a2f60)
>
> 本报告只做源码、测试和文档对照，不修改业务逻辑。上游链接全部固定到上述 commit。

## 一页结论

两者不是同一层次的替代实现：

- Agent Trajectory 是**独立、只读、多来源的轨迹投影、诊断和评测系统**；
- DeepSeek Harness 是**创建和驱动 Agent 的完整 runtime**，Cordis 插件树负责组合
  Agent Loop、LLM、工具、Session、持久化和客户端能力。

因此，不建议把 Agent Trajectory 改造成 Cordis 插件运行时，也不建议复制 Harness 的
Agent Loop、工具执行、审批、沙箱或写入式 Session 管理。当前项目的多来源 adapter、统一
只读模型、来源故障隔离、能力声明、安全路由、脱敏以及 Evaluation Loop 都是独立价值，
不应为“架构相似”而推倒。

真正值得借鉴的是几个较小而清晰的契约：

1. `key / stateVersion / init / apply / view` 的增量 reducer；
2. watermark/checkpoint 和按变化发布的 view；
3. 版本化持久格式、相邻迁移、未来版本 fail closed；
4. surface 事件的完整语义校验；
5. 按用户路径分层的性能场景和明确预算。

当前最重要的问题也不是继续增加评测模块，而是确保现有评测**建立在完整、可识别、可比较
的事实之上**。建议优先级如下：

| 优先级 | 优化项 | 主要收益 |
| --- | --- | --- |
| P0 | 补齐 DSH surface 语义校验 | 避免从非法或错误重建的模型上下文继续分析 |
| P0 | Facts Quality 消费 coverage/disposition，并声明 criterion 所需事实 | 区分“来源不可观察”“投影丢失”和“Agent 失败” |
| P0 | 修正 Dataset/Gold/Run 身份、exact、precision/recall 和 diff 口径 | 让回归结论可复现、可归因、不会过度乐观 |
| P0 | 把 Requirement/Chain 从消息级关键词提升为原子要求和 lineage 验证 | 让多要求、替代、跨轮承接评测可信 |
| P1 | 将 append 输入升级为端到端增量 reducer 和 fragment delta | 长会话追加成本随变化规模增长 |
| P1 | 让历史 DSH generation 可见，按需再实现只读迁移链 | 避免旧会话从列表静默消失 |
| P1 | 分开“复现比较”和“Evaluator A/B 实验” | 可以可靠比较规则版本，而不是因版本不同直接拒绝 |
| P1 | 冻结候选池、去除 evaluator 参与抽样、加强 split 与一致性统计 | 降低选择偏差、泄漏和虚假一致性 |
| P2 | zstd frame 尾读、缓存估重、Worker 排队与 payload 观测 | 用数据决定池化和缓存重构 |
| P2 | Evaluation Center、Process Check、badcase/采纳账本闭环 | 把已有 CLI/协议能力变成可运营流程 |

推荐实施顺序是：

```text
投影语义与 coverage 事实契约
  → Run/Gold 身份与统计正确性
  → Requirement/Chain 与真实人工校准
  → 增量投影和历史格式
  → 性能与产品闭环
```

## 对比方法与边界

### 基线

本地工作区包含大量用户尚未提交的评测和 UI 变更，尤其是
`server/evaluation/`、Evaluation Center 和 Annotation Workspace。它们是本报告的当前实现
基线，不是待清理内容。由于这些变更尚未形成 commit，本报告可以固定本地 `HEAD`，但不能
给全部被审实现提供单一可复现 Git SHA。

上游通过本地只读副本核验，并固定到 `22ddee3`。分析优先使用一手源码、包 README、测试和
固定格式规范，不依据二手介绍推断行为。

### 范围

重点比较：

- 总体架构和责任边界；
- Session/事件、surface、projection 和 API 数据流；
- 轨迹查看、轨迹分析、Requirement/Chain；
- Evaluation Contract、Gold、Run、校准与一致性；
- 格式兼容、增量和性能工程。

不把下列 Harness runtime 能力视为当前项目缺失：

- Agent 创建、恢复和驱动；
- LLM provider 与请求发送；
- 工具执行、审批、沙箱和副作用治理；
- Cordis 插件生命周期、热加载和插件市场；
- Session 写入、多进程单写者和持久化发布。

这些能力属于不同产品边界。Harness 的 Agent Loop 明确负责模型请求、流式响应、工具执行和
持久 Session 历史；当前项目只读消费已经存在的来源数据：

- [Harness Agent Loop 职责](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/README.md#summary)
- [当前项目定位](../README.md#agent-trajectory)

## 架构与功能分工

### 当前项目

```text
DSH JSONL/Zstd ──> DshSource ───┐
Codex JSONL ─────> CodexSource ─┼─> shared projection Worker
ZCode SQLite ────> ZcodeSource ─┘            │
                                               v
                              SessionDetail / TrajectoryProjection
                                               │
                             SourceRegistry + API snapshot/delta + SSE
                                               │
              Conversation / Timeline / Inspector / Trajectory Analysis
                                               │
                     Facts Quality / EvaluationRun / Calibration / UI
```

核心边界是：

- 每个 `SessionSource` 自己负责发现、探测、读取、审计和 fingerprint；
- adapter 直接产出统一 `SessionDetail`，不会把 Codex/ZCode 伪装成 DSH 事件；
- `TrajectoryProjection` 统一消息、工具、时间、usage、关系、coverage 和 task state；
- 分析、评测和校准位于只读投影之上；
- Canonical 来源文件和数据库不被改写。

代码入口：

- [`SessionSource` 契约](../server/sources/types.ts#L32)
- [`TrajectoryProjection`](../src/types.ts#L259)
- [当前架构说明](../README.md#架构)

### DeepSeek Harness

```text
Cordis composition / plugin lifecycle
                 │
                 v
Agent registry ─> Agent Loop ─> LLM adapter ─> Tool executor
                       │
                       v
              append-only Session events
                       │
              surface / message projections
                       │
       session projection registry + checkpoints
                       │
           persistence / remote / client feeds
                       │
               Chat / Trajectory views
```

Harness 将公共 `Agent` 接口与具体 Loop driver 分离。Agent Loop 负责 turn/step、prompt、模型、
工具、取消和恢复；Session 是 durable command log；surface 还原模型可见消息；projection
registry 为各领域提供当前状态；Client Trajectory 再把 Session window 投影成账本和时间线。

一手证据：

- [Cordis：能力、LLM、工具和 Agent Loop 都是插件](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/docs/cordis-tutorial/index.md#cordis-tutorial)
- [公共 Agent 与 driver 分工](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent/README.md#design-concept)
- [Agent Loop 的 turn/step 流程](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/README.md#turn-and-step-flow)
- [Client Trajectory 是纯投影视图](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/client/ui-trajectory/README.md#understand-the-implementation)

### 责任映射

| 关注点 | Agent Trajectory | DeepSeek Harness | 判断 |
| --- | --- | --- | --- |
| 能力组合 | 三个明确 adapter + Registry | Cordis 服务、provider、consumer 和插件生命周期 | 当前项目无需插件化 |
| Agent 执行 | 不执行，只观察 | Agent registry + Loop driver | 不应复制 |
| Session | 多来源只读输入 | 当前逻辑事件和 append-only durable log | 只借鉴读取契约 |
| Surface | DSH 专用 fold，输出 transcript/model context/audit | Session 核心语义，直接决定下一次模型请求 | 本地需更严格对齐 |
| Projection | 三来源统一 `TrajectoryProjection` | 按领域注册 projection unit | 可借鉴 reducer 形状 |
| 客户端同步 | 内容 hash + record upsert/delete delta | Session window + projection snapshot/change feed | 本地 delta 仍可细化 |
| 轨迹查看 | 跨来源统一账本、故事线、检查器 | DSH 自身 Session 的 ledger/timing/inspector | 当前项目跨来源更强 |
| 轨迹分析 | 本地确定性五维分析、Requirement/Chain、建议 | 主要是可观测事实展示 | 当前项目独有优势 |
| 独立评测 | Dataset/Run/Gold/双标/裁决 | Goal 完成由调用者/模型声明，独立 evaluator 明确 deferred | 当前项目明显更完整 |
| 格式兼容 | DSH v4 reader；其他版本只 probe | 固定 catalog 的 v0→v4 相邻迁移 | 值得选择性借鉴 |
| 性能门禁 | 功能/性能测试已有，但增量路径指标不足 | 按用户路径的独立 benchmark 和时间/内存预算 | 值得借鉴方法 |

Harness 自己也明确说明 Goal 没有独立 evaluator，完成或阻塞由调用者记录，认证留给其他
policy layer。因此不能把 Harness 的运行时状态机误当成 Gold 评测系统：

- [Harness Goal 的 evaluator 限制](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/goal/goal/README.md#known-limitations-and-deferred-work)

## 当前项目已经做对的部分

### 1. 多来源边界比直接复用 DSH 模型更合适

当前项目没有把三种来源压成伪 DSH event，而是保留各自读取和关联语义，再投影到统一事实
模型。这避免了把来源缺失字段误报成空值，也允许 ZCode 的 trace/policy/tasks 和 Codex 的
reasoning/usage 按真实可观测能力出现。

- Codex 保留 reasoning、工具输入输出、错误和 usage；加密 reasoning 只保留安全占位；
- ZCode 按 schema capability 渐进保留 reasoning、usage、trace、policy、lineage 和 tasks；
- DSH 保留 request header/config/tools/context、producer source、usage、error 和 surface
  lineage；
- capability map 明确来源是否支持 trace、lineage、policy、tasks 等事实。

这比强制三来源字段完全同构更可靠。后续应在 criterion 级声明所需事实，而不是要求所有
来源都补出同样字段。

证据：

- [来源 capability 类型](../src/types.ts#L11)
- [Codex capability 与 projector](../server/sources/codex.ts#L26)
- [ZCode capability 协商](../server/sources/zcode.ts#L250)
- [DSH capability](../server/sources/dsh.ts#L44)

### 2. DSH 的三层历史视图方向正确

本地已经区分：

- durable transcript；
- 当前 model context；
- 完整 audit 轨迹。

surface replacement 会保留 current/shadowed、replacement/source lineage；`image/offload`
只改变后续模型上下文，不改 durable transcript。这个分层比只展示当前消息或只展示原始
事件更适合审计。

[`image/offload` 本地实现](../src/projector.ts#L437)与固定上游的顶层行为一致：都将选中
image block 标成 `{ offloaded: true }`，不是旧报告曾描述的“替换为附件路径文本”：

- [上游投影器](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/compaction/compaction-image-offload/src/projection.ts#L39-L73)
- [上游消息修改](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/compaction/compaction-image-offload/src/project-message.ts#L13-L35)

需要单独记录一个双方共同的契约歧义：上游声明 image index 是 depth-first，并包含 nested
tool results，但固定版本 `project-message.ts` 实际只遍历 `message.content` 顶层 block，
上游测试也只覆盖 tool-result message 顶层图片。本地同样是顶层语义。除非上游先明确嵌套
content 的正式结构，不应把它误报为仅本地缺陷。

### 3. 已有 projection coverage 和 fail-closed 基础

当前项目已经：

- 固定了已知 durable event 词表；
- 把 `assistant/live-chunk` 排除为客户端瞬态事件；
- 单独锁定必需 message projection 类型；
- 对事件记录 `record / folded-state / relation-only / raw-only / unsupported`；
- 统计 `consumed/total/gap`；
- folded state 语义校验失败时保留 audit-only；
- 未知 required event 和不连续 seq fail closed。

`tests/projector.test.ts` 将已知事件集合与固定上游快照比较。这是**固定版本审查门禁**，
不是从上游自动同步；上游版本变化时仍需要人工更新和审查语义。

- [本地已知事件集合](../src/projector.ts#L27)
- [本地 coverage 生成](../src/projector.ts#L1302)
- [固定上游事件词表](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/session/src/known-event-types.ts#L22-L90)

### 4. Evaluation Loop 基础设施已经存在

当前工作区已经具备：

- 版本化 verdict、attribution、denominator、evidence boundary；
- Facts Quality；
- RequirementResult 和 ChainResult；
- 12 条三来源合成冻结 case；
- EvaluationRun、JSON/Markdown 报告和 baseline diff；
- Process Check；
- 真实轨迹冻结、脱敏、双 Reviewer、Kappa 和裁决；
- Evaluation Center 和 Annotation Workspace。

因此不能再把“缺少 Evaluation Contract、Gold、批量 Run、人工标注基础设施”列为当前
缺口。真正的问题是身份、统计、抽样和语义是否足以支撑可信结论。详细重评见：

- [Agent Evaluation 当前重评](./AGENT-EVALUATION-REEVALUATION-2026-10-25.md)

## 轨迹投影与数据流差异

### Harness projection registry 的可借鉴部分

Harness 的 projection unit 声明：

```text
key + stateVersion + stateSchema
init(header, inheritedEventCount)
apply(state, event)
wire.view(state)
```

每个 cell 保存 `observedSeq` watermark；已有 cell 只 fold 尚未观察的新事件；state 引用不变
时跳过 view 工作；view 引用不变时抑制发布；checkpoint 保存 key/version/seq/state，冷读可从
水位后恢复。

- [projection unit 合同](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-projection/README.md#define-a-projection-unit)
- [checkpoint/watermark](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-projection/README.md#persisted-checkpoints)
- [逐事件 advance/drive](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-projection/src/index.ts#L747-L848)

当前项目无需动态注册 projection plugin，但可用静态 reducer 表达同样契约，例如：

```ts
interface ProjectionUnit<State, View> {
  key: string
  stateVersion: number
  init(input: ProjectionHeader): State
  apply(state: State, event: SourceEvent): State
  view(state: State): View
}
```

适合先拆出的 unit：

- DSH surface/message projection；
- turn/step 边界和 summary；
- tool call/result 配对；
- request header/context；
- Goal/Todo；
- coverage/disposition；
- source-specific optional facts。

### 当前 append 仍不是端到端增量

本地 adapter 已经能只读取或发送新增数据，但 Worker 收到 append 后仍：

1. 将新增事件追加到完整历史数组；
2. 对完整历史重新调用 `projectTrajectory()` 或 `projectCodexTrajectory()`；
3. 返回完整 `TrajectoryProjection`；
4. 用整份 state 的 `JSON.stringify` 重新估重。

证据：

- [`stateWeight()`](../server/projection-worker.ts#L55)
- [DSH append 后完整投影](../server/projection-worker.ts#L88)
- [Codex append 后完整投影](../server/projection-worker.ts#L114)
- [Worker 完整回传](../server/projection-worker.ts#L148)

API 虽然按 record ID 计算 upsert/delete，但 revision 对完整 transport detail 做 hash；空 delta
和普通 delta 都发送完整 projection 元数据与完整 `recordOrder`：

- [完整 detail revision](../server/api.ts#L293)
- [空 delta](../server/api.ts#L316)
- [record delta](../server/api.ts#L329)

这意味着：

- adapter I/O 已按追加规模下降；
- projection CPU、structured clone、reply payload 和估重仍大体随完整历史增长；
- `recordOrder` 和大 projection facet 会削弱 delta 的网络收益。

不建议直接改为 Worker 池。先建立 append p50/p95、queue wait、request/reply bytes、
structured clone bytes、RSS 和 cache version 数量，再决定 reducer、fragment delta 和池化。

### 历史 DSH generation

本地 `DshSource` 只把 `session.v4.jsonl[.zst|.zstd]` 纳入列表，parser 也只接收 v4。probe
能发现其他 `session.vN` 并报告 degraded/blocked，但历史会话不会作为列表项出现：

- [本地文件白名单](../server/sources/dsh.ts#L29)
- [本地 v4 parser](../server/sources/dsh.ts#L173)
- [本地 list](../server/sources/dsh.ts#L361)

Harness 会选择数值最高的 canonical generation；`stat/list` 暴露 `current` 或
`migration-required`；v0→v1→v2→v3→v4 使用固定相邻迁移链；只读 open 在内存迁移，不
发布 successor；写 open 才在重新校验 revision 后发布不可变 successor；未来格式拒绝并提示
升级：

- [持久化 format status 和 fail-closed](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-persistence/README.md#failures-and-recovery)
- [generation 选择与只读迁移](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-persistence-jsonl/README.md#reading-the-logs)
- [固定格式 catalog](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-format-catalog/README.md#entry-point)

对只读查看器，更合适的第一步不是立刻复制完整迁移系统，而是：

1. list 所有 canonical generation；
2. 选择最高 generation；
3. 返回明确的 `current / migration-required / unsupported-future / corrupt` 状态；
4. 不支持的会话仍可见，但禁止进入会产生误导的语义分析；
5. 只有真实历史会话需求成立时，再加入纯函数相邻迁移链；
6. 永远不改写 `~/.dsh/sessions`。

## 轨迹分析与评测差异

### Harness 的“Trajectory”主要是观察，不是质量判定

Harness Client Trajectory 负责：

- turn-aware ledger；
- timing overview；
- user/assistant/tool/subtool/compaction 分组；
- usage、duration、input/output、image/attachment inspector；
- 长历史分页和可见行虚拟化；
- streaming/in-flight 展示。

它刻意不从“请求已完成”推断“工具或 turn 已完成”，也不为运行中记录捏造 duration：

- [Harness Trajectory 功能](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/client/ui-trajectory/README.md#summary)
- [请求与运行中状态](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/client/ui-trajectory/README.md#inspecting-records)

当前项目在这之上增加了跨来源统一事实、五维过程分析、纠错链、Requirement/Chain 和
EvaluationRun。这是当前项目的核心差异化；不应为了贴近 Harness 而退回纯展示。

### 当前 Facts Quality 尚未消费已有 coverage

`buildFactsQualityReport()` 已检查：

- blocked/degraded protocol；
- unknown events；
- running target；
- truncation；
- tool input/result 缺失；
- broken parent span；
- trace/usage capability。

但没有读取：

- `projection.coverageSummary.gap`；
- `coverage` 中 known-but-raw-only 事件；
- folded-state semantic validation failure；
- criterion 对特定 disposition/fact/capability 的依赖。

证据：

- [Facts Quality 当前实现](../src/trajectory-evaluation.ts#L73)
- [Projection coverage 类型](../src/types.ts#L127)
- [本地 coverage 计算](../src/projector.ts#L1302)

影响是：事件名虽然已知，但没有进入分析语义时，Evaluator 仍可能对 outcome、reliability
或 observability 给出肯定结论。

建议引入 criterion 级事实合同：

```ts
interface CriterionFactsRequirement {
  criterionId: string
  requiredCapabilities: SourceCapability[]
  requiredEventSemantics: Array<{
    eventType?: string
    dispositions: EventDisposition[]
  }>
  missingPolicy: 'block' | 'warn' | 'not_applicable'
}
```

门禁应明确区分：

- **unobservable**：来源本身没有该能力；
- **projection-gap**：来源有事实，但本地未投影或语义校验失败；
- **not-applicable**：该 case 不需要该事实；
- **agent-failure**：事实充分后才允许归因给 Agent。

### RequirementResult 仍是消息级

当前实现把每条 user/steering record 变成一个 requirement：

- 一条消息中多个要求、约束和验收条件不会拆分；
- 出现“改为/取消/替代”等词时，可能把之前整条消息级要求整体 supersede；
- 只有一个 active requirement 时，整体 outcome positive 会直接标记 implemented；
- 多个要求则统一退回 insufficient evidence。

证据：

- [Requirement 当前实现](../src/trajectory-evaluation.ts#L316)

建议新增：

```ts
interface RequirementCandidate {
  id: string
  sourceRecordId: string
  kind: 'deliverable' | 'constraint' | 'acceptance' | 'prohibition'
  text: string
  introducedAt: { turn: number; seq: number }
  supersededBy?: string
  dependsOn?: string[]
}
```

稳定 ID 应由 source record、消息内位置和规范化文本共同生成；`implemented` 必须引用行为或
产物证据，而不只是整体 outcome；替代关系只作用于被明确替代的原子要求。

### ChainResult 主要是关键词承接

当前实现根据后续用户消息中的“继续、按方案、已确认”等词倾向判定 normal，根据“忘了、
遗漏、没按”等词判定 missing。它能保守避免无证据硬判，但不能验证：

- 后续输入是否引用了正确 requirement/decision；
- Agent 行动是否真正沿用该事实；
- 最终产物是否保留前序约束；
- “继续”后是否实际执行了另一件事；
- 用户未指出时是否仍发生客观承接错误。

证据：

- [Chain 当前实现](../src/trajectory-evaluation.ts#L413)

建议基于 lineage 分三段验证：

```text
input carryover  →  action carryover  →  result carryover
```

每个 transition 关联 requirement/decision/artifact ID，分别给出 observed、missing、
incorrect、insufficient；用户纠错只是反证之一，不是唯一失败信号。

### 评测身份和统计比增加新功能更紧急

当前 `runId()` hash 实际输出和 facts，但没有把完整 Gold 内容身份纳入；dataset version、
evaluator version、facts schema 和 target fingerprint 是主要比较条件。`compareEvaluationRuns()`
又在 evaluator version 不同的时候直接判 incomparable：

- [Run identity](../server/evaluation/runner.ts#L77)
- [Run compare](../server/evaluation/runner.ts#L280)

同时，当前 exact、precision/recall、FP/FN 和 baseline direction 存在以下风险：

- partial expectation 通过可能被表述成 case exact；
- `insufficient_evidence / not_applicable / evaluator_error` 可能被压成普通正负类；
- mismatch 数相同但 verdict 风险方向变坏，case 仍可能显示 unchanged；
- Gold 改变而 version 未升时，run identity 可能不变。

完整问题和建议已在
[评测重评报告](./AGENT-EVALUATION-REEVALUATION-2026-10-25.md#p0先修评测身份与统计正确性)
中展开。本报告承接该结论：

1. Dataset 增加 `contentHash`，Gold/裁决增加 `goldHash`；
2. Run 增加 evaluator build/contract/context policy hash；
3. partial contract regression 与 full Gold exact 分开命名和统计；
4. confusion matrix 区分 positive/negative/abstain/error；
5. diff 使用 verdict 风险矩阵和 required criterion gate；
6. 把比较分成 reproducibility 和 evaluator experiment 两种模式。

### 合成回归、真实校准和独立验收要分层

当前 12 条合成 case 与规则实现高度同构。它们非常适合：

- 协议回归；
- 边界和 fail-closed 回归；
- 正负控；
- 防止已修 bug 复发。

但不能单独证明 evaluator 对真实生产轨迹有效。建议固定四层名称：

| 层 | 用途 | 可否调规则 |
| --- | --- | --- |
| synthetic contract regression | 规则和协议回归 | 可以 |
| private real calibration | 调阈值、发现语义缺口 | 可以 |
| frozen real regression | 日常回归门禁 | 不应频繁改 Gold |
| untouched independent acceptance | 最终泛化验收 | 解封前禁止查看和调参 |

只有完整双标、分歧裁决后的真实冻结集可以称为 full Gold。

### 当前真实候选抽样存在选择偏差和泄漏风险

`prepareCalibrationCandidates()` 当前：

- 每来源只查看最新 `quota × multiplier` 条 summary；
- `selectionTraits()` 调用当前 `analyzeTrajectory()` 参与多样性排序；
- 按排序后 index 直接切 50%/20%/30%；
- independent case 与其他 case 一起生成和可见。

证据：

- [selection traits](../server/evaluation/calibration.ts#L582)
- [split 规则](../server/evaluation/calibration.ts#L594)
- [候选准备](../server/evaluation/calibration.ts#L730)

这会造成：

- 最近会话偏差；
- 当前 evaluator 已经影响被选样本；
- 同一项目、父子会话或相近任务可能跨 split；
- independent 可能在规则开发期间提前泄漏。

建议 manifest 固化：

```text
candidatePoolHash
samplingPolicyVersion
seed
strata
groupKey
splitPolicy
sealedIndependentHash
```

候选池先冻结，再只用 evaluator 无关的结构特征分层；使用固定 seed 和 group-aware split；
parent/child、同项目或同任务组不能跨 split；independent 只保存 sealed manifest，最终验收时
再解封。

### 一致性统计粒度不足

当前 `compareHumanAnnotations()`：

- 把 criterion verdict 与 attribution 拼成单个类别计算一个总体 Kappa；
- 没有按 criterion 分层；
- Requirement 只列 disagreement，没有 agreement/Kappa；
- Chain 只有 exact agreement；
- 没有置信区间和类别分布。

证据：

- [人工标注一致性](../server/evaluation/calibration.ts#L1397)

建议至少输出：

- 每个 criterion 的 verdict agreement/Kappa；
- attribution 单独 agreement；
- requirement detection、state 和 evidence 的分层一致性；
- chain continuity 的类别分布和 agreement；
- bootstrap 置信区间；
- prevalence 和 reviewer marginal，避免只看 Kappa。

## 优化项详解

## P0：先修投影和评测正确性

### P0-1：补齐 DSH surface 语义校验

#### 当前差距

本地已经校验 replacement 范围、`sourceEventSeqs`、`image/offload`，但未完整实现固定上游的
以下约束：

1. surface-eligible event 必须显式带 `surfaceOp`；
2. 非 surface event 不能携带 `surfaceOp/sourceEventSeqs`；
3. `tool/result` replacement 必须精确重写一个当前 tool result，且只能改变 content；
4. surface 首节点若为 system prompt，只能被单个 `system/message` 精确替换；
5. `developer/message.headerSeq` 必须指向更早的 `request/header`；
6. tool-addition 必须解析到唯一、完整的工具定义，`deferLoading` 存在时只能为 true；
7. 必需 message projection 没有解释器时必须 fail closed。

上游证据集中在：

- [surface metadata、developer header 和 replacement 语义](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/session/src/surface.ts#L301-L539)

本地 `foldSurface()` 目前把缺少 `surfaceOp` 的 eligible event 当作 append：

- [本地 surface fold](../src/projector.ts#L559)

#### 建议

提取纯 `validateDshSurfaceEvent()` 和 `planSurfaceTransition()`，先验证整个 transition，再原子
应用，避免部分状态变更。校验失败：

- DSH load fail closed；
- audit/export 保留明确错误元数据；
- 不进入 trajectory analysis 和 evaluator；
- source status/错误页显示具体 seq 和 invariant。

#### 涉及文件

- `src/projector.ts`
- `server/sources/dsh.ts`
- `tests/projector.test.ts`
- `tests/sources/dsh.test.ts`

#### 验收

- 对上述 7 类非法事件逐项添加正反例；
- replacement chain 与上游固定 fixture 结果一致；
- 合法 append/replace/image-offload 行为不变；
- 错误发生时没有部分 surface state 或部分 model-context override。

### P0-2：把 coverage 变成 evaluator 前置事实合同

#### 建议

- `FactsQualityReport.stats` 纳入 coverage total/consumed/gap；
- 每个 gap 保留 event type、disposition、reason 和受影响 criterion；
- folded-state semantic failure 默认 blocking；
- raw-only 是否 blocking 由 evaluator contract 决定；
- capability 缺失不自动归因 Agent；
- facts hash 包含 coverage policy 版本和 criterion dependencies。

#### 涉及文件

- `src/evaluation-types.ts`
- `src/trajectory-evaluation.ts`
- `src/projector.ts`
- `server/evaluation/runner.ts`
- `tests/trajectory-evaluation.test.ts`

#### 验收

- unknown、raw-only、unsupported、folded failure 分别有 case；
- 同一事实缺口只阻断依赖它的 criterion；
- 来源不可观察显示 source/insufficient，不计为 Agent fail；
- coverage policy 变化会改变 contract/facts identity。

### P0-3：修正评测身份、统计和 diff

#### 建议

同时完成以下最小闭环：

1. Dataset/Gold/Run 完整内容 hash；
2. synthetic partial contract 与 full Gold 区分；
3. abstain/error 不进入普通 FP/FN；
4. 每 criterion 输出 eligible N、precision/recall、abstain 和 error；
5. diff 使用风险方向和 required criterion；
6. Gold、Target、facts schema 或 context policy 不同必须拒绝归因；
7. evaluator build 不同但输入/Gold/contract 相同，允许进入 experiment compare。

#### 涉及文件

- `src/evaluation-types.ts`
- `server/evaluation/runner.ts`
- `server/evaluation/gold-dataset.ts`
- `server/evaluation/calibration.ts`
- `server/cli.ts`
- Evaluation Center 的 Run/diff UI

#### 验收

- 只改一个 Gold verdict，`goldHash` 和 run identity 都变化；
- partial case 不显示 full exact；
- `insufficient_evidence` 和 `evaluator_error` 不产生普通 FP/FN；
- mismatch 数相同的 `pass→fail` 必须显示 regressed；
- evaluator A/B 可比较，Gold 或 Target 不同不可比较。

### P0-4：原子 Requirement 与 lineage Chain

#### 建议

- 引入稳定 `RequirementCandidate`；
- 拆分 deliverable、constraint、acceptance、prohibition；
- 精确建模 introduced/supersededBy/dependsOn；
- 结果状态引用最小 evidence；
- Chain transition 关联 requirement/decision/artifact；
- 分开 input/action/result carryover；
- 没有足够证据时保持 abstain，不用关键词补齐事实。

#### 涉及文件

- `src/evaluation-types.ts`
- `src/trajectory-evaluation.ts`
- `src/trajectory-analysis.ts`
- `server/evaluation/calibration.ts`
- Annotation Workspace

#### 验收

- 单消息多要求、追加约束、局部替代、部分完成；
- “继续”但实际未承接；
- 用户未投诉但产物遗漏约束；
- 合法改道并保留原要求；
- 每项状态和 transition 都能定位 evidence record。

## P1：增量架构、格式和评测实验

### P1-1：静态 reducer + fragment delta

#### 实施顺序

1. 先记录 snapshot/append 的 parse、queue、fold、clone、reply、merge 分段耗时；
2. 将 DSH projection 拆成静态 unit，并保存 unit watermark；
3. append 只 `apply()` 新事件；
4. 输出 changed facets，而非完整 projection；
5. API delta 增加 order ops 或 order revision；
6. state weight 改为增量记账；
7. record cache 新版本替换旧版本；
8. 再评估是否需要 2 个 Worker 的 keyed pool。

建议 fragment：

```text
recordUpserts / removedRecordIds
turnUpserts / removedTurnIds
relationUpserts / removedRelationIds
coverageUpserts
taskStateReplacement
modelContextUpserts
orderOps
```

#### 验收

- 10k 历史 + 1 条 append 与完整 replay 深度相等；
- append p50/p95 不再随完整历史近似线性增长；
- 无变化 delta 不发送完整 projection/recordOrder；
- Worker 被淘汰或 seq 不连续时安全回退 snapshot；
- queue/payload/RSS 指标可观测。

### P1-2：历史 DSH generation 可见性

#### 建议

第一阶段只做发现和状态：

- 扫描 `session[.vN].jsonl[.zst|.zstd]`；
- 每 Session 选择最高 canonical generation；
- list 保留 migration-required 和 unsupported item；
- load 对不支持格式 fail closed；
- UI 显示版本、路径类别和建议。

第二阶段由真实样本驱动，只实现纯只读相邻 migration；迁移结果写本地缓存也必须位于
Agent Trajectory 自己的数据目录，不能写回 DSH。

#### 验收

- v0/v1/v2/v3/v4/future/corrupt 均可在列表得到明确状态；
- future 不被旧 reader 误读；
- read-only migration 不改变源文件 hash；
- migration failure 不隐藏其他健康会话。

### P1-3：分开复现比较和 Evaluator 实验

建议两个 API：

```text
compareForReproducibility()
  要求 evaluator build/version 完全相同

compareEvaluatorExperiment()
  允许 evaluator 不同
  要求 datasetHash、goldHash、case fingerprint、
  facts schema/input、contract/context policy 完全相同
```

实验报告应同时给出：

- case/criterion 改善、退化、mixed、inconclusive；
- abstention 和 evaluator error 变化；
- required criterion gate；
- 正控误伤和 issue recall；
- latency/cost 变化。

### P1-4：校准抽样与 split 防泄漏

#### 建议

- 先冻结完整候选池 manifest；
- 只用来源、长度、工具密度、turn 数、能力、结构状态等 evaluator 无关特征；
- 固定 random seed；
- 使用 project/task/parent-child group-aware split；
- independent 默认 sealed；
- sampling policy、seed、group key、pool hash 进入 manifest；
- 记录被跳过 case 及原因，检查 nonresponse bias。

#### 验收

- 相同 pool/seed/policy 产生相同 split；
- evaluator 输出变化不影响样本选择；
- 同一 group 不跨 split；
- independent 解封前 UI/CLI 不显示内容；
- sampling manifest 可独立审计。

### P1-5：一致性统计升级

#### 建议

- verdict 与 attribution 分开；
- criterion 分层；
- Requirement detection/state/evidence 分层；
- Chain 类别分层；
- exact、Kappa、类别分布和 bootstrap CI 同时输出；
- 小样本或单类别时明确 Kappa 不可解释。

#### 验收

- 总体 Kappa 不再掩盖某一 criterion 的低一致性；
- Reviewer marginal 可见；
- Requirement 和 Chain 不再只有 disagreement 列表；
- CI 和有效样本数进入报告。

## P2：性能工程与产品闭环

### P2-1：利用 zstd 独立 frame 做尾部读取

Harness 每个持久 append batch 使用独立 checksummed Zstandard frame。当前本地压缩 DSH 文件
变化后仍整文件解压。可以缓存最后完整 frame offset 和逻辑 seq，只扫描新增 frame；尾部
torn frame 保留到下一次读取。

实施前必须用真实分布和合成大文件验证：

- frame scanner 的 CPU/内存；
- torn/checksum/corruption 区分；
- 文件替换、截断、generation 变化回退；
- 与整文件 decode 的等价性。

### P2-2：缓存和 Worker 可观测性

建议新增：

- Worker queue wait；
- projection compute；
- request/reply bytes；
- structured clone 时间；
- state/record cache entries、versions 和 bytes；
- LRU eviction/rebuild；
- process RSS/heap；
- 按 source 和 snapshot/append 维度的 p50/p95。

Harness 的性能门禁按用户路径组织，在 fresh process、固定合成输入上记录 wall time、CPU 和
peak RSS，并区分参考机期望与 CI headroom。这种方法比直接复制它的具体预算更值得借鉴：

- [Harness benchmark policy](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/benchmarks/AGENTS.md)
- [测试层级和 benchmark gate](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/docs/testing.md#tiers)

### P2-3：完成 Evaluation Center 四阶段闭环

当前 UI 主要完成数据集发现和标注工作台。建议按协议显式呈现：

```text
Prepare/Freeze → Annotate → Adjudicate → Run/Diff/Gate
```

UI 只做受限 adapter，权威数据仍是本地 JSON/manifest：

- agreement、disagreement 和裁决；
- Run 启动、历史和报告；
- baseline/candidate diff；
- gate decision/reasons；
- case → criterion → evidence 下钻；
- 3～120 任意 case 数；
- Reviewer 隔离、revision lock 和私有目录约束保持不变。

### P2-4：Process Check、casebook 与采纳账本

建议把现有 Process Check 接入真实诊断 access ledger 和 EvaluationRun，而不是只检查合成
对象。再建立：

- 诊断 badcase → candidate；
- 去重、状态和 owner；
- accepted/rejected/deferred；
- 实施 commit/版本；
- baseline/candidate run；
- 实际效果、回滚和后续观察。

保持当前安全边界：不自动修改 Skill、代码、Hook，不自动创建外部 Agent 或提交 PR。

### P2-5：外部 Run 与 AI Judge

在真实 full Gold 就绪后再投入：

- 不可信外部 EvaluationRun adapter；
- schema/identity/evidence fail closed；
- 相同 facts 重复运行；
- A/B 顺序交换；
- quote 与脱敏 evidence preview 匹配；
- invalid evidence ID 和伪造路径扫描；
- model/prompt/context hash；
- 低置信转人工；
- 延迟和成本。

在真实 Gold 之前，不建议训练小 Judge 或用单一总分替代分项证据。

## 不建议照搬的 Harness 能力

### 1. 不复制 Cordis 或 “everything-is-a-plugin”

当前来源集合和产品边界明确。引入完整动态插件系统会增加：

- 生命周期和依赖排序；
- HMR/disposal；
- 配置和兼容矩阵；
- 插件隔离与信任；
- 更多测试面。

静态 adapter registry 和静态 evaluator registry 足够表达当前扩展点。

### 2. 不引入 Session 写入和 successor publication

当前项目的可信边界来自只读。历史格式迁移应优先在内存完成，最多写自己的私有缓存，不能
成为 DSH canonical log 的第二个 writer。

### 3. 不复制 Agent Loop、工具执行、审批和沙箱

这些是来源系统的行为，不是观察器职责。当前项目应评价它们留下的事实，而不是重新执行或
控制它们。

### 4. 不立即持久化完整 projection checkpoint

在本地只有少量常用会话、现有内存缓存可以安全重建的情况下，完整持久 checkpoint 会引入
schema migration、失效和隐私存储成本。先实现内存 reducer/watermark；冷启动数据证明需要
后，再选择小型 checkpoint。

### 5. 不在缺少指标时直接做 Worker 池

池会引入 keyed ordering、状态归属、迁移、取消和额外内存。先测 queue/payload/CPU/RSS；
只有单 Worker 确实阻塞不同会话时才池化。

## 推荐实施计划

### 阶段 1：事实正确性

范围：

1. DSH surface 完整语义校验；
2. coverage criterion contract；
3. folded semantic failure 进入 Facts Quality；
4. 对应合成 fixture 和差分测试。

完成标准：

> 非法或不完整 DSH surface 不会进入分析；每个 criterion 能说明所需事实、缺失类型和
> attribution；本地合法 projection 与固定上游 fixture 一致。

### 阶段 2：评测可信度

范围：

1. Dataset/Gold/Run identity；
2. partial/full Gold；
3. confusion eligibility；
4. direction-aware diff；
5. reproducibility/experiment 双比较。

完成标准：

> 同一冻结输入与 Gold 下可以比较 evaluator A/B；Gold、Target、contract 或 context 变化时
> 拒绝错误归因；abstain/error 不进入普通 FP/FN；partial assertion 不宣称 full exact。

### 阶段 3：Requirement/Chain 与真实校准

范围：

1. 原子 Requirement；
2. lineage Chain；
3. evaluator 无关抽样；
4. group-aware split 和 sealed independent；
5. 分 criterion 双标、裁决和统计。

完成标准：

- 多要求、替代和部分完成有真实 Gold；
- input/action/result 承接可定位证据；
- independent 未参与开发；
- 输出每 criterion agreement、Kappa、precision/recall、abstention 和 CI。

### 阶段 4：端到端增量

范围：

1. 分段性能观测；
2. 静态 reducer/watermark；
3. changed fragment；
4. order ops；
5. 增量估重和 record version 回收；
6. 历史 generation 可见性。

完成标准：

- append 与完整 replay 逐 cut 深度相等；
- append 成本主要随变化量增长；
- 空 delta 接近常量 payload；
- 回退 snapshot 和格式 refusal 不退化。

### 阶段 5：运营和性能

范围：

- Evaluation Center 四阶段；
- Process Check access ledger；
- casebook/采纳账本；
- zstd frame 尾读；
- AI Judge 稳定性；
- 基于观测决定 Worker pool。

## 验收矩阵

| 领域 | 必测场景 |
| --- | --- |
| Surface | 缺 marker、非法 metadata、tool result 改 identity、system head、developer header、tool addition |
| Image offload | 多 target、连续 offload、越界、已 offloaded、shadowed、tool-result 顶层、嵌套契约待定 |
| Coverage | unknown、raw-only、unsupported、relation-only、folded semantic failure |
| Facts | capability unavailable、projection gap、not applicable、Agent failure 分离 |
| Run identity | 改 Gold、Target、contract、context；只改 evaluator build |
| Metrics | pass/fail/warning、N/A、insufficient、error 的分母和方向 |
| Requirement | 单消息多要求、约束、验收、局部替代、部分完成 |
| Chain | “继续”但未承接、合法改道、用户纠错、客观遗漏 |
| Calibration | pool hash、固定 seed、group split、sealed independent、Reviewer 隔离 |
| Agreement | 分 criterion verdict/attribution、Requirement、Chain、CI 和类别分布 |
| Incremental | 每个 append cut 对比完整 replay、淘汰回退、seq gap、replacement |
| Delta | no-op、upsert/delete/reorder、facet change、revision 过期 |
| Format | v0/v1/v2/v3/v4/future/corrupt、源文件 hash 不变 |
| Performance | p50/p95、queue wait、clone/payload、RSS、cache versions、冷/热路径 |
| Privacy | home/path/token/raw/searchText/symlink、文件权限、外部 Run 不可信输入 |

## 预计文件影响

如果按上述顺序实施，主要影响：

| 模块 | 预计调整 |
| --- | --- |
| `src/projector.ts` | surface transition validator、静态 reducer、coverage 语义 |
| `src/types.ts` | fragment/order、format status、criterion fact dependency |
| `server/sources/dsh.ts` | generation 发现、状态、可选只读 migration |
| `server/projection-worker*` | watermark、changed facets、增量估重和观测 |
| `server/api.ts` | fragment delta、order ops、轻量 revision |
| `src/evaluation-types.ts` | dataset/gold/build/contract identity、metric/diff/gate |
| `src/trajectory-evaluation.ts` | coverage gate、原子 Requirement、lineage Chain |
| `server/evaluation/runner.ts` | 双比较模式、exact/confusion/direction-aware diff |
| `server/evaluation/calibration.ts` | 冻结 pool、抽样/split、agreement 细分；建议拆模块 |
| `server/evaluation/process-check.ts` | access ledger 和 Run adapter |
| `src/components/EvaluationCenter.tsx` | Prepare/Annotate/Adjudicate/Run-Diff-Gate |
| 专项测试/benchmark | 上游 fixture 差分、真实格式 fixture、增量和性能用户路径 |

`server/evaluation/calibration.ts` 当前同时承担匿名化、抽样、manifest、privacy audit、
annotation parsing、agreement、adjudication 和 dataset 编译。实施 P1 时建议按职责拆为纯
模块，但不要把“拆文件”与统计语义变化混成一次不可核查的大重构。

## 风险与取舍

1. **本地基线未形成 commit**：报告能描述当前工作区，不能保证未来按 SHA 复现全部评测代码。
2. **固定上游不是自动同步**：Harness 升级后，需要重新审查 event vocabulary、surface 和
   migration，不应只更新快照字符串。
3. **多来源不可完全同构**：criterion 级 capability/fact contract 比补假字段更可靠。
4. **真实 Gold 尚未完成**：全量测试通过只能证明内部合同自洽，不能证明规则对生产轨迹准确。
5. **历史迁移成本可能很高**：V3→V4 还需要直属子 Session 证据；先让会话可见，再由需求决定。
6. **增量化会扩大状态空间**：每个 cut 必须与完整 replay 差分，错误时能回退 snapshot。
7. **性能预算不可照搬上游**：应复用方法，不复制 Harness 的机器和产品预算。
8. **嵌套 image/offload 尚无清晰事实**：上游注释与实现不一致，需先确认正式消息 schema。

## 验证结果

在当前工作区基线上已执行：

| 命令 | 结果 |
| --- | --- |
| `npm test` | 45 个测试文件、345 项测试全部通过，5.93 秒 |
| `npm run typecheck` | 通过 |
| `npm run build` | Web 与 CLI 生产构建通过 |
| `git diff --check` | 全工作区通过 |

新增报告另以 no-index diff 检查，未发现 trailing whitespace 或冲突标记。

## 本轮交付边界

本轮只新增：

- `docs/DEEPSEEK-HARNESS-CURRENT-COMPARISON-2026-10-25.md`

本轮没有修改：

- 产品源码；
- 测试；
- 配置；
- canonical DSH/Codex/ZCode 数据；
- 外部系统；
- 用户已有未提交文件。

遗留项是本报告列出的 P0/P1/P2 优化建议，尚未实现。最先应实施的是 surface/coverage 与
评测身份统计正确性；在这些问题修复前，不宜把当前 baseline diff 当作发布硬门禁，也不宜
用合成 12-case 的通过率声称 evaluator 已完成真实 Gold 校准。
