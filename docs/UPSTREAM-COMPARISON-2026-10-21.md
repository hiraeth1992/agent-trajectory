# ZCode、DeepSeek Harness 与 Agent Trajectory 功能对比及优化建议

> 调研日期：2026-10-21
>
> 本地项目：`agent-trajectory`
>
> 上游固定版本：ZCode `3c5b227649371507ddc4eb46ac5133afe6db1cab`；DeepSeek Harness `687f282e8625c6b8d11ff58211a90524be2e4317`

> 实施状态（2026-10-22）：P0 主线已经落地，包括 DSH surface 三层视图、事件
> disposition/coverage、统一 trace/lineage/policy/task 字段、ZCode 可选能力协商，以及
> DSH 严格 Goal replay、Todo 折叠和对应 UI；surface 的 append/replace source lineage
> 已完整保留，ZCode 指纹覆盖实际投影的 usage/trace/policy/task 事实。全量 123 项测试、
> 生产构建和本机三来源只读 smoke test 均通过。P1 的完整关系下钻/因果图、更多领域
> reducer、上下文可解释性和派生全文搜索仍保留为后续工作。

## 结论摘要

本地项目已经是一套完成度较高的**只读、多来源轨迹观察器**：它统一读取 DSH、Codex
和 ZCode 的本地事实源，具备来源隔离、增量读取、投影 Worker、snapshot/delta、原始事件
懒加载、脱敏审计导出、有界缓存和安全的 opaque ID 路由。其定位与两个上游不同：
ZCode 是完整 AI 编程工作台和 Agent runtime，DeepSeek Harness 是可组合 Agent harness；
本地项目不应向“执行 Agent”方向扩张。

当前最值得优先处理的不是补齐上游所有运行能力，而是让已有持久化事实得到**语义正确、
覆盖透明、因果可追踪**的呈现：

1. **P0：正确折叠 DSH model surface。** 本地已经读取 `surfaceOp` 和
   `sourceEventSeqs`，但投影器仍按原始日志顺序生成消息。发生 compaction 或其他
   replacement 后，原消息与替换消息可能同时出现，且 transcript、模型当前上下文和
   append-only audit log 被混成一套记录。
2. **P0：把“已知事件”和“已投影事件”分开。** `goal/change`、`todo/write`、
   `approval/*`、`hook/*`、`job/*`、`deliverables/presented`、`workspace/changes`
   等事件已被列入 known set，却大多没有形成记录或状态投影；因此
   `unknownEventTypes` 为空并不代表轨迹完整。
3. **P0：保留 ZCode 已经落库的因果与风险字段。** 当前适配器只查询六张核心表中的一组
   基础列，裁掉了 `trace_id`、`span_id`、`logical_request_id`、`parent_id`、
   工具副作用/审批属性，以及子会话、目标、Todo 等表。应以可选 capability probe
   渐进读取，而不是把所有新增字段加入硬门禁。
4. **P1：从固定三泳道升级为“时间线 + 因果图 + 会话谱系”。** 统一记录应能表达
   trace/span、父子会话、replacement/source、审批与工具、子代理与工具镜像等关系。
5. **P1：增加领域投影、可解释性和派生搜索索引。** Goal、Todo、审批、交付物、
   工作区变更等适合独立 reducer；上下文和 cache 只能展示来源真实记录的事实，缺失时
   明示 observation gap；跨会话搜索应使用独立、可重建的派生库，不写入来源数据库。

## 调研边界与方法

- 仅比较官方仓库源码和本地实现，不依据产品宣传或第三方文章。
- 上游结论固定到上述 commit，避免默认分支继续变化后引用失真。
- 本报告讨论的是“本地项目能从已持久化事实中观察什么”，不是要求本地项目复制上游
  runtime。
- 本地回归结果：13 个测试文件、123 个测试全部通过；生产构建通过；本机最新 DSH、
  Codex、ZCode 会话只读 smoke 均通过且 `unknownEventTypes = 0`。说明当前工程基础
  稳定，本报告提出的是下一阶段语义和产品能力优化，不是对现有可靠性的否定。
- 成本使用 `S / M / L` 表示相对复杂度，不代表具体人日。

## 三个项目的定位

