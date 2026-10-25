# 第 10 路调研：gf-preview 第 17 锚点的 Agent 机评实践对比

## 1. 来源元信息与访问状态

- 研究对象：`https://zwmqug.gf-preview.bytedance.net/#17`
- 页面标题：`基于 Fornax 的剧创 Agent 机评建设实践`
- 页面类型：内部预览站单页幻灯片，共 31 页 `.slide`。
- 访问状态：使用现有 Chrome 登录态可访问。浏览器地址栏保持 `#17`，但页面首次可见仍是第 1 页；因此本报告通过只读 DOM 抽取全部幻灯片文本并按 `.slide` 顺序定位第 17 页。
- 抽取时间：浏览器侧记录 `2026-10-24T14:59:51.709Z`（北京时间 2026-10-24 22:59:51）。
- 操作边界：只读浏览、DOM 文本抽取和本地代码读取；未点击提交、未编辑页面、未触发生成、未下载文件、未改变外部系统状态。
- 证据边界：能看到页面内嵌的 31 页正文和 `data-notes` 讲稿；未访问“分享文档 2026-09”原文，也未验证 Fornax / ByteVal 后台真实配置。因此下文只引用预览页可见内容，不推断后台实现细节。

## 2. 页面 / 分享核心内容

这份分享的主线是：剧创 Agent 的版本回归不应只给总分，而要把“机器跑全量、证据化定位、人只看关键 case”工程化。封面明确评测对象覆盖“分镜 / 资产 / 图片 / 视频”，目标是把人工完整观看、凭经验定位问题，升级为机器先跑全量并定位证据。

必要上下文如下：

- 剧创链路是从剧本解析、资产生成、分镜与提示词、单镜生成到整集拼接的生成 Agent 链路；低质成片可能由上游漏信息、资产 Prompt 错误或下游模型未响应共同造成。
- 方法论强调六点：沿链路分层、按维度选择无参考 / 输入参考 / Gold、Python 负责确定性检查、LLM/VLM 负责语义与画面、证据优先、三分制保留解释且二值化统计、人机闭环。
- 评估成熟度分层：分镜 Prompt 已可稳定回归；资产 Prompt、资产图片、单镜视频主要作为高风险初筛和人工 Review 前置助手。
- 评估器合同先行：输入、输出、评分规则、覆盖范围、排除项先锁定，再进入 Prompt / 规则校准 loop；系统失败、字段映射错误、分镜对齐失败不能写成质量 1 分。
- 验收不能只看总体一致率，还要看问题精确率、问题召回、正控通过率和多次运行稳定性。

第 17 页是本路重点。该页标题是“Target 取数：现有项目 vs 自动建项”，把 Fornax Target 取数拆成两个模式：

| 模式 | 页面表述 | 适用场景 | 关键机制 |
| --- | --- | --- | --- |
| `existing_project` | “读已经存在的 stable 项目” | 版本对比和固定回归 | 评测集只写 URL；关键是协议兼容与环境健康检查 |
| `auto_create_project` | “给一份新剧本就能评” | 冒烟和新样本接入 | 用剧本 blob、team、Agent 版本和生成配置哈希出 `project_reuse_key`，避免同一剧本被建多次 |

第 17 页还给出两个重要约束：两种模式共用同一个 Target 服务，由评测集 `meta` 的模式字段路由；真实 Target 实验不要使用回放结果。

## 3. 关键产品能力与交互

### 3.1 Fornax 主链路是“评测集 × Target × 评估器 × 实验 × Report/Trace”

第 16 页把一次评测抽象成五个对象：评测集保存输入、参考或 Gold 以及脚本定位信息；Target 从剧创平台拉取真实分镜或资产产物；评估器由 Python 检查和 LLM 语义质量判断组成；实验绑定评测集、Target、评估器和字段映射；Report / Trace 展示逐条结果、聚合指标和失败证据。

这个交互模型的关键不在“多一个评测页面”，而在把输入、产物拉取、判断逻辑、字段映射和证据回看拆成稳定边界。它使第 17 页的 Target 模式成为评测系统的核心接口，而不是临时脚本。

