# Magpie 实现参考与 Agent Trajectory 升级计划

分析日期：2026-11-06。

- Magpie：分析时拉取的 `main`，提交 `4ef47b3f4d45342c50cda88a50149f12959c5499`。
- Agent Trajectory：当前本地提交 `13661dd263f6cd958acf913f923a1ba90dda0be3`。
- 方法：静态阅读后端、前端、类型、存储代码及部分测试。以下“已实现”指源码已实现，不表示本次运行验证通过。
- 范围：外部源码分析、独立升级计划及首批实现。没有启动 Magpie、调用模型、读取个人会话或修改上游配置。首批实现验证使用合成会话。
- 计划状态：按用户最新要求重新制定。第三节是当前升级建议，替代此前对话中的功能清单；不依赖 Magpie，改道与回放已从计划中删除。第一、二节仅保留外部实现参考。

## 结论

**升级围绕本项目的三个目标：还原可观察的执行事实、定位时间与 Token 消耗及恢复问题、验证轨迹质量是否改善。** 保留本地优先、来源只读、按证据下结论的定位。优先完善现有分析与评测路径，再增加检索和上下文查看能力。

当前计划共六项：证据与诊断连通、异常与资源联合定位、会话检索与谱系联动、上下文证据与变化、评测对比与 badcase 证据闭环、可复查报告。改道、回放、Magpie 接入、自研模型代理和请求录制均不纳入本轮升级。

两者的采集位置不同：

```text
Magpie：Agent → 模型网关 → 上游模型
                   └─ 路由决策、候选、尝试、请求、响应、用量

本项目：Agent 本地记录 → 来源适配器 → 统一轨迹 → 分析与评测
```

Magpie 的优势是解释“请求发给了谁、为什么换路、时间花在哪”。本项目已经有工具执行、关系、覆盖率、纠错链、评测和证据定位。**两层数据互补，不能直接互相替代。** 网关看到的工具调用和工具结果，也不等于工具在本机执行的完整过程。[M1][M2][L1][L2]

三个容易误解的点：

1. 路由页的 **Replay 是历史动画回放**，不重新发送模型请求。
2. 上下文卡片的 **分项 Token 是估算后按总量校准**，不是各分项的 tokenizer 精确计数。
3. 会话列表、Token 统计、正文读取、恢复、删除分别有支持范围。“识别一个 Agent”不等于完整支持它的轨迹。[M3][M4][M10][M11]

## 1. 路由模块如何实现

### 1.1 模块边界和运行路径

`plugins/routing/routing.go` 注册页面插件。页面实现位于 `internal/gui/assets/plugins/routing/client.js`，使用普通 JavaScript、DOM、SVG 和动画帧。真实路由由 Go 的 `internal/gateway`、`internal/provider`、`internal/routes` 执行。路由页是其观察界面，页面是否显示不决定网关是否路由。[M1]

主链路可以概括为：

```text
识别客户端、协议和会话
  → 解析目标模型或路由组
  → 展开候选账号、Key、模型
  → 按策略、规则、可用性和会话亲和性排序
  → 开始 Route，记录当时的候选和决策依据
  → 执行一个 Try
  → 成功返回 / 同处重试 / 改道 / 最终失败
  → 更新实时轨迹、写入用量及已完成路由历史
```

`routes.Strategy` 主要决定候选顺序。候选展开、冷却、会话亲和性和故障转移由 gateway 管理。策略包括 Smart、顺序、轮换、用量、权重、速度、价格等；嵌套路由组和命中规则也会记录在 Route 中。[M2][M5]

### 1.2 轨迹：在决策发生时记录事实

关键模型不是一段日志字符串，而是有结构的数据：[M2]

| 对象 | 记录什么 | 用途 |
| --- | --- | --- |
| `Route` | 请求 ID、Agent、会话、所求模型、路由组、规则、亲和性、所有尝试、最终状态、用量和耗时 | 一次客户端请求的完整路由过程 |
| `Weighed` | 候选顺序、配额、余额、续期时间、速度、价格、冷却、被排除原因 | 解释“为什么先选它、为什么没选另一个” |
| `Try` | 实际候选、模型、开始时间、状态、耗时、错误、冷却、再次尝试及网络分段 | 解释每一次上游尝试 |
| `Prompt` | 上下文窗口、输入总量、组成类别、条目名称及大小 | 解释模型输入由什么构成 |

`trace.beginFor()` / `begin()` 创建 Route。执行过程中 `trace.update()` 原地更新状态并递增 `seq`。信息来自路由实际使用的值，不是在展示时重新计算选择结果。[M2]

实时页面通过 `GET /api/gateway/trace?after=<seq>&wait=1` 长轮询：最多等待 25 秒；变化唤醒后短暂聚合约 250ms；返回增量 Route 和当前保留的 ID 集合。ID 集合帮助页面删除已淘汰的请求。它不是路由页使用 WebSocket 推送的实现。[M2][M6]

内存通常保留最近 60 个 Route，优先移除已完成项；全在运行时可以暂留到 120 个。完成后异步写入 `routing/<本地日期>.jsonl`，过往日期压缩为 `.jsonl.gz`。按 30 天和约 200MiB 清理，当前日被保留，因此不能把 200MiB 理解为严格硬上限。按天查询最多返回最近 2000 条，并标记 `cut`。[M2][M7]

另有用于外部显示的 `route-events` SSE 接口。它用白名单 DTO 输出状态，不含会话、账号、正文和错误文本。其 512 条事件缓冲支持游标续读，游标失效要求重新取 snapshot。**它适合运行状态展示，不足以独立关联到本项目的某条会话。**[M8]