| 项目 | 核心定位 | 权威事实源 | 是否负责执行/修改 Agent | 对本地项目的主要参考价值 |
| --- | --- | --- | --- | --- |
| Agent Trajectory | 独立、只读的多来源轨迹查看器 | DSH JSONL/Zstd、Codex rollout JSONL、ZCode SQLite | 否 | 跨来源统一、审计、安全和观察体验 |
| ZCode | 桌面/Web/TUI AI 编程工作台，包含 Agent CLI 与 runtime | Session SQLite、事件日志、结构化日志及运行时状态 | 是 | trace/span、权限与副作用、子代理、上下文/cache 诊断、丰富调试泳道 |
| DeepSeek Harness | everything-is-a-plugin 的 Agent harness | append-only Session event log、model surface、领域 projection | 是 | surface 语义、事件溯源、会话谱系、projection registry、独立搜索索引 |

官方定位证据：

- [ZCode README：AI 编程工作台及 Agent CLI/runtime](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/README.md)
- [DeepSeek Harness README：开源 Agent harness 和插件架构](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/README.md)
- [本地 README：独立、只读、多来源轨迹查看器](../README.md#agent-trajectory)

## 功能矩阵

| 能力 | Agent Trajectory 当前状态 | ZCode | DeepSeek Harness | 判断 |
| --- | --- | --- | --- | --- |
| 多来源统一查看 | 原生支持 DSH、Codex、ZCode | 主要围绕自身 runtime | 主要围绕自身插件生态 | 本地优势，应继续保持 source-specific adapter + unified read model |
| 只读与安全边界 | loopback、opaque ID、来源库只读、递归脱敏 | runtime 本身可执行和写入 | runtime 本身可执行和写入 | 本地核心边界，不应为了功能对齐而放宽 |
| Append-only 审计 | 能读取并按记录导出 raw | 有 Session event 和 SQLite 事实 | Session log 是权威来源 | 已有好基础，但 DSH raw log 与 surface 尚未分层 |
| 人类 transcript | 用户/助手对话视图 | 有消息模型 | append-origin surface event 是 durable transcript 材料 | 本地 DSH 对话视图尚未显式限定 append-origin |
| 模型当前上下文 | 未实现 DSH replacement fold | 可从上下文快照/消息状态观察 | `foldSurface()` 计算 current surface | 本地最重要的语义缺口 |
| current/shadowed/log-only | 无 | 可通过事件/消息状态部分追踪 | 查询模型明确区分三态 | 建议进入统一记录元数据和筛选器 |
| 事件溯源 | `sourceEventIds`、`fidelity` | trace/span/toolCall 等 | replacement、source、derived event trace | 本地已有 provenance 起点，缺关系类型和链式下钻 |
| Trace/span 因果关系 | 主要只有 `callId/parentCallId` | `traceId/spanId/parentSpanId`，多泳道 Gantt | event/source/replacement 与 session lineage | 统一模型过平，难以解释跨轮次和跨会话因果 |
| 父子会话/子代理 | DSH 只保留部分 header；ZCode 未读相关表 | `parent_id`、`session_task_link`、工具镜像 child session | `parentSession`、seed cut、origin、delegation depth | 应做 session lineage，而非把所有子代理压在单会话时间线 |
| Goal/Todo/计划 | known 但 DSH 多数不投影；ZCode todo/target 未读 | SQLite 有 target、todo 等表 | 领域事件 + projection registry | 高价值的“任务为何这样执行”信息被静默丢失 |
| 权限/风险/副作用 | DSH approval 主要只计数；ZCode 字段未读 | permission events；tool usage 有只读、破坏性和审批状态 | approval/policy/preset 事件 | 适合作为 policy/control facet，不应支持从本地项目反向审批 |
| 上下文与 cache 可解释性 | 仅总 Token、TTFT 等聚合 | context usage、prompt cache report，并明确观测缺口 | surface 可还原模型历史，projection 可提供状态 | 只展示来源事实和置信度；无数据时不推断 |
| 跨会话全文搜索 | 当前只对已加载会话做前端搜索 | 工作台内部检索能力 | 独立 SQLite FTS5，支持过滤、分页、stale cursor | 本地多来源定位很适合增加独立派生索引 |
| 增量/大轨迹 | 增量读取、共享 Worker、delta、有界 LRU | runtime/debug 内部按自身需求优化 | projection checkpoint、增量 reconciliation | 本地已有较强基础，可进一步加领域 checkpoint |
| 可扩展泳道 | 固定 input/model/tools 三泳道 | turn/model/tool/permission/subagent/network/storage/event/log | 事件和领域插件可扩展 | 先扩统一语义，再扩 UI，避免仅堆泳道 |

## 本地项目已经做得好的部分

以下能力不需要因对比上游而推倒重来：

1. **多来源契约和来源隔离。** 三种来源经独立 adapter 进入统一 `SessionDetail`，来源失败
   不互相拖累，无法证明的关联 fail closed。
2. **读取性能和网络协议。** DSH/Codex 支持安全增量读取，ZCode 使用只读 SQLite
   Worker；详情支持稳定 record ID 的 snapshot/delta，适合运行中记录更新和删除。
3. **审计与 provenance。** 每条记录保留 `source`、`sourceEventIds` 和 `fidelity`；
   raw 按需加载，完整审计导出经过脱敏。
4. **安全边界明确。** 仅绑定 loopback，校验 Host 和远端地址，客户端不能提交任意本地
   路径，不读取凭据类文件，不修改 canonical store。
5. **工程质量。** 有界缓存、SSE 防重入、前端请求竞态处理、匿名生产形状 fixture、
   10 万事件性能门禁和三来源回归，为继续扩展投影语义提供了可靠基础。

这些能力可从 [本地 README 的“已实现”与“安全边界”](../README.md#已实现) 复核。

## 关键差距与证据

### 1. DSH `surfaceOp` 被读取，但没有进入投影语义

本地 `SessionEvent` 已声明 `surfaceOp` 和 `sourceEventSeqs`
（[类型定义](../src/types.ts#L46-L57)），说明适配器没有把字段完全丢掉；但
`projectTrajectory()` 对排序后的 raw events 做两轮线性遍历，消息事件直接加入
`messageEvents`，之后全部生成 record
（[主循环](../src/projector.ts#L534-L669)）。代码中没有 current surface 节点集合、
replacement range splice 或 shadowed 状态。

DeepSeek Harness 的官方语义不是“所有消息事件都组成一条对话”：

- append-only log 始终是审计权威；
- append-origin surface event 是人类 transcript 的 durable source material；
- replacement copy 只服务模型上下文，不能反过来擦除用户已经看过的对话；
- `foldSurface()` 遇到 replacement 时，将当前 surface 的一段节点替换成新事件；
- 查询层把每个事件分类为 `current`、`shadowed` 或 `log-only`，并暴露
  `replacedBy/replacementChain/replacedEventSeqs/sourceEventSeqs/derivedEventSeqs`。

对应官方源码：

- [append-origin 与 replacement 的用途](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/surface.ts#L78-L105)
- [replacement 的 splice 与完整 surface fold](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/surface.ts#L549-L608)
- [surface 三态与事件关系 trace](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session-query/session-query/src/types.ts#L23-L24)
- [replacement/source/derived 关系字段](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session-query/session-query/src/types.ts#L105-L127)

当前影响：

- compaction 或 rewrite 后，原消息和替换消息可能同时显示；
- “用户实际看过的对话”与“模型下一次请求看到的上下文”无法分别回答；
- 检查器看得到 raw 字段，却无法解释一条消息为何仍 current、被谁 shadow、由哪些原事件
  派生；
- 将来做上下文占用分析时，输入集合会从根上选错。

正确目标应是三层视图，而不是从 raw log 中删除旧事件：

```text
Append-only raw log
├── Transcript：append-origin message events
├── Model context：应用 replacement 后的 current surface
└── Audit：全部事件 + current/shadowed/log-only + replacement/source edges
```

### 2. “已知事件”不等于“已投影事件”

本地 `KNOWN_EVENT_TYPES` 包含 60 余种事件
（[known set](../src/projector.ts#L22-L86)），但真正生成主要展示记录的分支集中在：

- system/user/developer message；
- turn/step 和 assistant attempt/message/retry；
- tool call/result 和 PTC subtool；
- compaction。

投影分支可从 [事件处理循环](../src/projector.ts#L576-L656) 和
[最终 records 组成](../src/projector.ts#L659-L669) 复核。

因此以下已经落盘的事实通常只增加 `eventTypeCounts`，不会进入 UI 语义：

| 领域 | 代表事件 |
| --- | --- |
| 任务状态 | `goal/change`、`todo/write`、`plan/mode` |
| 权限与策略 | `approval/asked`、`approval/decided`、`approval/policy`、`permission/preset`、`sandbox/mode` |
| 自动化与扩展 | `hook/invoked`、`hook/result`、`job/registered`、`job/settled` |
| 交付与变更 | `deliverables/presented`、`workspace/changes` |
| 多 Agent | `subagent/*`、`team/*` |
| 配置与状态 | `model/selection`、`working-directory/change`、`schedule/change` |

这比 unknown event 更隐蔽：`unknownEventTypes` 只检查事件是否在 known set
（[统计逻辑](../src/projector.ts#L576-L579)），所以页面可以显示“没有未知事件”，同时
静默遗漏用户最关心的目标、审批和交付事实。

DeepSeek Harness 对这类状态采用独立 projection definition：每个领域有自己的 schema、
初始状态和同步 fold，并通过统一 `asOfSeq` 提供一致快照；还可持久化 checkpoint 避免
冷读全量 replay：

- [Projection registry 的用途和 reducer 契约](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-projection/README.md#L27-L69)
- [Goal 以完整 durable snapshot 事件做严格 replay](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/goal/goal/README.md#L97-L100)

本地不必复制其插件框架，但应借鉴“每个领域显式声明如何消费事件”的契约。

### 3. ZCode 的高价值持久化字段在查询时被裁掉

本地 ZCode worker 把以下六张表及其选定列作为硬 schema 门禁：

`session`、`message`、`part`、`model_usage`、`tool_usage`、`turn_usage`
（[REQUIRED_TABLES/REQUIRED_COLUMNS](../server/sources/zcode-worker.ts#L4-L88)）。

当前 SELECT 主要读取消息、part、基础状态、计时、Token、重试和错误
（[usage 查询](../server/sources/zcode-worker.ts#L351-L370)）。这能支持当前时间线，却没有
利用官方 schema 已经保存的：

- `session.parent_id`、`session.trace_id`；
- `model_usage.trace_id/span_id/logical_request_id/attempt_index/query_source`；
- `tool_usage.trace_id/side_effect_scope/read_only/destructive/approval_status`；
- `turn_usage.trace_id/model_request_count/model_retry_count/tool_call_count/tool_error_count`；
- `session_entry`、`session_input`、`session_task_link`、`session_target`、`todo`；
- workflow run/activity 等更完整的层级事实。

固定版本的官方 schema 证据：

- [session、model_usage 与因果字段](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/adapters/src/storage/session-store/schema.baseline.sql#L101-L184)
- [session_input、target、task link 与 todo](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/adapters/src/storage/session-store/schema.baseline.sql#L195-L251)
- [工具副作用/审批和 turn 聚合](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/adapters/src/storage/session-store/schema.baseline.sql#L253-L310)

不建议简单地把所有字段加入 `REQUIRED_COLUMNS`。本地当前的 fail-closed 门禁能防止错误
解释未知 schema，但如果把可选诊断表也设为必需，旧版 ZCode 数据库会从“缺少 lineage”
退化成“整个来源 blocked”。更合适的是：

```text
核心读取能力
  message + part + 基础 usage
  缺失 -> blocked

可选能力探针
  trace / lineage / policy / target / todo / workflow
  单项缺失或漂移 -> 仅该 capability degraded
```

### 4. 统一模型能表达树状工具调用，但不能表达完整因果图

本地 `TrajectoryRecord` 已有 `callId`、`parentCallId`、`sourceEventIds` 和 `fidelity`
（[统一记录类型](../src/types.ts#L99-L137)），适合表达单会话内的工具树；但没有：

- `traceId/spanId/parentSpanId`；
- `sessionParentId/childSessionId`；
- `relation` 的类型，如 `replaces`、`derived-from`、`approved-by`、`spawned`；
- surface placement；
- “来源明确记录”与“本地启发式关联”的字段级置信度。

同时 `TimelineLane` 被限定为 `input/model/tools`
（[泳道类型](../src/types.ts#L139-L142)），三种 projector 也都要压进固定视觉结构。

ZCode 的调试分析器以 trace 为单位构造 turn、model、tool、permission、subagent 等 span，
并保留 span 父子关系：

- [Trace Gantt 的 turn/model/tool/permission/subagent 配对](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/debug/server/analyzer.ts#L424-L480)
- [Timeline/TraceSpan 的因果字段和扩展泳道](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/debug/src/shared.ts#L33-L79)

其协议还定义了 steering、permission、checkpoint、rewind、stream recovery，以及子代理工具
镜像中的 child session 关系：

- [Session event 类型](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/shared/src/zcode-protocol/index.ts#L1459-L1485)
- [子代理工具关系和 permission payload](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/shared/src/zcode-protocol/index.ts#L1666-L1773)

DSH 则在 session header 记录 `parentSession`、seed、subagent origin 和 delegation depth
（[SessionHeader lineage](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/types.ts#L95-L131)），
查询层提供祖先和完整后代树
（[SessionLineageTrace](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session-query/session-query/src/types.ts#L74-L103)）。

本地 DSH `SessionHeader` 目前有 `isSeeded/delegationDepth`，但缺少 `parentSession/origin`，
最终 `TrajectorySessionHeader` 还会进一步只保留基础字段。这使跨会话结构在进入 UI 前就
不可恢复。

### 5. 上下文解释和检索应基于“已观察事实”，而不是估算成真相

ZCode 调试代码能展示 context usage category、工具、skill 和 message breakdown；如果
SQLite 只有聚合 input token，就明确标记低置信度并附带观测限制，而不是伪造拆分：

- [context usage 分类及置信度](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/debug/server/analyzer.ts#L721-L776)
- [只有 SQLite 聚合数据时的 low-confidence fallback 和 warning](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/debug/server/analyzer.ts#L779-L823)
- [缺 context/cache 事实时生成明确的 observation request](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/debug/server/analyzer.ts#L1149-L1199)

这对本地项目尤其重要：不同来源持久化粒度不同，不应为了统一面板把估算值伪装成同等精度。

DeepSeek Harness 的搜索实现也提供了适合本地项目的边界：FTS5 放在独立派生数据库，
不修改 session persistence store；支持跨会话/会话内搜索、metadata/surface 过滤、
cursor pagination，并在相关 corpus 变化时令 cursor stale：

- [搜索能力与独立派生库](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session-query/session-query-sqlite/README.md#L25-L67)
- [派生索引、generation-bound cursor 和安全查询原则](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session-query/session-query-sqlite/README.md#L83-L108)

## 分级优化建议

### P0：先修正语义与数据覆盖

#### P0-1：实现 DSH surface fold，并提供三种明确视图

- **收益：** 修正 compaction/replacement 后的上下文语义；同时准确回答“用户看过什么”、
  “模型当前看到什么”和“日志实际记录什么”。
- **实现方向：**
  1. 在 DSH projector 前增加独立 `foldSurface(events)`，输出 current seq、有序
     replacement、shadowed set、source/derived edges。
  2. transcript 只取 append-origin message；model-context 按 current surface 顺序；
     audit 保留全部事件。
  3. 给记录增加 `surface: current | shadowed | log-only | append-origin` 或拆成
     `surfacePlacement` 与 `transcriptOrigin` 两个字段，避免一个枚举混合两个维度。
  4. replacement 校验失败应让该会话明确 degraded/blocked，不允许静默退回线性消息。
- **成本/风险：** `M`。主要风险是误解 DSH 的合法 replacement 约束，以及 delta 更新时
  一次 replacement 会改变多条旧记录的状态和顺序。
- **验收标准：**
  - 构造 append → replace → replace chain fixture，current surface 与 DSH 官方 fold
    结果一致；
  - transcript 不因 replacement 丢失 append-origin 对话；
  - audit 能从任一 shadowed event 下钻到最终 replacer，并反查 source/derived；
  - revision delta 正确发送旧记录状态变更、增删和重排；
  - 非 replacement 会话的现有展示和性能不回退。

#### P0-2：建立事件 disposition/coverage 契约

- **收益：** 让“读到了但没有展示”的数据缺口可见，避免 `unknownEventTypes = []` 带来
  错误完整感。
- **实现方向：**
  1. 每个来源维护显式 disposition registry：
     `record | folded-state | relation-only | raw-only | unsupported`。
  2. `KNOWN_EVENT_TYPES` 只负责格式兼容；是否被消费由 registry 单独声明。
  3. 投影结果增加 `coverage`：按事件类型统计 total、consumed、disposition 和 gap reason。
  4. 会话头展示“已消费 N/M 类事件、K 条 raw-only/unsupported”，并允许筛选。
- **成本/风险：** `S-M`。风险是 coverage 指标定义不清；同一事件可能既生成 record 又
  驱动 state，应允许多个消费用途，但只能有一个面向用户的主 disposition。
- **验收标准：**
  - known 事件若没有 registry 条目，测试直接失败；
  - 每条输入事件都能解释其消费去向；
  - fixture 中 goal/todo/approval 即使尚未做领域 UI，也明确显示为 raw-only gap；
  - unknown、unsupported、raw-only 三者在 API 和 UI 中可区分。

#### P0-3：扩展统一模型的因果、谱系和 surface 字段

- **收益：** 为 trace、子代理、审批、replacement 和跨会话下钻提供稳定的 API 基础，
  避免后续每增加一个视图就修改三套来源特例。
- **实现方向：**
  - header：`parentSessionId`、`origin`、`delegationDepth`、`traceId`；
  - record：`traceId`、`spanId`、`parentSpanId`、`sessionId`、`childSessionId`；
  - relation：`type/from/to/fidelity/sourceEventIds`，支持
    `parent-span/replaces/derived-from/approved-by/spawned/mirrors`；
  - surface 和 coverage 使用独立 facet，不继续膨胀 `RecordKind`；
  - 每个派生关系标记 `exact | derived`，不能把时间相邻当作确定因果。
- **成本/风险：** `M`。风险是 API 变更影响 snapshot/delta digest、缓存权重和前端 hydrate。
- **验收标准：**
  - DSH parentSession、ZCode parent_id/trace_id 能原样贯通 API；
  - exact 与 derived relation 在 Inspector 中有明确标识；
  - 同一 trace 下能按 parent span 构造无环图；坏引用形成 gap，不被猜测修复；
  - 旧来源没有这些字段时仍正常展示。

#### P0-4：ZCode 核心门禁与可选 capability negotiation 分层

- **收益：** 在不牺牲当前 fail-closed 安全性的前提下，读取新版本中的 trace、审批、
  副作用和领域事实，并兼容旧数据库。
- **实现方向：**
  1. 保留当前消息、part 和基础 usage 的 core schema gate；
  2. probe `PRAGMA table_info` 后形成 feature matrix，如
     `trace/lineage/policy/target/todo/workflow`；
  3. SQL 只引用已确认存在的列/表，可按 feature 使用独立 statement；
  4. `SourceStatus` 返回精确 capability 与降级原因，单一 optional feature 漂移不阻断
     整个 ZCode 来源。
- **成本/风险：** `M`。动态列组合不能拼接用户输入，只能从代码内白名单选择；同时要
  防止多个 schema 版本产生语义同名但含义不同的字段。
- **验收标准：**
  - 当前六表 fixture 仍 available；
  - 新 schema fixture 能读取 trace、parent、policy 等字段；
  - 分别删除一个可选表/列，只降级对应 feature；
  - 删除核心表/列仍精确 blocked；
  - SQLite 始终以 read-only 打开，所有值参数仍绑定。

### P1：增加领域理解和跨会话导航

#### P1-1：按领域拆分投影 reducer

- **范围：** `goal/todo/plan`、`approval/policy/sandbox`、`hook/job`、
  `deliverable/workspace-change`、`subagent/team`。
- **收益：** 用户能看到任务状态如何变化、何时等待审批、哪些产物被声明，以及工作区
  发生了什么，而不只是模型和工具的流水账。
- **实现方向：** 采用轻量 projector registry，每个定义声明输入事件、state version、
  `apply()`、wire view、coverage disposition；API snapshot 带统一 `asOf` 水位。
- **成本/风险：** `M-L`。来源间只有语义相似而非 schema 相同，应保留 source-native
  payload，统一的是 facet，不是强行抹平差异。
- **验收标准：** reducer replay 幂等；同一 seq 的各 facet 使用一致 cut；非法状态迁移
  显示 gap；新增领域不要求修改单个超大 switch。

#### P1-2：增加 session lineage 与 trace 下钻

- **收益：** 能回答“这个子 Agent 谁创建的”“该工具调用属于哪个模型请求”“审批阻塞了
  哪段执行”和“一个任务跨了哪些会话”。
- **实现方向：** 会话列表增加树/面包屑；详情支持按 trace 聚合；点击 child session 或
  span 在保持筛选上下文的情况下跳转；无法加载的 parent 显示 unresolved node。
- **成本/风险：** `M`。跨来源不应仅凭 cwd 或标题自动合并；只有稳定 ID 或来源明确记录
  的关系才是 exact。
- **验收标准：** DSH 和 ZCode fixture 都能构造父子树；循环/悬空引用被检测；跨会话导航
  不泄露本地路径或 canonical session ID 到不必要的客户端位置。

#### P1-3：提供“可扩展时间线 + 因果图”双视图

- **收益：** 时间线适合看顺序和耗时，图适合看并行、父子、替换和跨会话关系；两者无需
  互相妥协。
- **实现方向：** lane ID 改为可扩展 token；优先支持
  input/model/tool/control/agent/artifact，再按 capability 显示；关系图只使用统一
  relation model。
- **成本/风险：** `M-L`。大量 span 的图必须虚拟化或按 trace/turn 裁剪。
- **验收标准：** 旧三泳道默认体验不退化；permission/subagent 只在有事实时出现；1 万
  record 会话的交互仍在既有性能预算内。

#### P1-4：上下文、Token 与 prompt cache 可解释面板

- **收益：** 从“花了多少 Token”提升为“Token 花在哪里、数据精度是什么、还缺什么”。
- **实现方向：** 每个指标携带 `method/confidence/source/warnings`；DSH model context
  使用正确 surface；ZCode 只在字段存在时展示 category/cache；聚合值不能假装逐文本
  cache 命中。
- **成本/风险：** `M`。跨 provider 的 token 定义不完全相同，不能直接比较成统一精确值。
- **验收标准：** full/metadata/aggregate/unavailable 四种观测级别清晰；来源无数据时显示
  gap；任何估算值均有 method 和 confidence。

#### P1-5：增加独立派生全文搜索索引

- **收益：** 支持跨来源、跨会话检索消息、工具、错误、目标和交付物，并可按来源、时间、
  event type、surface、状态过滤。
- **实现方向：** 单独 SQLite FTS5 数据库；使用脱敏后的可检索文档；以来源 fingerprint/
  revision 增量 reconcile；cursor 绑定标准化请求和 generation；索引可删除重建。
- **成本/风险：** `M-L`。需要明确定义索引是否允许持久保存会话正文，以及文件权限和
  清理策略；默认不能把未脱敏 raw 写入派生库。
- **验收标准：** 不打开 canonical DB 写权限；新增、更新、删除会话都能收敛；cursor 在
  相关 corpus 变化时 stale；索引删除后可完整重建；搜索结果保持 provenance。

### P2：规模化、维护性与分析能力

| 项目 | 收益 | 实现方向 | 验收重点 |
| --- | --- | --- | --- |
| Usage/reliability 聚合 | 比较模型、工具、错误、重试、TTFT、截断和审批等待 | 由统一 facet 聚合，始终可下钻到来源记录 | 聚合不重复计数；不同 token 口径有说明 |
| Projection checkpoint | 降低大 DSH 会话冷启动和领域 reducer replay 成本 | 每个 reducer 以 stateVersion + source revision + seq 保存可丢弃 checkpoint | 版本不匹配自动重建；绝不写 canonical store |
| Compatibility fixtures | 抵御 DSH event 和 ZCode schema 漂移 | 固定多个上游版本的最小匿名 fixture 与 capability 预期 | 加列兼容；删/改核心字段 fail closed；可选能力单项降级 |
| Projector registry 重构 | 避免 `projector.ts` 和来源 projector 继续膨胀 | message/tool/usage/domain/relation 分离，统一 disposition | 新增事件无需修改无关 reducer；性能不回退 |
| 轨迹对齐与差异比较 | 比较同任务不同模型/Agent 的路径、成本和失败点 | 先按明确 turn/tool/goal anchor 对齐，低置信度匹配单独标识 | 不把文本相似度当确定因果；支持回到原记录 |

## 建议的数据模型增量

以下是方向草案，不要求一次完成：

```ts
type EventDisposition =
  | 'record'
  | 'folded-state'
  | 'relation-only'
  | 'raw-only'
  | 'unsupported'

type SurfacePlacement = 'current' | 'shadowed' | 'log-only'

interface TrajectoryRelation {
  type:
    | 'parent-span'
    | 'replaces'
    | 'derived-from'
    | 'approved-by'
    | 'spawned'
    | 'mirrors'
  from: string
  to: string
  fidelity: 'exact' | 'derived'
  sourceEventIds: string[]
}

interface ProjectionCoverage {
  type: string
  total: number
  consumed: number
  disposition: EventDisposition
  reason?: string
}
```

需要注意两个建模边界：

1. `surface` 是 DSH 的来源事实，不应强迫 Codex/ZCode 伪造三态；其他来源没有等价事实时
   字段缺省。
2. `RecordKind` 适合决定主要展示形式，goal、approval、artifact、lineage 等更适合 facet
   或 relation；继续把所有概念塞进一个枚举会让跨来源统一模型失去深度。

## 推荐实施顺序

```text
DSH surface correctness
        ↓
event disposition + coverage
        ↓
causal/lineage/relation data model
        ↓
ZCode optional capabilities
        ↓
domain reducers + lineage/trace UI
        ↓
context explainability + derived search
        ↓
analytics/checkpoint/comparison
```

第一阶段结束时，即使还没有 Goal 卡片或搜索功能，系统也应该能诚实回答：

- 哪些事件被完整投影；
- 哪些只用于状态 fold；
- 哪些只在 raw audit 中存在；
- 哪些来源能力因 schema 或持久化缺口不可用；
- DSH transcript、model context 和 audit 各自由哪些事件组成。

这是后续所有可视化和分析可信的前提。

## 不建议照搬的上游能力

1. **不把本项目变成可写 Agent runtime。** 不接入工具执行、权限决策、会话修改、fork
   写入或模型调用。
2. **不复制整个 Cordis/plugin 架构。** 可以借鉴 projection definition 和 capability
   seam，但当前三来源观察器不需要上游完整生命周期框架。
3. **不复制 ZCode 整套工作台。** 编辑器、远程 workspace、checkpoint 恢复操作和产品级
   UI plugin 不属于轨迹查看器职责。
4. **不默认采集完整 prompt、HTTP headers、网络 MITM 或远程 telemetry。** 可解释性功能
   只能读取用户已经置于范围内且来源已持久化的事实。
5. **不向上游 canonical DB 写索引或 checkpoint。** 搜索和投影缓存必须是独立、可丢弃、
   可重建的派生数据。
6. **不以“统一”为由抹平来源差异。** 字段缺失应表现为 capability/gap，不应用推断值
   冒充来源事实。
7. **不破坏当前安全边界。** loopback、opaque ID、只读数据库、递归脱敏和来源隔离应作为
   所有新增功能的验收前置条件。

## 最终判断

Agent Trajectory 的差异化价值不是比 ZCode 或 DeepSeek Harness 更会“运行 Agent”，而是
以统一、安全、可审计的方式解释不同 Agent 已经发生了什么。当前底层的读取、缓存、增量
协议和安全工程已经足够扎实；下一步应该把投入集中到：

1. 语义正确的 surface/transcript/audit 分层；
2. 可度量的投影覆盖率；
3. 因果、谱系和领域状态；
4. 对来源能力与观测缺口的诚实表达；
5. 在只读边界内实现跨会话检索和比较。

按这一方向推进，本地项目会从“统一日志时间线”升级为“可信的跨 Agent 行为解释层”，同时
保留其相较两个上游最清晰的产品边界。