### 3.2 Target 模式把“固定回归”和“新样本冒烟”分开

第 17 页最值得借鉴的是 Target 输入模式拆分：

- `existing_project` 是对已有 stable 项目的只读拉取，更适合版本对比、固定回归和可复核结论。
- `auto_create_project` 是从新剧本自动建项，更适合冒烟和新样本接入，但必须用 `project_reuse_key` 去重，避免重复创建外部项目。

这里的产品设计实际是在处理两个不同的评测问题：一个需要固定对象和可重复比较，另一个需要扩大样本覆盖并降低接入成本。如果混在一个入口里，容易出现“回归集被动态生成污染”或“冒烟流程反复建项”的风险。

### 3.3 真实 Target 与回放结果明确隔离

第 17 页明确写到“真实 Target 实验不要使用回放结果”。结合第 20 页 V1.6 实践，“正式实验固定评测集、评估器、Target 快照和字段映射”，且“不使用回放结果，跑全量并下载行级证据”。这说明分享方把“真实系统当前产物”和“历史回放 / 缓存产物”视为不同证据等级。

对评测产品而言，这个边界能避免两类误判：

- 用旧回放掩盖当前真实环境的协议、字段或生成质量问题；
- 把真实环境故障误记为内容质量低分，而不是单独的合同 / 取数失败。

### 3.4 对齐失败是单独状态，不是质量差

第 18、19 页解释了 Gold 与 Agent 独立决定分镜边界后，按序号对齐会在第一次 1:N 或 N:1 拆合处开始整体错位；解决方案是集级批处理、分镜级判分，允许 1:1、1:N、N:1，对齐失败单独 Review。

这和第 8、9、13 页的原则一致：合同失败、系统失败、字段映射错误和不可判断不应进入质量分母。第 17 页的 Target 模式如果取数或映射失败，也应单独记账。

## 4. 与当前 Agent Trajectory 的映射

### 4.1 当前项目已有“existing_project”式只读 Target：来源 + 会话 ID

Agent Trajectory 的基础定位是“独立、只读的多来源 Agent 轨迹查看器”，把 DeepSeek Harness、Codex、ZCode 的本地会话投影到统一时间线、虚拟账本和检查器中（`README.md:1-4`）。来源事实源分别是本地 DSH session、Codex rollout JSONL、ZCode SQLite（`README.md:6-18`）。

这对应 Fornax 的 `existing_project`：当前的 Target 不是外部剧创项目 URL，而是 `(source, sourceSessionId)` 指向的本地真实 Agent 会话。相关证据：

- `SourceId` 固定为 `dsh | codex | zcode`，并声明消息、工具、计时、usage、trace、lineage、policy、tasks 等能力位（`src/types.ts:3-24`）。
- `SessionSummary` 保留 `source`、`sourceSessionId`、`format`、`capabilities`、`cwd`、标题、更新时间和大小（`src/types.ts:268-281`）。
- API 详情路由必须显式携带来源：`GET /api/sessions/:source/:id`，返回 snapshot 或 delta（`README.md:280-292`；`server/api.ts:596-620` 还提供审计导出）。
- `SourceRegistry.load()` 通过 adapter fingerprint 判断缓存是否可复用，fingerprint 不变才复用 detail，否则重新读取真实来源（`server/sources/registry.ts:147-158`）。

因此当前项目已有稳定回归所需的“固定对象读取”基础，只是没有把它命名为 Target，也没有在 UI / 报告里显式展示 Target 模式。

### 4.2 当前项目已有“真实 Target vs 冻结快照”的边界

普通查看时，Agent Trajectory 声明“原始轨迹始终留在对应 Agent 的目录中，不复制、不上传”；只有用户主动启动轨迹诊断时，才写入本地私有、脱敏的冻结快照（`README.md:78-80`）。诊断服务在冻结前后读取 fingerprint，只有两次 fingerprint 一致才创建证据快照；如果期间目标变化则返回 409，要求会话静置后重试（`server/diagnosis/service.ts:90-112`）。

