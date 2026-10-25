# Agent Trajectory 与 DeepSeek Harness 底层实现对比

> 调研日期：2026-10-24
>
> 本地基线：`d5a7f952bf8b41d5fe3090952512b4ee8fa180ff` 加当前工作区未提交改动
>
> 上游固定版本：DeepSeek Harness
> [`22ddee3792402c3e70ec5f86a63c3e3e895a2f60`](https://github.com/deepseek-ai/deepseek-harness/tree/22ddee3792402c3e70ec5f86a63c3e3e895a2f60)

> 2026-10-25 实施更新：P0 `image/offload` 消息投影、持久事件词表同步门禁、
> `assistant/live-chunk` 修正、turn 一次分组、Registry 同会话 single-flight 和 Codex
> 有界探测分级已完成。本文主体保留开发前差距与验收口径，不能再把这些条目视为当前缺口。

## 结论

当前项目不需要复制 DeepSeek Harness 的 Cordis 或“everything-is-a-plugin”架构。两者职责
不同：Agent Trajectory 是只读、多来源观察器，DeepSeek Harness 是完整 Agent runtime。
当前项目已有的来源隔离、Worker、LRU、snapshot/delta、脱敏和安全路由也没有推倒重来的
必要。

但底层仍有明确的优化空间，优先级如下：

| 优先级 | 建议 | 类型 | 核心原因 |
| --- | --- | --- | --- |
| P0 | 正确解释 DSH `image/offload` 消息投影 | 正确性 | 当前把会改变模型可见消息内容的事件当成 `raw-only` |
| P0 | 从上游持久事件词表移除 `assistant/live-chunk` 并建立同步门禁 | 兼容性 | 它是客户端瞬态事件，不是持久 Session event；当前会错误放行 |
| P1 | 把“增量读取”升级为端到端增量投影 | 性能/架构 | Worker 收到追加事件后仍全量 replay，并完整回传 projection |
| P1 | 修复 turn 汇总的重复全表扫描 | 性能 | 每个 turn 都执行一次 `records.filter`，存在 `O(turns × records)` 路径 |
| P1 | 让 API delta 真正按变化规模传输 | 性能 | 每次 delta 仍返回完整 projection 元数据和完整 `recordOrder` |
| P1 | 为 `SourceRegistry.load()` 增加同会话 single-flight | 并发/资源 | 并发 API、raw、导出、AI 请求可重复解析和投影同一版本 |
| P1 | 发现并明确报告历史 DSH generation | 兼容性/可观测性 | 当前只扫描 V4，旧会话会从列表中静默消失 |
| P2 | 利用独立 Zstd frame 做压缩日志尾部增量读取 | 性能 | 上游每批追加一个独立 frame，当前每次变化都整文件解压 |
| P2 | 重构投影记录缓存和缓存估重 | 内存/CPU | 旧 record 版本不替换；多层缓存反复 `JSON.stringify` 整份对象 |
| P2 | 为共享投影 Worker 增加排队观测，必要时再引入小型池 | 响应性 | 单 Worker 的同步投影会串行阻塞其他来源，但当前尚缺真实负载证据 |

前两项是源码能够直接确认的语义问题；P1 项是源码可以证明的复杂度或并发问题；P2 项应先
补基准再决定是否实施。

## 对比边界

本报告比较的是“如何可靠、增量地读取和解释 DeepSeek Harness 已持久化的 Session”，不
比较模型调用、工具执行、审批决策、沙箱、Agent loop 或插件热加载。后者属于 Harness
runtime，不属于只读查看器的职责。

本地已有报告
[`UPSTREAM-COMPARISON-2026-10-21.md`](./UPSTREAM-COMPARISON-2026-10-21.md)
提出的 surface 三层视图、事件 disposition/coverage、lineage、Goal/Todo 和 ZCode 可选
能力，在当前工作区中大多已经落地。本报告只保留仍然存在或由最新上游实现新暴露出来的
差距。

## 当前实现已经做对的部分

### 1. 来源边界与安全模型清晰

当前项目用独立 adapter 把 DSH、Codex、ZCode 投影到统一只读模型，并保持 loopback、
opaque session ID、只读 SQLite、递归脱敏和来源故障隔离。这些是产品差异化能力，不应
因参考 Harness 而放宽。

### 2. DSH surface replacement 已有正确方向

当前 `foldSurface()` 已维护 current/shadowed 节点和 replace/derived 关系，并将 transcript、
model context 与 audit 分开：

- [本地 surface fold](../src/projector.ts#L460)
- [本地 transcript/model-context 选择](../src/projector.ts#L1151)

这与 Harness 的位置替换语义一致，不需要重新设计：

- [上游完整 fold 与增量 SurfaceManager](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/session/src/surface.ts#L509-L608)
- [上游增量推进逻辑](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/session/src/surface.ts#L611-L695)

### 3. 读取层已经能识别安全追加

未压缩 DSH 和 Codex 已按 byte offset 读取追加部分，并在边界签名、连续 seq 或格式校验
失败时回退完整快照。问题不在文件读取入口，而在后续投影、跨线程返回和 API 传输仍然全量。

### 4. 事件覆盖透明度已经建立

当前把事件分为 `record / folded-state / raw-only / unsupported`，并输出 coverage，不再
用“没有未知事件”代表“完整投影”：

- [本地事件 disposition](../src/projector.ts#L122)
- [本地 coverage 汇总](../src/projector.ts#L1175)

这个机制应保留，并扩展为“持久事件词表 + 必需消息投影词表”两个独立契约。

## P0：先修语义兼容

### P0-1：实现 `image/offload` 的消息内容投影

#### 实际差距

当前项目知道 `image/offload` 是合法事件，但它不在 `SURFACE_EVENT_TYPES`、
`RECORD_EVENT_TYPES` 或 `FOLDED_EVENT_TYPES` 中，因此最终被标记为 `raw-only`：

- [本地 known set 与 disposition](../src/projector.ts#L25)
- [本地 surface 事件集合](../src/projector.ts#L122)

上游语义不同。`image/offload` 本身是 log-only 事件，但它拥有一个**必需的纯消息投影器**：
事件指向当前 `user/message` 或 `tool/result` 中的具体图片位置，并把后续模型请求中的这些
图片永久替换为包含附件路径的文本。缺少解释器时，上游会拒绝恢复，而不是忽略：

- [上游必需消息投影词表](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/session/src/known-event-types.ts#L87-L90)
- [上游 fold 在缺少解释器时 fail closed](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/session/src/surface.ts#L509-L531)
- [上游 image/offload 解释器](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/compaction/compaction-image-offload/src/projection.ts#L39-L73)

当前影响是：

1. “模型上下文”中的图片内容与模型实际看到的内容可能不同；
2. Token/上下文分析可能把已经卸载的图片仍当作原图片；
3. 非法 target、重复 target 或错误 image index 不会触发语义失败；
4. coverage 会把它描述成普通未投影事件，而不是“缺失必需解释器”。

#### 建议实现

不要把 `image/offload` 加入普通 surface 节点集合。它不创建新节点，而是修改已有节点的
派生消息内容。建议给本地 surface fold 增加：

```ts
interface SurfaceFold {
  // 现有字段
  projectedMessages: Map<number, JsonObject>
  contentGeneration: number
}
```

处理事件时：

1. 验证 `data` 只含非空 `targets`；
2. target 必须指向 current surface 上的 `user/message` 或 `tool/result`；
3. 同一事件 target seq 不重复；
4. `imageIndexes` 必须严格递增、非负且实际存在；
5. 在前一次 projected message 或原消息上继续应用；
6. message record 和 model-context record 使用 projected content；
7. audit raw 仍保留原事件和原消息；
8. 非法投影应明确使会话 degraded/blocked，不能降级成 raw-only。

建议复制语义和测试，不直接引入整个 Harness 包依赖。上游实现依赖其 `Message`、
`SessionSeq` 和格式目录，直接依赖会把当前约 200 KiB 的轻量发行物与上游 workspace
架构绑定。

#### 验收

- 单个、多 target、嵌套 tool result、连续两次 offload 均与上游结果一致；
- 非 current seq、重复 seq、乱序/越界 image index 均 fail closed；
- transcript 仍保留用户原始输入，model context 显示 offloaded placeholder；
- coverage 把该事件记为 `folded-state` 或新的 `message-projection`，而不是 raw-only；
- AI 事实包、Token 分析和 raw inspector 分别使用正确的 projected/original 内容。

### P0-2：持久事件词表必须与上游生成清单一致

当前本地与固定上游 known event set 的差异只有一个：

```text
local only: assistant/live-chunk
upstream only: none
```

本地在 [KNOWN_EVENT_TYPES](../src/projector.ts#L25) 中放行了
`assistant/live-chunk`。但上游明确说明它是 **Client-only transient event**，持久历史由
`assistant/message` 和 `assistant/attempt` 内嵌的 compact stream 重放：

- [上游 Conversation 瞬态事件说明](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/docs/subsystems/conversation.md#L9-L12)
- [上游 live chunk 与 durable settlement 边界](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/docs/subsystems/conversation.md#L68-L73)
- [上游生成的持久事件词表](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/session/src/known-event-types.ts#L22-L85)

因为 DSH reader 对 unknown required event 采取 fail-closed，额外放行一个非持久事件会削弱
该安全边界：伪造或未来不同语义的 durable `assistant/live-chunk` 会被静默当作已知 raw
事件接受。

建议：

1. 从本地持久事件词表删除 `assistant/live-chunk`；
2. 增加测试，从固定上游清单或仓库内快照比对：
   - persisted known event set；
   - required message projection event set；
3. 更新 DSH 时先刷新兼容性快照并审查差异，而不是手动向大 Set 追加名称；
4. 保持“未知且非 `ignorable` 即拒绝”的现有规则。

这项改动很小，但能把 compatibility review 从人工记忆变成可执行门禁。

## P1：端到端增量，而不仅是增量读取

### P1-1：用有状态 reducer 逐事件推进投影

#### 当前调用链

当前 plain JSONL 的追加路径已经只把新增事件发给 Worker：

- [DshSource 追加读取](../server/sources/dsh.ts#L336)
- [ProjectionWorkerClient append 消息](../server/projection-worker-client.ts#L51)

但 Worker 随后把新事件加入完整历史，再调用完整 `projectTrajectory()`：

- [Worker append 后全量调用](../server/projection-worker.ts#L88)
- [`projectTrajectory()` 重新 sort、两轮扫描和重建所有记录](../src/projector.ts#L949)

Worker 最后又通过 `postMessage` 返回完整 `TrajectoryProjection`：

- [Worker 完整回传](../server/projection-worker.ts#L146)

因此“增量”目前只减少了主线程到 Worker 的输入复制，未减少：

- Worker 内完整历史 replay；
- 所有 records、turns、coverage、relations 的重建；
- Worker 到主线程的完整 structured clone；
- API 层整份 transport 脱敏、序列化和 hash；
- 浏览器端完整顺序表合并。

#### 上游可借鉴的最小思想

Harness 的 projection registry 并不要求把应用做成插件框架。真正值得借鉴的是 reducer
契约：

```text
key + stateVersion + init + apply(state, event) + optional view
```

无关事件返回同一个 state reference，避免下游工作；每个 state 带 watermark，并可持久化
checkpoint 后只 replay 尾部：

- [上游 reducer 定义](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-projection/README.md#L28-L58)
- [上游 checkpoint/watermark](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-projection/README.md#L81-L87)
- [上游逐事件 drive 与 change suppression](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-projection/README.md#L103-L116)

#### 建议设计

不引入动态插件注册；只在 Worker 内建立静态 reducer：

```ts
interface ProjectionReducer<S> {
  key: string
  stateVersion: number
  init(header: SessionHeader): S
  apply(state: S, event: SessionEvent): S
  materialize(state: S): ProjectionFragment
}
```

第一阶段拆为：

- location/turn-step reducer；
- surface + message projection reducer；
- messages reducer；
- steps/assistant reducer；
- tools reducer；
- compaction reducer；
- goal/todo reducer；
- coverage reducer；
- turn aggregates reducer。

Worker state 记录 `throughSeq`。append 请求只应用新事件，并返回：

```ts
{
  throughSeq,
  changedFragments,
  recordUpserts,
  removedRecordIds,
  orderOps,
}
```

发生以下情况时回退 snapshot：

- Worker state 被淘汰；
- seq 不连续；
- 文件边界签名不一致；
- snapshot rewrite；
- reducer `stateVersion` 变化；
- replacement 或关系更新无法由当前 delta 协议表达。

不要一开始持久化 checkpoint。先完成进程内 reducer，确认收益后再考虑把可丢弃 checkpoint
写入 `~/.agent-trajectory/`。canonical DSH 文件始终只读。

### P1-2：先消除 turn 汇总的 `O(turns × records)`

当前每个 turn 都重新扫描全部 records：

- [本地 turn 汇总](../src/projector.ts#L1204)
- 关键语句：`records.filter(record => record.turn === turn)`
  （[源码](../src/projector.ts#L1215)）

这条路径可以在不做完整 reducer 重构前独立修复：记录生成后一次性按 turn 分组，或在构建
record 时同步维护 `Map<number, TrajectoryRecord[]>`。复杂度从 `O(T × R)` 降为
`O(T + R)`。

现有 10 万事件性能测试没有覆盖真实成本，因为它只生成 `turn/start`，不生成展示 records：

- [现有性能 fixture](../tests/performance.test.ts#L25)

建议新增三类基准：

1. 多 turn + user + assistant；
2. 长工具输出与 tool call/result 更新；
3. 10k 历史后追加 1 条事件的端到端延迟和返回字节数。

本次只读探索中，多 turn 合成样本在本机得到以下单次值：

| turns | events | records | 完整投影 |
| ---: | ---: | ---: | ---: |
| 500 | 3,000 | 1,000 | 约 32 ms |
| 1,000 | 6,000 | 2,000 | 约 68 ms |
| 2,000 | 12,000 | 4,000 | 约 144 ms |
| 4,000 | 24,000 | 8,000 | 约 304 ms |
| 8,000 | 48,000 | 16,000 | 约 1.3 s |
| 16,000 | 96,000 | 32,000 | 约 1.9 s |

这些数字受 JIT、机器负载和样本形状影响，只证明现有测试未覆盖 records/turns 路径，不应
作为发布阈值。正式基准应多轮 warm-up，记录 p50/p95 和 payload bytes。

### P1-3：让 Worker 和 HTTP delta 只返回变化

当前 API 的 revision/delta 能正确表达更新、删除和重排，但计算与传输仍是全量：

- transport 对整份 detail 再次递归脱敏；
- revision 对整份 transport `JSON.stringify` 后 hash；
- 每条 record 再单独 `JSON.stringify`；
- empty delta 仍返回完整 projection 和完整 `recordOrder`；
-普通 delta 同样返回完整 `recordOrder`。

证据：

- [API transport 与 revision 构建](../server/api.ts#L176)
- [empty delta](../server/api.ts#L249)
- [delta diff](../server/api.ts#L262)

客户端随后依据完整 order 重建整个 records 数组：

- [客户端 delta 合并](../src/App.tsx#L88)

建议把网络协议分两级：

```ts
type OrderOperation =
  | { kind: 'append'; ids: string[] }
  | { kind: 'splice'; index: number; deleteCount: number; ids: string[] }
  | { kind: 'replace-all'; ids: string[] } // 安全回退
```

projection 元数据也按 facet 更新，例如 `turnUpserts`、`coverageUpserts`、
`relationsAdded/Removed`、`taskStateChanged`。普通尾部追加应做到响应大小近似
`O(新增/变化 records)`；replacement 或协议失配可返回 `replace-all` 或 snapshot。

revision 不必对完整 JSON 重算。可用：

```text
source fingerprint + throughSeq + reducer generation + ordered fragment digests
```

但 revision 必须保持“相同值代表相同 transport 内容”的现有语义，不能直接把不可靠的
mtime 当内容 revision。

### P1-4：为 Registry load 增加 single-flight

`SourceRegistry.load()` 先检查缓存，再直接调用 adapter：

- [本地 load 路径](../server/sources/registry.ts#L147)

没有 `Map<key, Promise<SessionDetail>>`。同一 fingerprint 下，如果详情刷新、raw 请求、
audit、AI options/preview/generate 或快速切换同时到达，它们都可能在首个结果写入缓存前
重复解析和投影。

建议：

```ts
private readonly loads = new Map<string, {
  fingerprint: string
  promise: Promise<SessionDetail>
}>()
```

相同 key + fingerprint 共享 Promise；完成或失败后只删除仍指向该 Promise 的条目。调用方
取消不应取消共享底层读取。发生 ENOENT refresh 时由 single-flight owner 完成 locator
刷新，其他等待者复用结果。

上游 JSONL backend 同样复用 revision-keyed preparation，并把每个 session 的写操作串在
单一 mutation chain 上：

- [上游 preparation memo 与 single-flight 说明](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-persistence-jsonl/README.md#L105-L111)

### P1-5：历史 generation 至少要“可发现、明确不支持”

当前 DSH adapter 只扫描：

```text
session.v4.jsonl
session.v4.jsonl.zst
session.v4.jsonl.zstd
```

证据：

- [本地文件白名单](../server/sources/dsh.ts#L29)
- [本地只接受 V4 header](../server/sources/dsh.ts#L140)

因此只有 V0–V3 generation 的真实旧会话不会显示为 blocked，而是直接从列表消失。上游则
会扫描 canonical generation，选择数值最高者，header-only list 不读 body；支持的历史
generation 在只读 open 时迁移到内存逻辑 V4，但不改写源文件：

- [上游 generation 选择与只读迁移](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-persistence-jsonl/README.md#L55-L87)
- [上游静态相邻迁移目录](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-format-catalog/README.md#L25-L47)

建议分阶段：

1. 先识别 canonical `session.jsonl[.zstd]` 和 `session.vN.jsonl[.zstd]`；
2. 每个 session 选择数值最高 generation，不能因较低版本可读而回退；
3. V4 正常读取；V0–V3 在列表显示 `migration-required/unsupported`，而不是静默消失；
4. SourceStatus 统计 unsupported session 数并给出升级说明；
5. 有真实用户需求时，再实现只读 V0→V4 migration。

不建议现在直接复制完整迁移链。固定上游的四个迁移包及其核心依赖源码规模已超过 1 MiB，
且 V3→V4 还需要收集直接子会话证据。对于轻量只读查看器，先诚实呈现兼容状态比立即背负
整套迁移义务更合适。

## P2：测量后实施的优化

### P2-1：压缩 DSH 的 frame 级增量读取

当前压缩 DSH 变化后会整文件读取、整流解压：

- [本地 decompress](../server/sources/dsh.ts#L98)
- [压缩分支完整解析](../server/sources/dsh.ts#L396)

Harness 当前物理格式不是一个不可分割的普通 zstd 流，而是：

```text
1 个 checksummed header frame
+ 每个 durable append batch 1 个独立 checksummed frame
```

上游证据：

- [物理 frame 布局](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-persistence-jsonl/README.md#L109-L112)
- [完整 frame 扫描和 torn frame 边界](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-persistence-jsonl/src/zstd.ts#L25-L104)

因此理论上可以缓存最后完整 frame offset，只读取新增 bytes，扫描完整 frame、逐 frame
校验并解压，再把事件追加到投影 state。

风险在于 crash 语义：只有不完整的最终 frame 可以作为 torn tail 忽略；完整 frame 的
checksum、解压或结构错误必须按 corruption 处理，不能泛化成“unexpected EOF 就返回已有
文本”。建议先做独立原型与 corpus 测试，再决定是否将上游 scanner 语义移植到 Node 22
+ `fzstd` 路径。

### P2-2：修复 record cache 的旧版本累积

Worker 中 `ProjectedRecordCache` 的 key 不只是稳定 record ID，而包含 status、end time、
summary、usage、metrics 和 error。record 状态改变后会插入新 key，旧版本不会被替换；
state 只有整体淘汰时才释放这些旧值：

- [本地 projected record cache key](../src/projector-utils.ts#L119)
- [Worker state 长期持有 cache](../server/projection-worker.ts#L35)

建议改为：

```ts
Map<recordId, { digest: string; value: TrajectoryRecord }>
```

同一 record ID 更新时替换旧值。若 reducer 已能直接识别 changed records，这层全局 cache
可以进一步删除。

### P2-3：避免用整份 JSON 序列化做每次缓存估重

当前至少这些地方会对大对象做完整 `JSON.stringify`：

- Worker state weight；
- Source/Registry LRU weight；
- API detail revision；
- 每条 API record digest。

Worker 每次 append 后都会重新计算整个 state weight：

- [Worker stateWeight](../server/projection-worker.ts#L55)

这既是 CPU 成本，也会制造大临时字符串和峰值内存。当前默认缓存的名义预算合计可达数百
MiB，且同一逻辑数据同时存在于来源 cache、Worker state、Registry detail、API revision
历史和浏览器。

建议：

1. reducer apply 时维护近似增量 bytes；
2. record 替换时按 old/new weight 调整；
3. 明确一个层级拥有 raw events、一个层级拥有 projection，其他层只持引用或紧凑 digest；
4. 记录 Worker heap、主线程 heap、structured-clone bytes、HTTP bytes 四项指标；
5. 根据真实 p95 会话重新分配预算，而不是只降低各层常量。

### P2-4：单 Worker 先加观测，再决定是否建池

三个来源共享一个 projection Worker；Worker message handler 内执行同步投影，所以
`Promise.all` 只表示并发排队，不表示 CPU 并行：

- [共享 Worker 创建](../server/sources/registry.ts#L239)
- [Worker 同步处理](../server/projection-worker.ts#L146)

当前应用通常只打开一个会话，直接增加 Worker 数可能增加内存副本并降低缓存命中。因此
先增加：

- queue depth；
- wait duration；
- project duration；
- source/key；
- input/output bytes；
- event-loop lag。

只有真实数据显示大型 ZCode/DSH 投影阻塞前台当前会话后，再使用 2 个 Worker 的 keyed
scheduler；同一 session 必须固定到同一 Worker，避免丢失增量 state。

## 不建议照搬的 Harness 设计

### 1. 不引入 Cordis 或完整插件生命周期

当前来源数和运行职责有限。静态 reducer table 足以获得逐事件 fold、版本和 checkpoint
能力；动态注册、卸载、effect rollback 和 profile/bundle 组合会增加远超收益的复杂度。

### 2. 不接管 DSH 的写入或 migration publication

Agent Trajectory 应只在内存中迁移历史格式。不能发布 successor、修复 torn tail、追加
closer、写 projection cache 到 DSH Session 目录。

### 3. 不直接依赖 Harness monorepo 内部包

上游内部包围绕 workspace、Cordis、Schemastery 和其构建管线组织。直接依赖会：

- 扩大 npm 包与依赖面；
- 把当前 Node 22 兼容边界与上游 Node/Zstd 实现绑定；
- 让上游 developer preview 的 breaking changes 直接进入本项目；
- 模糊只读适配器和 runtime 的责任边界。

更合适的是固定 commit、移植最小纯算法、保留 MIT attribution，并用交叉 fixture 证明
语义一致。

### 4. 暂不持久化完整 projection checkpoint

进程内 incremental reducer 已能解决活跃会话追加的主要成本。只有冷启动大会话成为真实
瓶颈时，才在 `~/.agent-trajectory/` 增加可删除、可重建、带
`sourceFingerprint + reducerStateVersion + throughSeq` 的 checkpoint。

## 推荐实施顺序

```text
P0-1 image/offload 消息投影
  ↓
P0-2 持久事件/消息投影词表同步门禁
  ↓
真实 records/turns/append/bytes 性能基准
  ↓
P1-2 turn 一次分组 + P1-4 load single-flight
  ↓
P1-1 Worker 内增量 reducer
  ↓
P1-3 Worker/API/客户端结构化 delta
  ↓
P1-5 历史 generation 可发现状态
  ↓
按实测选择：Zstd frame 增量、checkpoint、Worker pool
```

前两个 P0 可以独立完成。P1-2 和 P1-4 是低风险、收益明确的小改动。P1-1 与 P1-3 应作为
一个设计阶段：如果 Worker 仍返回完整 projection，单独把内部 fold 改成增量只能解决一半
问题；如果 API 仍返回完整 order，浏览器端也无法获得端到端收益。

## 建议验证矩阵

| 维度 | 必测场景 | 通过标准 |
| --- | --- | --- |
| DSH 语义 | replacement chain + image/offload | 与固定上游 projection 结果一致 |
| 事件兼容 | known/unknown/ignorable/transient | required unknown 和 durable live-chunk 均拒绝 |
| 追加正确性 | 逐条 append 与完整 replay 对比 | 每个 cut 的 projection 深度相等 |
| delta 正确性 | append/update/delete/reorder/replacement | 客户端结果与 snapshot 完全相同 |
| 性能 | 1k/10k/100k 真实形状后追加 1 条 | 追加 CPU 和 payload 随变化量增长，而非总历史增长 |
| 内存 | 运行中 record 多次更新、LRU 淘汰 | 同一 record 不累积历史 cache value |
| 并发 | 同 session 10 个并发 load/raw/AI 请求 | adapter parse/project 只执行一次 |
| generation | V0–V4、多 generation、未来版本 | 选择最高 generation；不可读时明确展示，不静默消失 |
| 压缩恢复 | 完整 frame、torn final frame、坏 checksum | 只忽略 torn final；完整损坏 fail closed |

## 最终判断

当前项目的最大优化点已经从“补更多上游领域字段”转向两个更底层的问题：

1. **语义完整性：** `image/offload` 和 persisted/transient event 边界必须与当前 DSH
   V4 一致；
2. **增量完整性：** 文件尾部读取已经增量，但 projector、Worker reply、API revision、
   delta 和浏览器 merge 仍按完整会话工作。

先修语义，再把增量贯穿整条链路，能在不引入 Harness runtime 复杂度的前提下同时提升
正确性、长会话响应性和内存可控性。这是当前最符合 Agent Trajectory 产品边界的优化方向。
