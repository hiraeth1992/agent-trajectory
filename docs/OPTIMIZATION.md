# Agent Trajectory 优化分析

本文基于当前实现、自动化测试和本机真实 DSH/Codex/ZCode 数据验收整理。

## 本轮推荐项 2～7 落地状态

第 1 项“先建立 Git 基线”按用户要求跳过；仓库仍未提交，本轮没有创建提交或改写用户
历史。其余项目按推荐顺序完成：

| 序号 | 项目 | 落地结果 | 回退/限制 |
| ---: | --- | --- | --- |
| 2 | DSH 识别与 HTTP 安全边界 | 非 `session-*` 目录从 v4 header 读取真实 ID；列表缓存命中也刷新文件大小/时间；服务只接受 loopback 配置，并逐请求校验 Host、端口与远端地址 | DSH 压缩流发生变化时仍需完整解压 |
| 3 | 前端实时更新合并 | 同一会话请求在途时将连续 SSE 合并为一个 pending refresh，结束后最多补拉一次；切换会话继续 abort 旧请求 | 持续高频写入时每个已完成请求后仍可能启动下一轮，以保证最终追上落盘状态 |
| 4 | ZCode 会话级指纹 | 指纹只聚合目标 session 及其 message/part/model/tool/turn usage 水位 | 依赖相关表可提供的更新时间/完成时间；schema 门禁失败时 fail closed |
| 5 | 详情 transport/revision 复用 | 同一 `SessionDetail` 对象复用已脱敏 transport、record digest/order 与 revision；相同 revision 直接返回空 delta，历史不重复存版 | 来源返回新对象时会重新准备，即使内容恰好相同 |
| 6 | 三来源共享投影 Worker | DSH/Codex 安全追加只跨线程发送增量；Worker 保留 16 项/192 MiB 状态并在淘汰或前提失效时请求完整快照；三来源投影均移出 HTTP 主线程 | ZCode 为覆盖旧行更新和删除，仍发送完整合并输入 |
| 7 | 可复现证据与性能门禁 | CLI 支持三来源固定 session ID，拒绝部分固定/部分最新混用；证据仅保留选择模式、会话 ID 哈希、详情哈希与计数；性能门禁拆为大规模复杂度、三来源 parse/project、Worker 往返和长输出脱敏 | `latest` 只适合本机冒烟；可复核证据应使用 `explicit` |

## 优先级概览

| 优先级 | 优化项 | 当前影响 | 建议 |
| --- | --- | --- | --- |
| P0 ✅ | 避免 SSE 每 1.5 秒重扫会话目录 | 已完成：Registry 持久缓存安全 locator；Codex 首次列表建立共享页面/目录索引，稳定轮询只 stat 已知目录、当前页面和 session index，目录变化时才读取新增 rollout 首行 | 已覆盖同目录/跨日期续页、初始残缺 header 重试、稳定轮询零 header/index 重读、Registry 契约测试和全量回归 |
| P0 ✅ | 消除前端请求竞态 | 已完成：会话列表 effect 与所有详情加载使用 `AbortController`，迟到响应不能提交状态 | 已通过快速切换来源/会话的 React 行为测试、全量测试和生产构建 |
| P1 ✅ | 将同步 SQLite 查询移出 HTTP 主线程 | 已完成：ZCode 的 schema 探针、列表与详情查询全部在只读 Worker Thread 中执行 | 数据库锁响应性测试由约 1.06 秒同步阻塞降为立即返回控制权；全量测试和生产构建通过 |
| P1 ✅ | 增量读取大轨迹 | Codex 与未压缩 DSH 按 byte offset 续读；ZCode 按 `time_updated` 水位合并 message/part，删除或替换时自动全量回退 | usage 表因无统一更新时间列保持完整刷新；压缩 DSH 受 zstd 不可随机 seek 限制，未变化时由指纹缓存避免解压 |
| P1 ✅ | 降低投影对象内存占用 | 已完成：详情 API 移除 `raw`，检查器按 record id 懒加载；`input/output` 超过 16 KiB 返回显式截断预览 | 已通过 API、React 懒加载、大输出回归、全量测试和生产构建 |
| P1 ✅ | 详情增量传输 | 已完成：详情首次返回 snapshot，后续以内容 revision 按 record ID 返回 upsert/delete delta；客户端合并失败或 revision 过期时回退 snapshot | `searchText` 不再传输，由客户端基于脱敏、截断后的可见字段生成；支持运行中记录原地更新和顺序变化 |
| P1 ✅ | 缓存有界化 | 已完成：Registry、三来源解析缓存和 API revision 历史均改为条目数 + JSON 估算字节数双重有界 LRU | 默认 Registry 16/128 MiB、各来源 8/96 MiB、API 64 会话/64 MiB；超限安全重建 |
| P1 ✅ | 固化 ZCode schema 兼容策略 | 已完成：probe 校验所有查询依赖的表和列，缺列精确报告 `table.column`；新增列保持兼容 | 已通过列缺失、加法式列变更、全量测试和生产构建 |
| P2 ✅ | SSE 防重入与连接治理 | 已完成：递归定时器保证单连接仅一个 in-flight；请求/响应断开后停止；失败指数退避，稳定连接发送 keepalive | 慢指纹测试并发由 4 降到 1，断连停止；全量测试和生产构建通过 |
| P2 ✅ | 拆分超大模块 | 已按 Timeline、Ledger、Inspector 和纯展示模型拆分 `App.tsx`；CSS 按 shell、timeline/ledger、inspector、状态/响应式拆分 | 共享 projector helper 集中 JSON 取值、摘要、结构化字符串解析、搜索索引和递归脱敏 |
| P2 ✅ | 统一来源元数据 | `SourceStatus` 统一返回 label/color/icon token | 会话选择器、来源状态、badge 和 Inspector 均使用 API 元数据，不再硬编码来源展示映射 |
| P2 ✅ | 增强真实样本回归 | 已加入三个来源的最小匿名生产形状 fixture、ZCode WAL 更新/删除回退、运行中 assistant/tool、大输出、可复现真实来源证据和分阶段性能门禁 | fixture 门禁拒绝本机 home 路径和 credential-shaped 内容；性能阈值相对本机基线保留多倍余量以避免 CI 抖动 |