### 1.3 系统提示词：请求体解析、上下文分类、按需读正文

路由页的系统提示词入口属于上下文窗口卡片。`promptOf()` 分别解析 Chat Completions、Responses、Anthropic Messages、Gemini 的客户端请求体，而不是扫描磁盘寻找一个统一的 system prompt 文件。[M4]

解析后分成七类：

| 类别 | 内容与识别方式 |
| --- | --- |
| `system` | system、developer 和可识别的 Agent 运行框架说明 |
| `tools` | 工具定义，包含按工具名或 MCP 服务器归组的条目 |
| `skills` | 请求中列出的技能信息 |
| `memory` | `AGENTS.md`、`CLAUDE.md` 等指令文件和提醒，依赖消息格式与标记识别 |
| `files` | 工具读入的文件、图片，结合调用 ID、工具名、参数识别 |
| `results` | 其他工具输出 |
| `chat` | 用户、助手消息和调用记录 |

实现分两层：[M4][M9]

1. 请求处理中异步计算名称和大小。ASCII 文本约四字符算一个 Token，非 ASCII 字符约一个算一个；图片也有估算值。供应商返回输入总量后，按比例缩放各部分。
2. 点击条目才通过 `/api/context/text?id=…&kind=…&item=…` 取正文。持久化路由历史只存分类、名称、大小；正文默认来自最近 10 个请求体的内存缓存，单体上限 32MiB、总计 64MiB。正文不在内存时，可回退到显式开启的请求归档。

因此有四个边界：

- 总量有供应商用量支撑，不代表每个文件、技能的分项 Token 也被精确测量。
- 分类有启发式规则，不同 Agent 改变封装格式后需要适配。
- 卡片主要解释客户端送入网关的请求；协议转换或中间件可能改变最终上游载荷，不能把它统称为每次上游调用的逐字快照。
- 引用 `previous_response_id`、加密压缩块或未携带的历史时，不能恢复完整文本。缺失与密封内容必须保留其状态。[M4][M9]

这里讨论的是观察请求中的系统提示词。README 中另列的 `system-prompt` 中间件属于修改请求的能力，不是这个查看入口的实现，也不在建议直接移植的范围内。[M24]

### 1.4 路由中的“会话”：身份、亲和性、展示归属

这三个概念需要分开。[M2][M12]

**身份**：`sessionOf()` 优先读取 `X-Magpie-Session`，然后读取 Agent 原生头，例如 `session_id`、`x-claude-code-session-id`、`x-opencode-session`、`x-conversation-id`、`x-deepseek-harness-session-id`。`nativeSessionOf()` 另保留原生头，避免覆盖后丢失原身份。

**亲和性**：为了复用上游 Prompt Cache，同一对话可以继续使用上次账号或模型。`affine()`、`stickKey()` 等结合策略、轮次和可用性排列候选；状态可保存到 `affinity.json`。没有原生 ID 时，可以用对话开头的摘要辅助亲和性。这个摘要不能自动升级成可信的原生 session ID。[M12]

**展示归属**：GUI 补充本地会话标题、父子关系；对于可读取回复 ID 的来源，利用 `ResponseID`、`Conv` 和原生文件证据匹配。DSH 的 fork 可能继承相同开头，代码因此还核对回复 ID 与 fork 关系。缺少证据的请求保留“未提供会话标识”，不能把它们合并成一个聊天。[M6][M13]

### 1.5 请求：三个粒度、不同保留策略

一个客户端 Request 可以产生多个上游 Try。一个账本 Call 又不一定等于一个完整 Agent 轮次。Magpie 没有用一个数组混合这些含义。[M2][M14]

请求列表展示所求模型和实际模型、协议、状态、TTFT、首段文本、Token、缓存、成本、尝试次数和用途。点击后读取请求与响应体，以及经过处理的客户端和上游请求头。耗时细分使用 Go `httptrace`：DNS、连接、TLS、发送、等待首字节；另记录本地处理、排队和失败尝试耗时。插件自行发出的 HTTP 请求可能没有这些分段，界面说明缺失原因。[M14][M15]

| 存储 | 内容 | 保留及限制 |
| --- | --- | --- |
| 实时 `trace` | 路由结构与执行状态 | 通常最近 60 个 Route |
| `routing/*.jsonl[.gz]` | 完成的路由、尝试、决策依据、上下文组成摘要 | 30 天、按容量清理；不保存 Prompt 正文 |
| Recent calls | 请求、响应预览和请求头信息 | 最近 40 个 Call；两方向正文各最多 256KiB，标记截断 |
| `request-archive` 或 S3 archive | 请求与响应的头和体等诊断材料 | 需显式开启；正文默认每方向最多 32MiB；本地归档默认约 1GiB 容量 |
| `usage.jsonl` / Usage ledger | 模型调用、用量、价格输入、错误和归属 | 用于长期用量统计及与原生记录对账 |

归档异步排队，队列最多 16 个任务；排满或保存失败可能丢失归档，不阻断原模型请求。S3 与本地归档是不同开关。脱敏覆盖已知秘密及敏感字段，不应据此保证任意业务正文都已去敏。[M7][M9][M14][M16][M17]

金额还要区分估值与账单。`NewPricer()` 使用读取时的有效价格快照；价格配置变化后会重算历史。它不是不可变的供应商历史账单。本项目若吸收此能力，应同时记录计价依据和价格版本，或明确标成“按当前价格估算”。[M17]

注意：这里的“请求归档”与会话页的“保存对话”是两个不同存储，开启其中一个不表示另一个也完整可用。

### 1.6 改道：候选循环、响应暂存和分类型恢复