这和第 17 页“真实 Target 实验不要使用回放结果”的原则一致，但 Agent Trajectory 更偏本地隐私和审计：

- `DiagnosisEvidenceStore.create()` 将 `sourceFingerprint`、脱敏后的 `TransportSessionDetail` 和本地 `analyzeTrajectory()` 结果一起写入私有快照（`server/diagnosis/evidence-store.ts:83-107`）。
- 诊断会话只接收评测器身份、来源、`session_id`、快照 ID 和只读取证命令，不注入整段轨迹，也不读取持续变化的源会话（`README.md:131-143`）。
- 证据查询按 `overview / findings / records / record` 读取，并对大字段做字节限制和截断标记（`server/diagnosis/evidence-query.ts:79-147`）。

差异是：Fornax 第 17 页显式把模式写在评测集 `meta` 中路由；当前项目是通过“普通详情读取”和“诊断冻结快照”隐含区分，尚未形成一个可展示、可导出的 Target contract。

### 4.3 当前项目的证据化定位已经较接近 Report / Trace

页面的 Report / Trace 强调逐条结果、聚合指标和失败证据。Agent Trajectory 已有类似能力：

- 每条展示记录保留 `source / sourceEventIds / fidelity` provenance（`README.md:202-203`；`src/types.ts:148-197`）。
- `TrajectoryRecord` 包含 `traceId/spanId/parentSpanId`、`callId/parentCallId`、输入、输出、错误、usage、metrics、policy 和 raw 证据等字段（`src/types.ts:148-197`）。
- 轨迹评测视图区分轨迹事实、相邻步骤推断和来源未记录，不会在缺少测试、断言或业务真值时把“没有报错”表述为“结果正确”（`README.md:220-224`）。
- 优化建议展示问题、原因、推荐措施、实施位置、预期改善、验证方式和判断限制；建议只用于展示，不会自动修改代码、规则、Hook、插件或环境（`README.md:225-230`）。
- UI 里的 `EvidenceButton` 可从分析结论反向定位到轨迹记录（`src/components/TrajectorySummary.tsx:151-181`），优化面板也只展示有证据的可执行改进并提供证据定位（`src/components/OptimizationPanel.tsx:102-120`、`src/components/OptimizationPanel.tsx:202-218`）。

当前缺口是：Fornax 把“评测对象、评估器、字段映射、Target 快照、实验”作为一次实验的可复现实体；Agent Trajectory 现在更多是对单条会话的查看、投影和诊断，缺少跨版本 / 跨样本的实验实体和指标矩阵。

### 4.4 当前项目已有评测维度，但还不是“人机一致率”体系

Agent Trajectory 的本地分析有五类评价：`outcome / reliability / recovery / efficiency / observability`（`src/trajectory-analysis.ts:62-70`），并有 `OptimizationSuggestion` 的价值、证据、验证和限制字段（`src/trajectory-optimization.ts:24-43`）。这些适合解释“这个 Agent 过程是否可靠、高效、可观察”。

Fornax 分享的指标体系则围绕“机器判断与人评 Gold 是否一致”，包括一致率、问题精确率、问题召回、正控和稳定性。当前项目如果要做“Agent 评测”而不只是“轨迹解释”，需要引入人工标签或固定 Gold case；否则不应照搬一致率指标。

## 5. 候选优化