## 关键判断

### 1. 当前最大性能热点是“轮询时重新发现会话”

`SourceRegistry.fingerprint()` 会先以 `fresh = true` 重新执行来源 `list()`。对 Codex
而言，这意味着每个活跃浏览器连接每 1.5 秒递归遍历一次 sessions 目录并读取 rollout
header 和索引。正确的边界应是：

```text
首次 list   -> 保存 opaque id 到安全 locator，并建立 Codex 页面/目录索引
SSE tick    -> stat 已知目录、当前页面、session index / ZCode WAL 指纹
目录有变化 -> 只扫描变化目录，只读取新增 rollout 的首行
映射失效   -> 单次刷新 list
```

这样既保留客户端不能提交本地路径的安全约束，也把轮询成本从“全部会话”降到“当前会话”。

### 2. ZCode 接入的主要风险是 schema 漂移，不是消息解析

ZCode 已有规范化 SQLite 表，消息、part、工具和 usage 的关联键清晰；真正容易随版本变化的是：

- 表或列重命名；
- `part.data` 新增类型或 state 形状变化；
- usage 状态枚举扩展；
- 时间戳单位变化。

因此应优先建设 schema/版本契约测试，而不是继续从日志或模型 rollout 反推会话。

### 3. “完整 raw 常驻内存”不适合长期扩展

检查器需要 raw，但时间线和账本不需要。API 已拆分为：

- `GET /api/sessions/:source/:id`：summary、projection record 摘要，以及 snapshot/delta
  revision 协议；
- `GET /api/sessions/:source/:id/records/:recordId/raw`：按需读取和脱敏；
- `searchText`：不经网络传输，由浏览器从已脱敏、截断的 transport record 生成。

增量边界没有使用简单的 `afterSeq`：运行中工具、助手消息和轮次统计会更新已有记录，
因此协议以稳定 record ID 发送 `upserts`、`removedIds` 和 `recordOrder`。revision 是实际
网络快照内容的 SHA-256，避免文件指纹和加载之间的竞态。

### 4. 缓存预算同时限制条目数和估算字节数

只限制 Map 条目数无法约束大轨迹的内存占用。当前使用加权 LRU：

| 缓存 | 条目上限 | 估算字节上限 |
| --- | ---: | ---: |
| Registry 详情 | 16 | 128 MiB |
| DSH / Codex / ZCode 解析缓存 | 各 8 | 各 96 MiB |
| Codex 页面/目录索引 | 磁盘现存 rollout 与目录 | 每页仅保留路径、会话 ID 和 summary 元数据 |
| API revision 历史 | 64 个会话，每会话最近 2 版 | 64 MiB |

权重按 JSON 序列化字节数估算；Codex 的分页 `Map` 会先转为 entries，确保原始分页行被
计入。超预算条目仍能服务当前请求，但会立即被淘汰；后续请求安全重建，旧 revision
被淘汰时返回完整 snapshot。

## 实施结果

优化按风险从运行时热点、请求正确性、数据访问、内存、安全契约到可维护性依次完成：

1. Registry locator 缓存、Codex 共享页面/目录索引与 SSE 串行轮询消除了空闲全目录
   重扫、无关 rollout header 重读和重入，并支持运行中跨日期目录新增续页。
2. 前端所有会话/详情/raw 请求实现取消与 last-request-wins。
3. ZCode SQLite 查询移入 Worker，并增加表/列级 schema 门禁。
4. raw 改为按记录懒加载，详情中的大输入/输出返回显式截断预览。
5. DSH/Codex/ZCode 均具备适合其存储格式的增量读取与安全回退。
6. 详情同步改为 revision snapshot/delta，搜索索引下沉浏览器，避免重复传输大段文本。
7. Registry、来源解析和 revision 历史改为条目数/字节数双重有界 LRU。
8. UI、样式和 projector 共享逻辑按稳定 seam 拆分。
9. 匿名 fixture、WAL、运行中状态、安全脱敏和 10 万事件基准已进入自动化回归。
10. DSH 安全 ID、loopback 请求门禁、前端 SSE 合并刷新、ZCode 会话级指纹和详情
    transport/revision 复用已补齐专项回归。
11. 三来源投影统一进入共享 Worker；真实来源证据支持固定三来源选择，性能门禁覆盖
    parser、projector、跨线程往返和 64 KiB 级长输出脱敏热点。

仍保留两个格式/增量限制：

- 压缩 DSH JSONL 无法在普通 zstd 流上安全随机 seek，因此发生变化时需要重新解压；
  未变化时不会重复解压。
- ZCode 的行可能原地更新或删除，不能仅发送尾部追加；当前由 SQLite Worker 做水位合并和
  一致性回退，再把完整合并输入发给投影 Worker。计算已离开主线程，但跨线程传输量仍与
  当前会话大小相关。