`gateway.go` 的候选循环在尝试开始时添加 `Try`。`holdWriter` 暂存可挽回的失败响应，以及流式响应最初尚不能确认成功的部分。尚未把有效答案交给客户端时，可以丢弃该尝试的暂存输出，询问下一候选。[M5][M18]

失败处理不是“HTTP 非 200 一律换模型”：

- 限流、额度不足、网络或服务错误分别判断重试、冷却、下一个账号和下一个模型。
- 模型或协议不支持，可能只影响这个模型或载荷形式，不应让整个账号不可用。
- 上下文过长时，同模型换账号通常无效；路由组有其他容量合适的模型时存在专门分支，否则交给客户端压缩处理。
- 会话亲和性、指定账号、密封上下文、组等待预算会进一步限制下一步。
- 客户端取消会终止继续尝试。

流已经开始后，不能任意切换。源码有“仅推理部分已输出、答案或工具调用尚未输出”等协议相关接续分支；不能把它概括为任何流式输出均可透明重试。[M18]

页面中的“改道”是这条已经发生的尝试链的可视化。手动配置路由组、解除冷却 `/api/gateway/unrest` 则是真实改变后续运行行为的控制功能。[M6]

### 1.7 错误：尝试失败与最终失败分开

`Try.Fail`、`Try.Error`、`Try.Rest` 记录某个上游尝试失败的原因和后果。`Route.Status`、`Route.Error`、`Route.Fail` 记录最终交给客户端的结果。[M2][M18]

例如：

```text
请求 A
  Try 1：供应商甲 → 429 → 冷却、改道
  Try 2：供应商乙 → 200
结果：一次请求；经历上游失败；Agent 最终未收到错误。
```

路由页的三个总数分别是已完成请求、改道和 Agent 收到的错误。源码中 `Rerouted` 具体按“带 `Rest` 且后面还有尝试”的 Try 计数；它不是所有 `tries.length - 1`，也不能直接当成跨供应商切换次数。最终错误计数检查状态码或错误文本，所以 HTTP 200 但流式失败也可能算错误。[M2][M3]

最终反馈也未必是最后一条尝试的错误。例如后续账号仅因额度不足未能回答，可能保留更早的实质失败原因；`Earlier` 与 Route 的 `Fail` 用于避免状态与原因错配。失败过程中已消耗的 Token 可以单独计入账本，不能只统计成功尝试的成本。[M18][M17]

### 1.8 重放：前端时间轴重建，没有模型调用

`client.js` 的 `replay()` 收集已完成请求与尝试的开始、结束时间，建立真实时间与播放时间的映射。相邻关键时刻超过 1800ms 的间隔压缩为 1800ms；虚拟时钟仍可映射回真实时间。[M3]

- `ghost()` 按播放进度生成该时刻可见的尝试状态。
- `requestAnimationFrame(step)` 推进时钟、SVG 动画和状态文字。
- 支持单请求、从某处开始、全部回放，1/2/4/8 倍速和点击进度条跳转。
- 播放结束恢复当前或之前选定的请求。

它重建的是路由阶段，不是逐 Token 重现所有输出，也不是重新执行工具或向模型发起相同请求。本项目当前升级计划不引入回放，优先使用异常定位、证据跳转和静态时间线帮助分析。

## 2. 会话模块包含什么，如何实现

### 2.1 数据来源与统一模型

页面由 `plugins/sessions/sessions.go` 注册。后端主要是 `internal/sessions`，HTTP 入口是 `internal/gui/sessions.go` 和 `sessions_manage.go`。[M1][M10]

它读取两类数据：

1. **原生会话**：各 Agent 的 JSONL、压缩文件、SQLite 或其他存储。分别解析标题、时间、工作目录、模型、用量、消息及关系。
2. **网关会话**：Usage ledger 按 Agent 和会话聚合；如果显式启用了对话录制，可再读取正文。

`Session` 汇总身份、标题、工作目录、时间、模型、Token、成本、恢复命令、正文能力和子会话等。按精确 `Agent + ID` 合并时原生会话优先，另考虑已知副本和子会话 ID，避免网关会话重复出现。纯网关会话没有原生文件和恢复能力。[M10][M11]

“会话去重”和“请求去重”是两层。Usage ledger 把 gateway 记录与原生 Call 匹配；Codex 用唯一 `response_id` 匹配和副本消重，并从原生元数据补充主线程、子线程、根会话与压缩标记。其他来源也有专门的请求 ID 或受约束匹配规则，不能简化成按时间相近合并。[M17][M19]

### 2.2 功能清单