| 候选项 | 价值 | 成本 | 风险 | 验证方式 |
| --- | --- | --- | --- | --- |
| 显式引入 `EvaluationTarget` / Target contract，记录 `source`、`sourceSessionId`、fingerprint、模式（live / frozen）、字段边界和排除项 | 高：把当前隐含的真实读取与冻结快照变成可展示、可导出的评测输入；便于跨会话复核 | 中：涉及类型、API、UI 和导出 | 中：命名不当会让用户误以为可写外部 Target；需保持只读语义 | 单元测试覆盖 live detail、frozen diagnosis snapshot、导出中 contract 完整；fingerprint 变化时能标记过期 |
| 为诊断快照增加可选 deterministic reuse key，类似 `project_reuse_key`：`source + sessionId + fingerprint + evaluator + analysisSchema` | 中高：避免同一会话同一 fingerprint 反复创建等价快照，降低本地噪音 | 低到中：当前 `snapshotId()` 含 `randomUUID()`，需要新增索引或复用查询 | 中：不能复用已被清理、权限变化或 schema 变化的快照；错误复用会污染诊断 | 对同一 fingerprint 连续启动诊断时复用；fingerprint、evaluator 或 schema 变化时新建；快照清理后可重建 |
| 将当前五维过程评测沉淀为“评估合同”：输入字段、输出字段、覆盖范围、排除项、不可判断状态和证据等级 | 高：减少“没有报错 = 成功”之类误读，也方便外部 Agent 诊断复用同一口径 | 中：需要文档、类型和测试 fixture | 低：主要是显式化已有规则 | 对每个 evaluation 增加 contract fixture；缺证据时必须落到 `unknown` 或限制说明，而不是正/负结论 |
| 建立固定回归集 / 校准集 / 挑战集 / 独立测试集的本地会话清单，复用 `verify-real-sources` 的 explicit 模式但要求会话静置和 fingerprint 记录 | 高：把“轨迹查看器”推进到“Agent 行为回归评测” | 中：需要样本管理、隐私边界和本地-only 产物约定 | 中高：真实会话可能包含敏感内容，不能提交公开仓库；样本 drift 会影响结论 | 只输出脱敏摘要、hash 和指标；显式 ID + fingerprint 固定；会话继续写入时报告过期 |
| 在优化建议里增加“问题精确 / 召回”试验入口，但只对人工标注过的问题类型启用 | 中：可衡量本地规则优化建议是否真的抓到问题 | 高：需要人工标签和评测集 | 高：无 Gold 时指标会伪精确；不同任务类型主观性强 | 先选重复读取、原样重试、验证缺口三类确定性问题；用人工标注小集合计算 TP/FP/FN |
| 将“对齐失败 / 字段缺失 / 来源降级”从质量评价中更醒目地拆出为合同失败统计 | 中：与 Fornax “合同失败不是质量分”一致，能减少误诊 | 中：需要 UI 和分析层调整 | 低到中：过度拆分可能增加认知负担 | 构造 raw-only、unsupported、缺 trace、缺 usage、snapshot 截断等 fixture，确认不拉低 outcome 但进入 observability / contract gap |

## 6. 不建议照搬项

- 不建议照搬 `auto_create_project` 的外部建项能力。Agent Trajectory 的产品边界是 local-first、read-only；自动创建外部项目、触发生成或写入云端与当前安全边界冲突。可以借鉴 `project_reuse_key` 的去重思想，但不应引入外部副作用。
- 不建议在没有人工 Gold 的情况下照搬人机一致率、问题精确率和召回率。当前轨迹分析可以判断过程证据、错误恢复和验证缺口，但不能凭轨迹证明业务结果正确。
- 不建议把三分制直接用于所有 Agent Trajectory 结论。Fornax 的 3/2/1 面向具体内容质量；Agent 轨迹同时包含可靠性、效率、安全、可观察性和结果完整性，当前五维评价更贴合。
- 不建议把视频 / 图片 VLM 评估作为近期主线，除非当前项目开始稳定接入 artifact、截图或浏览器录制。否则会扩大隐私和存储面，且偏离轨迹事实分析。
- 不建议把“真实 Target 不用回放”理解为禁止缓存。Agent Trajectory 当前 fingerprint 缓存、snapshot/delta 和诊断冻结快照是性能与复核机制；关键是标明证据等级和过期条件，而不是取消缓存。

## 7. 证据清单

### 7.1 内部预览页证据