| 功能 | 源码实现 | 限制或语义 |
| --- | --- | --- |
| 会话发现与列表 | `sessions.List`、`ListAgent`；GUI `/api/sessions`、`/manage` | 按 Agent、项目目录组织；网关来源另标注 |
| 多维筛选与分页 | 前端按标题、目录、ID、模型筛选；目录和会话分批渲染 | 不一次创建所有历史会话的 DOM |
| 跨会话正文搜索 | `/api/sessions/search` → `SearchSession` / `SearchGateway` | 当前所选 Agent 范围内搜索；返回片段与搜索覆盖状态 |
| 对话查看 | `/transcript` → `TranscriptOf`，返回 `Part[]` | 正文、工具、可读推理、上下文分类型显示；有截断标记 |
| 子 Agent 和分支树 | `subagents.go`、Codex 原生父线程元数据、`cc_copies.go` | Claude/Qoder 子文件、OpenCode 子 session 等分别适配；关系不明不猜测 |
| Token、模型与成本 | `Session.Models`、`Tokens`、`Cost`、`Unpriced`、`Via` | 缺失价格不显示成免费；Codex 可按模型和 reasoning effort 分组 |
| 统计与概览接口 | `/stats`、`/overview` → 按日、Agent、目录、模型聚合 | 与关联用量界面共用；不应误说所有统计图都位于会话管理页 |
| Markdown 导出 | `/markdown`、`/export` → `WriteMarkdown` 或网关版本 | 使用来源读取器；导出注明网关来源及内容不完整情况 |
| 继续会话 | 根据可信 session 生成 `Resume`，桌面端开终端 | 浏览器端不直接开服务器终端；Codex 某些恢复路径会迁移 provider，存在写入 |
| 跨 Agent 接续 | Pi → omp 使用其原生 fork；Claude ↔ Codex 显式转换 | 新建目标 Agent 会话，源文件保留；非通用格式无损转换 |
| 删除、回收站、恢复 | `Delete` / `Restore` / `Purge`，记录原路径 | 只支持清楚掌握存储布局的来源；活跃会话保护；永久删除需单独操作 |
| 会话环境迁移 | Codex provider 迁移；Claude 项目目录迁移 | 备份、状态更新；Claude 迁移使用预览指纹并要求关闭客户端 |
| 读取权限与网关录制 | `Reads` / `SetReads`、`SetGatewayRecording` | 新安装默认不读取原生历史，已有安装有兼容策略；录制默认关闭 |

功能和 API 依据：[M10][M11][M19][M20][M21][M22]。

### 2.3 原生正文与网关录制不是同一能力

`HasTranscript()` 明确列出可读取原生正文的来源。这个版本中，DSH、WorkBuddy、ZCode 等即便有列表和用量读取，也不在其原生正文白名单中。本项目已经能投影这些来源的消息、工具和更多执行事实，不能用 Magpie 会话解析器整体替换现有适配器。[M11][L1]

网关录制通过 `recordConversation()` 包装面向客户端的响应路径，位于协议转换和中间件之外。一次客户端交换只记录一次，内部重试不会变成重复的助手消息。只有客户端明确提供会话 ID 且录制开关开启时才保存。[M20]

保存格式为：

```text
<Magpie 配置目录>/gateway-conversations/
  <UTC 日期>/<Agent 与会话身份的哈希>/turns.jsonl
```

每行是归一化的 `GatewayTurn`，含 Input、Output、时间、模型、状态和截断信息，不保存请求头。目录权限 0700，文件 0600。[M20]

容量要按代码理解：采集输入、响应各上限 8MiB；保存时输入和输出**每个方向还有约 64KiB 的文本预算**，序列化单 turn 上限 1MiB。存储保留 7 天、约 256MiB，单个每日会话文件也有 256MiB 上限。每次读取最多保留最近 128 次交换。它不是永久完整聊天备份。[M20]

重建 transcript 时，只剔除与上一轮输入加输出**完整相等的前缀**，重复的系统上下文另行折叠。遇到编辑、压缩、增量历史导致前缀不相等时，允许重复，不推测一个“标准历史”。清除录制通过锁与 generation 校验，防止尚未完成的请求把刚清空的内容写回来。[M20]

### 2.4 搜索和大历史性能

原生会话解析按文件路径、大小、修改时间缓存，并维护完整行后的 byte offset。只追加时增量读取；部分解析器还核对头部与旧前缀 hash，防止把替换文件误认成追加。解析缓存持久化，并按版本失效。请求级 Call 缓存与会话摘要分开，正文按需读取；并发的相同读取共享任务。[M10][M23]

全文搜索采用有预算的按需扫描，而不是先把所有历史正文放入页面：[M21]

1. 前端等待输入停止 300ms，取消前一个搜索请求。
2. 后端查询至少两个 Unicode 字符；优先搜索最近会话。
3. 普通文件先按查询的最长词做字节预筛选，然后解析相关记录。压缩文件、数据库或 JSON 转义可能影响匹配时跳过不安全的预筛选。
4. 最多四个 worker，八秒预算或 200 个命中后停止，返回 `searched/total/cut`。
5. 优先选用户或助手正文命中，也能回退到可搜索的工具等内容；排除系统提示词、上下文定义和图片。片段用文本节点构建。

这些原则适合本项目。现有项目已经有 Worker、LRU、指纹、JSONL 增量读取和 SSE 增量返回，不需要因 Magpie 有缓存就重建一套缓存系统。[L3][L4]

### 2.5 接续、删除与恢复涉及真实副作用

Claude ↔ Codex 接续先转换为中间消息结构，再写入目标原生格式。正文、图片、shell 调用与结果可以迁移；其他工具通常转成文本。签名或加密推理不迁移，合成助手消息不作为新的真实模型调用计费。相同源文件版本的重复点击复用转换结果。[M22]

删除通常把确定的文件集合移到 Magpie 回收站，并保存来源清单；最近一分钟仍有写入的会话会被认为可能活跃。数据库由客户端持续维护、删除后可能留下索引或正文的来源，不统一开放删除。恢复可能与现有文件冲突，需要具体来源处理。Codex provider 迁移和 Claude 项目重定位也有独立实现。[M10][M22]

因此不能把“会话读取包的说明写着只读”扩展为“整个会话模块没有写入”。正常浏览、接续、恢复、删除是不同执行路径。

## 3. 本项目升级计划：按初衷重新评估

本节为当前升级计划。工作包 A、B 的首批实现已完成，C、D、E、F 尚未实施。不以外部产品的功能数量作为升级目标，不依赖 Magpie 或任何新增模型服务。

首批交付：服务端快照和增量响应提供完整事实质量报告；轨迹评测增加分析依据与联合筛选；结论和纠错链展开全部证据；检查器连续审阅证据及相邻记录，按需加载原始事件。证据跳转清除遮挡筛选并展开轮次。联合定位使用已有步骤计量与恢复分析，不累计整条证据链资源。缺失输出、截断预览、未知用量和中断分别展示。修改位置为 `server/api.ts`、`src/analysis-review.ts`、`App`、`TrajectorySummary`、`Inspector` 及相应组件。

分析依据按受影响结论汇总提示，技术详情默认折叠。已识别且不阻断评测的 `raw-only` 事件不显示提示卡片，完整质量报告、原始审计和覆盖统计仍保留。必要事实即使标为 `raw-only`，仍保留阻断提示；未支持事件的影响未知，继续提示并限制相关结论。旧报告缺少结构化分类时不自动隐藏提示。受限的执行结论和过程评测只显示判断边界，并链接回分析依据。定位模块显示全量逻辑步骤数、候选数和筛选后的显示数。

界面整合：原“分析依据”和“可观测性”统一为过程评测的第五项“数据质量”，与结果证据、路径稳定性、恢复能力、资源效率使用相同的条目布局。默认显示质量结论和影响，覆盖统计、来源状态与限制证据折叠在详情中；受限结论链接定位详情并展开。数据质量反映评测依据的完整度，后台分项判据与审计报告保留。“执行故事线”承担阶段导航，原“问题与资源定位”改为统一“步骤详情”的联合筛选，不再另列一份步骤卡片。“全部步骤”覆盖全量逻辑步骤，候选数和当前显示数分开标示；从故事线展开阶段会清除筛选并定位。所有步骤均可审阅完整关联证据，包括无异常、无资源数据的普通步骤。阶段与轮次活跃耗时使用记录区间并集，未知时间不补零；异常标题不暗示已恢复，修改前的验证不作为修改后结论，数据质量阻断也限制阶段结果。

Codex 原生 `tool_search_call` 与 `tool_search_output` 按 `call_id` 配对为工具记录，保留查询、工具目录、来源事件和状态。空目录是有效结果，缺失或格式错误的结果不补为空目录；失败、中断和运行中状态分别保留。`world_state` 的 `cloud_skills` 与 `tools` 已识别为技能和工具运行配置，按既有策略保留原始审计，不作为任务执行结果；未知字段和工作区变更继续保留质量限制。

恢复证据分为原调用重试成功、原问题验证通过、后续执行成功但原问题未验证。前两类计入已恢复，第三类保留为 `continued` 并进入“未确认恢复”筛选；来源缺少结果时不能仅凭完成状态确认恢复。验证关联要求同一轮次、相同工具、相同命令及显式工作目录，且重新验证的输出存在并通过。不同验证目标或跨轮次记录不自动关联为原问题已解决。该规则保守识别，未确认不表示问题必然仍然存在。

### 3.1 选择功能的标准

README 的三个问题是取舍依据：[L1]

| 项目初衷 | 升级应带来的结果 | 判断边界 |
| --- | --- | --- |
| Agent 看到了什么、执行了什么 | 能从结论定位到来源记录，知道哪些内容可见、哪些缺失 | 不能从结果倒推出隐藏推理，也不能把历史日志当完整模型输入 |
| 时间和 Token 花在哪里，失败后是否恢复与验证 | 能找到具体步骤、输入输出和恢复证据 | 长耗时不自动等于浪费；没有验证记录不自动等于没验证 |
| 不同 Agent、版本的轨迹质量是否改善 | 能在可比条件下检查变化和反例，并回归验证 | 低 Token 不自动等于更优；任意两次任务不能直接排名 |

每一项都应改善上述至少一个问题，并复用现有事实、分析或评测结构。普通浏览、搜索、上下文查看和导出继续只读，不修改来源会话和上游配置。[L5][L12]

### 3.2 已有基础与修正

本次复核确认下列功能已有实现；后续工作是增强，而非重建：

| 已有能力 | 当前实现 | 本次可推进的增量 |
| --- | --- | --- |
| 统一记录、关系和来源能力 | `src/types.ts`、`server/sources`、`server/projectors` | 按具体功能核对证据覆盖，不预先重构全部模型 |
| 来源质量与评测门禁 | `projection-coverage.ts`、`trajectory-evaluation.ts` | 把缺口对具体结论的影响解释得更清楚 |
| 错误、纠错链、优化建议 | `trajectory-analysis.ts`、`trajectory-optimization.ts`、`TrajectorySummary` | 从问题列表联动到相关步骤、输入输出和验证证据 |
| 时间、Token 和消耗排行 | `token-usage.ts`、`TrajectorySummary.CostChart` | 联合查看消耗、执行行为和恢复结果，完善口径说明 |
| 证据跳转 | `TrajectorySummary.EvidenceButton`、`App` | 展开一条结论的全部支撑记录；部分现有入口只跳首条证据 |
| 当前会话搜索、来源选择 | `App`、`SourcePicker` | 跨会话搜索、目录与谱系导航 |
| 模型上下文视图 | `modelContextRecordIds`、`modelContextRecordOverrides` | 分类、来源说明，以及有足够事实时的变化比较 |
| 冻结、双标、裁决、baseline、badcase | `server/evaluation`、`EvaluationCenter` | 从差异、badcase 进入对应冻结证据，完善复查路径 |
| 本地诊断与 JSON 导出 | `server/diagnosis`、`server/api.ts` | 生成同一快照上的可读 Markdown 报告 |
| Worker、LRU、指纹、增量读取 | `server/sources/registry.ts`、`server/sources/codex.ts` 等 | 按新增搜索和快照需求扩展，避免另建并行框架 |