- S1：封面，第 1 页：标题为“基于 Fornax 的剧创 Agent 机评建设实践”；目标表述为把版本回归从“全量观看、凭经验找问题”变成“机器先跑全量、证据化定位、人只看关键 case”；评测对象为“分镜 / 资产 / 图片 / 视频”。
- S6：第 6 页“先立口径，再谈分数”：六条原则包括沿链路分层、按维度选参考、不只是 LLM 判分、证据优先、三分制二值统计、人机闭环。
- S8：第 8 页“机评 ≠ LLM-as-Judge”：Python 处理确定性检查，LLM/VLM 处理语义与画面；合同失败不是质量分。
- S12：第 12 页“先定合同，再进入校准 Loop”：评估合同包括输入、输出、评分规则、覆盖范围、排除项；每轮只优化一个变量。
- S13：第 13 页“Gold 进评测集，产物留给 Target”：Agent 动态产物由 Target 在实验中读取；对齐失败不计质量低分。
- S14：第 14 页“判断机评能不能用，不能只看一致率”：同时看一致率、问题精确、问题召回、正控通过率和稳定性。
- S16：第 16 页“For­nax 主链路”：一次评测包含评测集、Target、评估器、实验、Report / Trace。
- S17：第 17 页“Target 取数：现有项目 vs 自动建项”：`existing_project` 读已存在 stable 项目；`auto_create_project` 从新剧本建项；两种模式共用 Target 服务，由评测集 meta 路由；真实 Target 实验不要使用回放结果。
- S18-S19：第 18、19 页：按序号对齐分镜会在拆合处错位；方案是集级批处理、分镜级判分、语义对齐，允许 1:N / N:1，对齐失败单独 Review。
- S20-S21：第 20、21 页：V1.6 正式实验固定评测集、评估器、Target 快照和字段映射；分镜 Prompt 98.8% 抽样一致率，资产图片 86.3%，单镜视频约 70%，且需结合精确率和召回率看。
- S27-S28：第 27、28 页：复杂空间、低可比身份、过细字面对齐仍交给人；主观审美、字幕音画运镜跨镜、纯技术质量是当前评估器合同外。

### 7.2 本地项目证据

- `README.md:1-4`：项目定位为独立、只读、多来源 Agent 轨迹查看器。
- `README.md:6-18`：三类来源与本地事实源；ZCode 读取正式表且不读取凭证、Cookie、浏览器存储或模型请求头。
- `README.md:78-80`：普通查看不复制、不上传原始轨迹；诊断时才写入私有脱敏冻结快照。
- `README.md:120-150`：本地轨迹诊断、只读取证命令、固定报告结构和证据不足时的处理。
- `README.md:220-230`：轨迹评测、优化建议、证据定位和不会自动修改外部状态。
- `README.md:280-292`：详情接口的 snapshot / delta 机制和显式来源路由。
- `README.md:315-326`：安全边界，包括 loopback、opaque session ID、ZCode readOnly、敏感键脱敏、不修改原应用。
- `src/types.ts:3-24`：来源与能力类型。
- `src/types.ts:148-197`：`TrajectoryRecord` 的 provenance、trace/span、输入输出错误、usage、policy、raw 等证据字段。
- `src/types.ts:268-295`：`SessionSummary`、`SessionDetail`、`TransportSessionDetail`。
- `server/sources/registry.ts:147-158`：按 fingerprint 复用或重读 detail。
- `server/sources/registry.ts:178-227`：raw、audit、fingerprint 的读取路径和源缺失处理。
- `server/diagnosis/service.ts:90-112`：冻结诊断证据时用 before/after fingerprint 保证稳定。
- `server/diagnosis/evidence-store.ts:83-107`：诊断快照包含 evaluator、target、sourceFingerprint、脱敏 detail 和本地分析。
- `server/diagnosis/evidence-query.ts:79-147`：诊断证据按 overview/findings/record/records 查询，并做分页和截断。
- `server/api.ts:374-394`：`POST /api/diagnosis` 启动诊断。
- `server/api.ts:596-620`：审计导出包含脱敏 detail 和 sourceEvents。
- `src/trajectory-analysis.ts:62-70`：当前五维过程评价。
- `src/trajectory-optimization.ts:24-43`：优化建议结构包含证据、预期收益、验证和限制。
- `src/components/TrajectorySummary.tsx:151-181`：分析结论可定位证据记录。
- `src/components/OptimizationPanel.tsx:102-120`、`src/components/OptimizationPanel.tsx:202-218`：优化建议只展示有证据的可执行改进，并提供证据定位。