依据：[L2][L3][L4][L6][L7][L8][L9][L10][L11][L13][L14]。

需要纠正此前判断：`TrajectoryStory.tsx` 已有约 1.4 秒自动切换阶段的播放控件。它不是按真实事件时间运行的完整回放，但不能说项目没有任何播放能力。用户本轮要求是重新制定升级计划，因此删除的是回放升级项；本次文档修改不直接删除现有 UI。静态故事线、时间线和证据定位仍可用于分析。[L15]

### 3.3 原有提议逐项取舍

| 原提议 | 当前决定 | 理由与具体收敛 |
| --- | --- | --- |
| 改道、路由控制 | 删除 | 用户明确排除；不承担模型选择、账号池或故障转移 |
| 回放、播放器 | 删除 | 用户明确排除；优先问题与证据定位，不另做播放系统 |
| 会话导航 | 保留，阶段二 | 支持按来源、目录、时间查找，服务于找到待分析会话 |
| 跨会话正文搜索 | 保留，阶段二 | 能复用历史故障和执行证据；需有预算和覆盖说明 |
| 主会话、子 Agent、分支树 | 收敛保留，阶段二 | 只连接已有明确关系；不引入会话写入、迁移或分支创建 |
| 错误与恢复视图 | 增强现有，阶段一 | 已有纠错链，补齐定位、分类和证据审阅，不另做第二套诊断 |
| 关键节点导航 | 收敛到现有分析，阶段一 | 由错误、消耗和验证问题定位记录；已有故事线不重做 |
| 系统提示词查看 | 收敛保留，阶段二 | 展示来源实际记录的 system/developer/指令片段；不从当前磁盘补历史 |
| 上下文组成与差异 | 条件保留，阶段二 | 有完整边界时做组成与比较；证据不足时只展示片段 |
| 独立请求详情页 | 合并到检查器，阶段二 | 展示原生记录已有模型、参数、输入输出、用量与错误；不假定拥有 HTTP 原始包 |
| 耗时、Token、缓存分析 | 增强现有，阶段一 | 已有排行与统计；补齐相关证据及指标解释 |
| 金额计价、价格库 | 暂不排期 | 当前核心是质量和资源归因；动态价目维护与真实账单口径成本高 |
| 全局用量大屏、Agent 排行 | 暂不排期 | 统计规模不直接回答质量问题；用评测中的可比样本解释改善 |
| baseline 和 badcase | 增强现有，阶段三 | 已有框架，重点改进差异到证据、结论到复测的路径 |
| Markdown 分析报告 | 保留，阶段三 | 将现有分析整理成可复查材料；不是再做一套分析器 |
| Magpie 接入 | 删除 | 独立运行，不把 Magpie API、数据库或归档作为依赖 |
| 自研代理、请求录制、采集 Hook/插件 | 不纳入当前计划 | 扩大请求转发、凭据、配置和数据保存职责；当前先利用既有来源 |
| 自动继续、跨 Agent 转换、删除恢复、provider 迁移 | 不纳入当前计划 | 会话控制不服务于当前只读分析边界 |
| 更多 Agent、通用来源管理和读取开关 | 按实际缺口另行评估 | 先完善现有八种来源，不为功能数量或假想需求扩张 |

“来源没有记录”是应当展示的分析限制，不自动成为建设代理或采集平台的理由。若后续真实问题持续受阻于某一缺失字段，再单独评估获取该字段的最小方法。

### 3.4 阶段一：让单会话分析可信且容易复查

**工作包 A：证据与诊断连通，P0。**

- 在现有轨迹评测和检查器中解释来源支持、解析缺口、截断、运行中状态对结论的影响。
- 一条结论有多条证据时，能展开全部记录并选择查看；区分记录事实、规则推断、证据不足。
- 对来源缺失、解析问题、工具失败、模型失败和取消分别呈现；分类依据是明确事件，无法确定时保留未知。
- 扩展已有质量门禁的展示和契约样例，不新建总分，不重新设计整个评测系统。

落点：`TrajectorySummary`、`Inspector`、`trajectory-evaluation.ts`、`evaluation-types.ts`。首个可独立交付切片是“多条证据列表 → 选择记录 → 查看原始事件”。

验收：多证据结论能逐条查看；缺少某类证据时相应结论明确受限；来源错误不被算作 Agent 执行错误；正常取消不显示为工具故障。

**工作包 B：异常与资源联合定位，P0。**

- 基于现有消耗排行、纠错链、优化建议提供联合筛选：失败、重复失败、未确认恢复、耗时靠前、Token 靠前。
- 从问题进入相关输入、输出、上下文片段、前后步骤和已有验证记录；保留来源与证据级别。
- 复用已有墙钟/活跃时间及 Token 口径，明确统计范围、覆盖率和未分配量。
- 判断重复读取、重试或高消耗是否值得改进时，展示依据和限制；不能仅凭“重复”或“量大”判低质量。

落点：`trajectory-analysis.ts`、`trajectory-optimization.ts`、`TrajectorySummary`、`Timeline`、`token-usage.ts`。

验收：选中某问题能定位对应记录集合；恢复后的失败仍保留历史，但最终状态清楚；父子工具和并发区间不会因新聚合而重复计量；排名本身不改变任务完成结论。

阶段一交付的是现有分析路径的完善。首批不包含搜索引擎、上下文快照历史或新来源框架。

### 3.5 阶段二：找到相关会话，解释可见上下文

**工作包 C：会话检索与谱系联动，P1。**

- 将当前会话下拉选择增强为可检索的来源、项目目录、时间列表，保留会话直达和新会话激活功能。
- 增加跨会话搜索；区分正文与工具/错误搜索，返回片段和准确记录定位。
- 仅根据明确 parent/child/fork 事实连接会话；父会话缺失、关系冲突和环路需要有明确状态。
- 后端有并发、扫描量和时间边界，支持取消及分页；返回实际搜索范围、未完成情况和来源失败，不把“未搜完”显示成“没有”。

落点：`App`、`SourcePicker`、`server/api.ts`、`SessionSource` 和各来源实现。先完成目录/标题查找，再按来源逐步接入正文搜索，不在每次刷新时加载所有完整轨迹。

验收：可以从搜索命中进入对应会话及记录；隐藏或折叠状态不挡住定位；同名或同开头的会话不会合并；一个来源失败不阻断其余来源；切换查询后旧结果不会覆盖新结果。

**工作包 D：上下文证据与变化，P1。**

- 先完成八种来源的能力清单，区分“明确上下文快照”“有明确边界的请求输入”“已记录片段”。这是功能验收依据，不是大规模模型迁移。
- 在现有对话、模型上下文和检查器中组织 system/developer、用户约束、技能、工具定义、工具结果等已记录内容。归类不确定的保留原始类别。
- 有两个可验证边界时，比较新增、移除、替换和压缩内容；目前只保留最终上下文的来源，要先确认能否从原生事件构建历史边界。
- 原生记录已保存模型参数、输入输出或请求级用量时，补入检查器。无法把工具结果确定归入某一次模型请求时，不建立猜测的关联。
- 首版以内容和证据变化为主。没有可靠分项用量时不显示精确 Token 饼图；没有完整上下文时不显示完整窗口占用率。

落点：`src/types.ts` 的按需增量字段、对应 projector、`Conversation`、`Inspector`。分类查看可以独立交付，历史差异是有数据能力来源上的后续切片。

验收：不会混淆用户对话、当前模型上下文和完整审计历史；当前磁盘文件不会冒充历史提示词；截断、密封和来源未记录清楚标记；没有可比边界时停止比较并说明原因。

### 3.6 阶段三：验证改善并形成可复查报告

**工作包 E：评测对比与 badcase 证据闭环，P1。**

- 保留现有数据集冻结、双标、裁决、split、baseline 和 casebook 流程。
- 从改善/退化条目、分项结论进入对应 case 的冻结证据，查看支撑与反证；不能跳到一个已经变化的实时会话替代历史证据。
- 复用 casebook 记录问题决策和复测，把展示重点放在“什么变了、依据是什么、是否已验证”。是否增加写操作界面以实际流程瓶颈决定，不预先复制全部 CLI。
- 严格区分评测器回归与 Agent 对比。当前 `compareEvaluationRuns()` 要求数据集、Gold、契约和 case 指纹一致，主要用于固定事实上的评测结果比较。[L10]
- 若要比较不同 Agent/版本的真实执行，另需明确同一任务、验收条件、环境差异和样本配对；先使用人工明确配对的冻结材料作描述性比较。不能为得到排行而放宽当前 baseline 的可比性检查，也不从两条任意轨迹推断因果提升。

落点：`EvaluationCenter`、`AnnotationWorkspace`、`server/evaluation/runner.ts`、`casebook.ts`、已有冻结证据接口。

验收：每条差异能回到产生它的冻结数据；不兼容的 run 明确不可比较；证据缺失不算通过；复测记录能核对目标快照。改进标准必须同时考虑任务结果、恢复/验证与资源消耗。

**工作包 F：可复查 Markdown 报告，P1。**

- 报告复用同一快照上的投影和分析，包含目标、执行结果、关键行动、错误恢复、资源消耗、优化建议与证据引用。
- 注明来源、指纹/快照标识、统计范围、分析版本和重要数据限制。
- 报告导出与现有 JSON 审计导出互补；不调用新模型，不自动上传，不重新生成一套结论。
- 脱敏和内容边界在服务端统一处理，不能把浏览器截断后的预览误当完整报告。

落点：`server/api.ts`、`server/diagnosis` 的冻结方法、已有分析器和导出入口。

验收：报告与该快照的页面结论一致；导出过程中会话改变时冻结一致版本或明确失败；证据引用在材料中可解析；来源缺失与推断不被删除；敏感字段仍按现有规则处理。

阶段三中 F 可在阶段一后提前交付最小版，不必等待上下文历史差异或新的 Agent 对照协议。

### 3.7 实施顺序、成功标准与范围

建议依次交付：A 多证据审阅 → B 问题与资源定位 → C 会话检索 → D 上下文查看与有条件差异 → E 评测证据联动。F 报告在 A/B 完成后可独立推进。每次交付直接可用，不先建设完整六对象模型或通用插件平台。

所有工作包沿用两个顶层工作区“会话分析”和“评测中心”。新增界面必须嵌入实际分析路径，避免一个指标再长出一个独立页面。

验收以合成契约场景和实际使用任务为准，至少覆盖：

1. 工具报错后修改输入、再次成功并验证，能看清整条链。
2. 缺少工具输出或来源不提供时间，不生成虚假的成功/失败或耗时判断。
3. 同一会话有并行、嵌套工具，计量和关系保持一致。
4. 两条标题或开头相同的会话能区分；父关系不明确时不强连。
5. 搜索超时、取消、部分来源失败，结果状态与实际扫描范围一致。
6. 只有上下文片段时不生成完整请求；有明确替换事实时能核对变化。
7. baseline 不可比时维持门禁；可比差异能定位冻结证据。
8. 导出和查看对应同一快照；新增搜索、报告和比较均不改来源数据。

首个版本范围建议锁定 A、B。完成的标准是“能从一个问题或结论找到全部相关证据，并知道判断限制”，而非增加页面数量。之后再进入 C、D，最后增强 E/F。

测试按工作包增量补充到已有 source、projector、analysis、evaluation、API 和组件测试。首批已执行受影响测试、全量测试、类型检查和构建，并使用仅含合成记录的本地服务完成浏览器验证。后续工作包仍按各自验收要求独立验证。

## 4. 实现借鉴与复用注意事项

Magpie 和本项目均为 MIT。复用有实质性的源码或文本时需保留对应版权与许可说明。Go 网关和普通 JavaScript 页面不能直接作为本项目 TypeScript/React 模块复制使用；更适合迁移数据契约、时间映射算法、边界处理及测试案例设计。[M25][L1]

优先复用本项目已有模型与组件。不要把 Magpie 的账号配额、Provider 生命周期、S3 同步和客户端修改逻辑一起带入。也不要迁移一大套特定供应商错误正则来推断本项目没有观察到的路由行为。

外部 Magpie 分析采用静态源码核对，没有执行其构建、测试或真实模型调用；其性能数字、线上行为和端到端兼容性没有在本机复测。文中的外部容量和时间常量对应上述固定提交，后续版本可能变化。本项目首批开发验证状态见第三节。

## 源码索引

所有 Magpie 链接固定到本次读取的提交。`L` 链接指向本项目已有文件，便于继续实现。

- [M1：Routing / Sessions 页面插件][M1]；[Sessions 插件注册](https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/plugins/sessions/sessions.go)。
- [M2：Route、Weighed、Try、trace 状态和计数][M2]。
- [M3：路由页面、Replay 播放时钟与跳转][M3]。
- [M4：Prompt 分类与估算、校准、协议解析][M4]。
- [M5：候选、路由组与故障处理][M5]；[策略接口](https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/routes/routes.go)。
- [M6：GUI trace、历史、标题和解除冷却 API][M6]。
- [M7：按天路由历史与保留策略][M7]。
- [M8：轻量 route-events SSE][M8]。
- [M9：Prompt 正文缓存][M9]；[上下文 API](https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/gui/context.go#L823)。
- [M10：Session 统一模型与解析缓存][M10]；[管理模型与删除支持](https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/sessions/manage.go#L17)。
- [M11：原生正文能力和按需读取][M11]；[原生/网关合并](https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/sessions/external.go#L26)。
- [M12：Session Header 身份][M12]；[会话亲和性](https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/gateway/affinity.go#L524)。
- [M13：上下文及 DSH 路由归属][M13]。
- [M14：Recent calls、capture 与请求详情][M14]；[请求详情 API](https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/gui/providers.go#L1351)。
- [M15：TryNet 与 Go HTTP 计时][M15]。
- [M16：请求归档][M16]；[本地归档](https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/gateway/archive_local.go)。
- [M17：Usage ledger 匹配与计价][M17]。
- [M18：真实候选循环与 Try、失败计量][M18]。
- [M19：子会话读取][M19]；[Codex 身份与回复匹配](https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/usage/codex_identity.go)。
- [M20：网关对话保存与重建][M20]；[客户端交换采集](https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/gateway/conversations.go#L59)。
- [M21：搜索读取器][M21]；[搜索预算及管理 API](https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/gui/sessions_manage.go#L391)；[会话前端](https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/gui/assets/plugins/sessions/client.js)。
- [M22：跨 Agent 转换][M22]；[会话 API](https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/gui/sessions.go#L345)；[读取授权](https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/sessions/access.go)；[Codex 恢复](https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/sessions/codex_resume.go#L68)；[Claude 目录迁移](https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/sessions/relocate_claude.go#L18)。
- [M23：原生调用模型与共享增量读取][M23]。
- [M24：README 的中间件功能清单][M24]。
- [M25：MIT License][M25]。

[M1]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/plugins/routing/routing.go
[M2]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/gateway/trace.go
[M3]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/gui/assets/plugins/routing/client.js#L5012
[M4]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/gateway/prompt.go
[M5]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/gateway/fallback.go
[M6]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/gui/trace.go
[M7]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/gateway/history.go
[M8]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/gateway/route_events.go
[M9]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/gateway/prompt_text.go
[M10]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/sessions/sessions.go
[M11]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/sessions/transcript.go
[M12]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/gateway/gateway.go#L9148
[M13]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/gui/context.go#L250
[M14]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/gateway/capture.go
[M15]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/gateway/nettrace.go
[M16]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/gateway/archive.go
[M17]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/usage/ledger.go
[M18]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/gateway/gateway.go#L3066
[M19]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/sessions/subagents.go
[M20]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/sessions/gateway.go
[M21]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/sessions/search.go
[M22]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/sessions/carry_convert.go
[M23]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/internal/sessions/calls.go
[M24]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/README.zh-CN.md#L239
[M25]: https://github.com/yetone/magpie/blob/4ef47b3f4d45342c50cda88a50149f12959c5499/LICENSE
[L1]: ../README.md
[L2]: ../src/types.ts
[L3]: ../server/sources/registry.ts
[L4]: ../server/sources/codex.ts
[L5]: ../CONTRIBUTING.zh-CN.md
[L6]: ../src/trajectory-analysis.ts
[L7]: ../src/components/TrajectorySummary.tsx
[L8]: ../src/App.tsx
[L9]: ../src/trajectory-evaluation.ts
[L10]: ../server/evaluation/runner.ts
[L11]: ../src/components/EvaluationCenter.tsx
[L12]: ../SECURITY.zh-CN.md
[L13]: ../server/diagnosis/service.ts
[L14]: ../src/token-usage.ts
[L15]: ../src/components/TrajectoryStory.tsx
