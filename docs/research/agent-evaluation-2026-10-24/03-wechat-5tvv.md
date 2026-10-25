# 03 路调研：微信《AI Agent 应用精细化评测：评测体系设计与工程实践》

调研日期：2026-10-24
研究对象：https://mp.weixin.qq.com/s/5Tvv8g20CybjbT0a7iUfHw
本地对象：`agent-trajectory` 当前工作区，只读检查源码与文档
产出限制：本报告仅新增本文件；未修改仓库其他文件

## 1. 来源、作者、日期与访问状态

| 项目 | 结论 |
| --- | --- |
| 主文标题 | 《AI Agent 应用精细化评测：评测体系设计与工程实践》 |
| 公众号 / 转载来源 | 页面展示公众号为“阿里技术”；页面 `copyright_info` 显示转载来源平台为“AliExpress技术”，`reprint_url` 指向原公众号文章 |
| 作者 | 砚东 |
| 发布时间 | 页面 `create_time` 为 `2026-09-02 18:11`；`ori_create_time=1788343894`，换算为 `2026-09-02 18:11:34 +08:00` |
| 访问状态 | 主 URL 可通过普通 HTTP 抓取到完整微信 HTML，HTTP 200，约 4.0 MB；正文 `content_noencode` 可解析，抽取正文约 2.3 万字 |
| 访问缺口 | 正文图片未做 OCR；本文链接的两篇微信关联文章普通请求只返回约 17.8 KB 跳转/验证壳，未获取正文，未据其标题推断内容 |
| 引用的一手资料 | 开头英文引语来自 Anthropic 第一方文章《Demystifying evals for AI agents》，已访问 Anthropic 官网原文并确认标题、发布日期、引语与关键定义 |

说明：`research` skill 要求优先追溯一手资料并保存 Markdown。当前会话没有可用的独立后台 agent 工具，因此本轮由主 agent 直接完成检索、核验和写入。

## 2. 文章核心方法

这篇分享的核心观点是：Agent 评测不能只看最终答案，而要按 Agent 架构把评测拆到中间链路，并把质量、成本、性能放在同一张评测视图里。

文章把商品中心 Agent 抽象为四个核心模块：

- 感知模块：识别用户意图、判断是否命中 Skill，未命中时降级到知识库检索。
- 规划模块：在 Skill、RAG、工具、记忆等路径之间做执行决策。
- 记忆模块：维护短期多轮上下文，并通过 RAG 注入长期知识。
- 工具模块：通过 MCP 和文件系统 Skill 管理工具，并统一封装为 Agent 可调度接口。

评测体系随之拆成两层：

- 端到端评测：回答用户视角的“任务有没有完成”，关注任务完成质量、成本消耗、完成效率、安全鲁棒性。
- 核心模块评测：回答“问题出在哪个内部环节”，按感知、规划、记忆、工具四类模块分别评估。

文章强调三类指标必须同时看：

- 质量：任务是否完成、是否忠实于知识/工具/上下文、是否幻觉、是否遵循指令。
- 成本：模型调用次数、工具调用次数、输入/输出 Token。
- 性能：首 Token 延迟、端到端响应延迟、模块级延迟。

工程上，文章提出一个批量评测执行链路：

1. 提交评测请求，指定 `datasetType` 和 `evalMode`。
2. 根据评测范围自动装配数据集。
3. 并发执行用例，单条 120 秒超时，执行异常最多重试 2 次。
4. 对单条用例注入 `sessionId` 与 Mock 数据，调用 Agent 完整链路。
5. 采集 `EvalTrace`：感知、规划、记忆、工具、RAG、Token、延迟等中间数据。
6. 把 Agent 输出和 `EvalTrace` 一起交给结构化 Judge Task。
7. 生成质量 × 成本 × 性能报告，并按每个数据集/评测模式的主指标决定 case 是否通过。

这里的关键不是“用 LLM 打一个总分”，而是把 Judge Task 拆成结构化、单一职责、可计算的评判任务。文章特别提醒：如果路由已经错误，依赖 RAG 证据的下游指标（忠实性、检索精确率、检索召回率）应标记为 `error/skip` 并从分母中排除，避免上游错误污染下游指标。

## 3. 关键能力、指标与案例

### 3.1 数据集设计

文章设计了 8 类评测集，并给出建议规模：

| 数据集 | 覆盖能力 | 文章给出的规模建议 |
| --- | --- | ---: |
| 基础技能评测集 | 任务完成率、指令遵循、意图识别、路由决策、规划路径 | ≥ 50 条 |
| 知识问答评测集 | 任务完成、忠实性/幻觉、降级触发、RAG 检索精确率/召回率 | ≥ 100 条 |
| 多轮对话评测集 | 多轮完成率、短期记忆保留率 | ≥ 10 组 |
| 异常输入评测集 | 空输入、超长文本、乱码、特殊字符、Prompt 注入等鲁棒性 | ≥ 20 条 |
| 工具调用评测集 | 工具决策、工具准确率、工具成功率、参数映射 | ≥ 20 条 |
| 多意图评测集 | 复合意图拆解完整性 | ≥ 20 条 |
| 模糊意图评测集 | 澄清、合理推断、避免幻觉 | ≥ 20 条 |
| 长对话衰减评测集 | 第 2/3/5 轮等位置的记忆保留曲线 | ≥ 10 组 |

一条用例不是简单的“输入 + 参考答案”，而是复用型标注对象。文章示例字段包括 `id`、`sceneCode`、`sceneName`、`userInput`、`expectedSkill`、`expectedRoute`、`expectedIntent`、`bizCode`、`datasetType`、`evalMode`、`mockDataId`、`referenceOutput`、`expectedKnowledge`、`conversationChain` 等。

### 3.2 Judge Task / Judge Prompt

文章把 LLM-as-Judge 的可靠性落到四条 Prompt 设计原则：

- 单一职责：一个 Prompt 只评一个指标。
- 先给评判理由再给结论：用于提升可解释性；在本项目语境中应输出“可展示理由”，不能展示或要求隐藏思维链。
- 负例引导：在 Prompt 中提供通过/不通过的典型对照。
- 结构化输出：严格 JSON，便于自动化解析和指标统计。

用例是否通过不做所有指标 AND，而是按评测模式/数据集选主指标。例如端到端评测看任务完成率，感知模块评测看意图识别准确率，规划模块评测看路由决策准确率，工具模块评测看工具调用准确率，异常输入评测看异常输入处理率。

### 3.3 Mock / Real 双模式

文章明确区分两种模式：

- `E2E_REAL`：走真实 LLM、真实工具、真实知识库，适合知识问答和不依赖实时外部工具的 Skill 评测，但会受外部依赖抖动影响。
- `E2E_MOCK`：工具返回由 Mock 固定，Agent 的推理和决策仍真实执行，适合 Trace 排查、可售性分析、标签分析等依赖外部实时工具的场景，目标是可复现。

这对本项目很重要：Agent Trajectory 当前是只读轨迹查看器，不应直接变成执行器；但可以优先支持“导入/展示已经由外部评测系统产生的 Real/Mock 评测结果和 EvalTrace”。

### 3.4 可视化与产品化

文章看板能力包括：

- 选择评测范围后自动装配数据集与指标。
- 展示历史评测记录、运行状态、取消、分页、JSON 导入/导出。
- 质量、成本、性能三列仪表盘。
- 场景通过率排序，快速定位薄弱业务场景。
- 用例明细可展开查看失败原因、命中技能、路由结果、Token 明细、用户输入、Agent 完整输出。
- 平台化配置：按 Agent + Graph 挂载数据集，按数据集关联 Judge Prompt 模板，按场景自动关联可用评测范围。

文章给出的失败案例很典型：

- 知识问答未能检索到核心信息，回答“知识库未提及”，任务未完成。
- 错误码识别对了，但解释和代码片段编造，真实原因是商品不存在，属于忠实性/事实错误。
- 多轮对话第 2 轮用户只补充“美国”，Agent 丢失第 1 轮商品上下文，要求用户提供更具体信息，属于短期记忆失败。

## 4. 与当前 Agent Trajectory 能力映射

### 4.1 当前项目已有的强项

| 文章能力 | 当前项目对应能力 | 本地证据 |
| --- | --- | --- |
| 运行时 Trace / EvalTrace | 项目已把 DSH、Codex、ZCode 投影为统一 `TrajectoryProjection`，记录 `records`、`turns`、`usage`、`metrics`、`traceId/spanId`、`policy`、`retry`、`relations` 与 `coverage` | `src/types.ts::TrajectoryProjection`、`src/types.ts::TrajectoryRecord`、`src/types.ts::TrajectoryTurnSummary` |
| 质量 × 成本 × 性能中的成本/性能观测 | Token、TTFT、耗时、模型/工具 usage 在统一类型中表达；ZCode 投影读取 model/tool/turn usage，Codex 投影读取 `token_usage_record` | `src/types.ts::TokenUsage`、`src/types.ts::TrajectoryMetrics`、`server/projectors/zcode.ts::ZcodeModelUsageRow`、`server/projectors/zcode.ts::ZcodeToolUsageRow`、`server/projectors/codex.ts::tokenUsage` |
| 中间链路下钻 | 前端“轨迹评测”以步骤、纠错链、证据定位、故事线展示模型行动和恢复过程 | `src/trajectory-analysis.ts::AnalysisStep`、`src/trajectory-analysis.ts::AnalysisCorrection`、`src/components/TrajectorySummary.tsx` |
| 过程评测维度 | 当前已有五维：结果证据、路径稳定性、恢复能力、资源效率、可观测性；明确没有业务真值时不判断正确性 | `src/trajectory-analysis.ts::AnalysisEvaluation`、`src/trajectory-analysis.ts::buildEvaluations` |
| 优化建议 | 本地规则已能发现重复读取、确定性重试、环境缺失、最后修改未验证、未恢复错误，并给出可执行动作 | `src/trajectory-optimization.ts::analyzeTrajectoryOptimizations`、`src/components/OptimizationPanel.tsx` |
| LLM 增强但不篡改事实 | AI 增强只接收本地事实包，事实/数字/ID/证据关系保持本地权威，输出必须通过 evidence id 校验 | `src/trajectory-facts.ts::buildSummaryFacts`、`server/summary/engine.ts::factsPrompt`、`server/summary/engine.ts::validateDraft` |
| 诊断会话 | 可冻结只读、脱敏快照，再让受控 `trajectory-diagnosis` skill 读取证据生成报告 | `server/diagnosis/service.ts::TrajectoryDiagnosisService`、`server/diagnosis/evidence-store.ts::DiagnosisEvidenceStore`、`README.md`“本地轨迹诊断” |
| 覆盖率/可观测性缺口 | DSH 投影按 `record/folded-state/relation-only/raw-only/unsupported` 统计 coverage，避免把未解释事件假装成已支持 | `src/projector.ts::eventDisposition`、`src/projector.ts` coverage 生成逻辑 |

总体看，Agent Trajectory 已经具备“读懂单条真实轨迹、解释过程、定位证据、给优化建议”的基础；它与文章最匹配的是 EvalTrace 解释层和成本/性能观测层。

### 4.2 当前明显缺口

| 文章实践 | 当前项目状态 | 差距判断 |
| --- | --- | --- |
| 评测数据集 / 用例 schema | 当前没有内置 task/case/dataset 结构 | 只能评估一条已发生轨迹，不能按固定用例集做回归 |
| 评测执行引擎 | 当前定位是只读查看器，不执行 Agent 或注入 Mock | 不应照搬执行引擎；可接收外部评测产物 |
| Real / Mock 评测模式 | 当前只有来源轨迹，不标识外部依赖是否 Mock | 可通过导入评测结果补充 `evalMode` 与 mock 证据 |
| 结构化 Judge Task | 当前 AI 增强不是 case-level grader；本地五维评测是轨迹过程评测 | 缺少按指标模板运行/展示 Judge Task 结果的协议 |
| 感知/规划/记忆/工具模块指标 | 当前有 `kind`、`trace/span`、tool/model/context，但没有通用“模块语义”字段 | 需要 source-native 到统一模块 facet 的映射，且必须保留未知/低置信 |
| 路由错误导致下游指标 skip | 当前本地评测还没有指标依赖图与 `skip/error` 分母语义 | 后续引入 case-level eval 时必须先建依赖状态 |
| 历史评测记录、趋势、A/B | 当前更多是当前会话观察；README 提到可复现证据/性能门禁，但不是产品化 eval history | 需要评测 run artifact 和版本/模型对比 |
| 用户反馈转 bad case | 当前优化建议基于轨迹规则；没有把用户反馈结构化为评测样本的工作流 | 可作为后续数据集演化能力 |

## 5. 候选优化项

### P0：先做“评测结果/用例产物导入”，而不是内置执行器

- 价值：在不破坏只读定位的前提下，把文章里的数据集、指标、case 诊断、历史记录接到现有轨迹解释层。外部系统负责跑 Agent、Mock、Real、Judge，本项目负责导入、校验、关联、可视化。
- 建议形态：新增一种 `evaluation run artifact` schema，包含 `runId`、`agentId`、`graphId`、`datasetType`、`evalMode`、`caseResults[]`、`metricResults[]`、`sourceSessionId` 或 `recordIds`、`judgeOutputs`、`cost/performance`。
- 与现有能力衔接：可复用 `TrajectoryProjection` 的 `records/turns/usage/metrics`，以及 `AnalysisEvaluation` 的证据定位模式。
- 成本：M。需要 schema、fixture、导入 API、前端列表与明细页。
- 风险：中。必须防止外部 JSON 注入任意指令；导入文本仍是不可信数据；不能把外部 Judge 分数当成本地事实。
- 验证：构造 2 个 run fixture（Mock/Real），每个含 pass/fail/skip/error；导入后能展示历史记录、case 明细、质量/成本/性能指标，并能跳转到本地轨迹 record。

### P0：补“指标依赖图 + skip/error 分母语义”

- 价值：文章指出的路由错误污染下游 RAG 指标，是评测平台最容易误导人的点。先把 `pass/fail/skip/error` 与依赖原因做成通用协议，可避免未来 Judge Task 结果被错误聚合。
- 建议形态：为评测指标结果增加 `status: pass | fail | skip | error`、`blockedByMetricIds`、`denominatorEligible`、`reason`、`evidenceRecordIds`。
- 成本：S-M。
- 风险：低。主要是 UI 和聚合口径要讲清楚。
- 验证：构造“期望 RAG、实际 Skill 命中”的 case，路由指标失败；忠实性/检索精确率/召回率标记 skip/error，不进入分母。

### P1：建立“模块语义 facet”，把轨迹映射到感知/规划/记忆/工具

- 价值：当前项目能看到 model/tool/context，但还不能回答“这次失败主要是感知、规划、记忆还是工具问题”。文章最可落地的思想是“指标体系与 Agent 架构同构”。
- 建议形态：不要直接扩展为业务专用字段；先做可选 facet：`perception`、`planning`、`memory`、`tool`、`generation`、`verification`、`unknown`。映射必须携带 `source`、`confidence`、`evidence`。
- 可能来源：ZCode `trace/span/query_source`、tool usage、message semantics；Codex 的 response/tool item；DSH 的 event type、step、tool/workflow 等。
- 成本：M。
- 风险：中。跨来源语义不完全等价，过度自动分类会误导；必须允许 unknown。
- 验证：三来源 fixture 各覆盖一次用户输入、规划/推理、工具调用、验证；UI 聚合不改变原 records，只增加 facet 过滤与统计。

### P1：把现有五维“过程评测”扩展为质量/成本/性能三栏视图

- 价值：当前资源效率和可观测性已存在，但展示仍偏“轨迹诊断”；文章的三栏结构更适合评测 run 和版本对比。
- 建议形态：在轨迹评测页增加可切换聚合：质量（结果证据、可靠性、恢复、业务/Judge 指标）、成本（模型调用、工具调用、Token）、性能（TTFT、端到端延迟、模块/工具延迟）。
- 成本：S-M。
- 风险：低。注意没有业务真值时质量只能显示“无法判断/仅过程证据”。
- 验证：没有 Judge 指标的普通会话仍能显示成本/性能；有导入 eval run 时能合并 case-level 质量指标。

### P1：增加评测 run 趋势与 A/B diff

- 价值：文章未来方向里的“趋势可追踪、多模型 A/B”与本项目已有多来源统一模型天然契合。它能回答同一任务在 Codex/ZCode/DSH 或不同模型上的成本、路径、失败点差异。
- 建议形态：基于显式 anchor 对齐，不做低置信文本相似强匹配。支持按 `caseId`、`datasetType`、`agentId/graphId`、`model` 对比通过率、失败原因、Token、延迟、工具调用数。
- 成本：M-L。
- 风险：中。若没有同一 caseId，不应自动比较；跨来源 token 口径不同要标注。
- 验证：同一 `caseId` 的两个 run 可生成 diff；缺少共同 anchor 时 UI 明确“无法对齐”。

### P1：把 bad case 转成“候选评测样本”

- 价值：文章强调评测集自演化；本项目已有轨迹事实、失败/未恢复检测和优化建议，可把真实失败沉淀成待审核样本。
- 建议形态：从失败轨迹或用户反馈生成候选 JSON：`userInput`、`observedOutput`、`failureReason`、`expectedBehavior`、`sourceSessionId`、`evidenceRecordIds`、`redactionWarnings`。默认只导出到本地文件或复制，不自动入库。
- 成本：M。
- 风险：中-高。隐私和凭证脱敏必须严格；候选样本不能未经人工审核直接成为评测集。
- 验证：包含敏感键、工具输出和多轮上下文的失败轨迹导出后通过脱敏测试；人工可编辑后导入为 fixture。

### P2：可选 Judge Task 协议，而非默认 LLM 裁判

- 价值：支持文章的结构化 Judge Task，同时保持本项目“事实本地权威”的安全边界。
- 建议形态：把 Judge 定义为外部/可选 adapter：输入是冻结 facts + case schema + 可选证据，输出必须符合 JSON schema，且所有 `evidenceRecordIds` 必须存在。与当前 AI summary 的 `factsPrompt/validateDraft` 设计保持一致。
- 成本：L。
- 风险：高。LLM 评判可能不稳定、成本高、泄露轨迹文本；必须支持 code-based grader 和人工校准结果导入。
- 验证：同一 case 多次运行有稳定性记录；JSON schema 校验失败可重试/标记 error；不得覆盖本地事实数值。

## 6. 不建议照搬的部分

1. 不建议把 Agent Trajectory 改造成评测执行器。文章的执行引擎需要调用真实 Agent、注入 Mock、控制重试/并发/取消，这会明显突破当前项目“独立、只读、多来源轨迹查看器”的边界。
2. 不建议硬编码商品中心的感知/规划/记忆/工具指标。可以借鉴四模块拆解，但本项目面向 Codex、ZCode、DSH 等通用 agent 轨迹，应做可配置 facet，而不是绑定 IC 商品业务。
3. 不建议默认展示或要求 LLM 输出隐藏思维链。文章的“先推理后判断”在本项目中应转化为可展示的简短理由、判据和证据引用，不能诱导暴露模型隐藏推理。
4. 不建议照搬“3 线程并发、120 秒超时、失败重试 2 次”。这些是文章业务场景里的工程取舍；本项目若接入评测产物，只需记录外部执行策略，不应作为通用默认。
5. 不建议把 LLM-as-Judge 当作唯一真值。当前项目已经明确缺少业务真值时不判断正确性；未来也应保留 code-based/human/model-based 三类 grader 的来源和置信度。
6. 不建议默认持久化完整 prompt、知识库 chunk、工具原始输出。文章的 EvalTrace 对 Judge 有用，但本项目必须延续脱敏、懒加载、私有快照和可删除缓存策略。

## 7. 证据清单

### 外部来源

- E1 主文微信 URL：`https://mp.weixin.qq.com/s/5Tvv8g20CybjbT0a7iUfHw`。HTTP 200，HTML 约 4,008,868 bytes；页面元数据含 `title='AI Agent 应用精细化评测：评测体系设计与工程实践'`、`author='砚东'`、`create_time='2026-09-02 18:11'`、`copyright_info.platform='AliExpress技术'`。
- E2 主文正文：从 `content_noencode` 抽取 HTML 约 193,112 字节，转文本约 23,402 字。本文的模块、指标、数据集、Judge Task、执行引擎、看板、产品化、未来方向均来自该正文。
- E3 Anthropic 第一方文章：`https://www.anthropic.com/research/demystifying-evals-for-ai-agents`。页面标题为《Demystifying evals for AI agents》，发布时间 `Jan 9, 2026`，正文确认主文开头引用 “Good evaluations help teams ship AI agents more confidently...”。
- E4 Anthropic 原文还定义 eval 为“给 AI 输入，再用 grading logic 衡量输出”，并说明 Agent 会多轮调用工具、修改状态、基于中间结果调整，评测通常组合 code-based、model-based、human graders；这些是一手背景资料。
- E5 主文关联微信链接《全球化商品中心智能答疑Agent实践》《国际化IC-基于Spring AI Alibaba的智能答疑实践》普通请求均只返回约 17.8 KB 跳转/验证壳，未取得正文；本报告未根据标题推断其内容。

### 本地来源

- L1 `README.md`：项目定位为独立、只读、多来源 Agent 轨迹查看器；本地轨迹诊断、只读冻结快照、过程评测、优化建议、三来源投影、Token/TTFT/coverage 等已实现能力。
- L2 `src/types.ts`：统一类型层，包含 `TrajectoryRecord`、`TrajectoryProjection`、`TokenUsage`、`TrajectoryMetrics`、`ProjectionCoverage`、`TrajectoryRelation`。
- L3 `src/trajectory-analysis.ts`：本地分析模型，包含 `TrajectoryAnalysis`、`AnalysisStep`、`AnalysisCorrection`、`AnalysisEvaluation`、`analyzeTrajectory`、`buildEvaluations`。
- L4 `src/trajectory-optimization.ts`：本地优化建议规则与 AI proposal merge 逻辑。
- L5 `src/trajectory-facts.ts`、`server/summary/engine.ts`、`server/summary/guides.ts`：AI 增强事实包、提示词边界、证据 ID 校验、模块指南。
- L6 `server/diagnosis/service.ts`、`server/diagnosis/evidence-store.ts`：诊断快照冻结、脱敏 transport detail、私有 JSON 写入与 prune 策略。
- L7 `server/projectors/zcode.ts`、`server/projectors/codex.ts`、`src/projector.ts`：三来源投影、usage/timing/tool/trace 读取与 DSH coverage 语义。

## 8. 结论

这篇文章对 Agent Trajectory 最有价值的不是“再做一个评测平台”，而是提供了一套可落地的评测产品化结构：数据集/用例、指标依赖、EvalTrace、Judge Task、质量/成本/性能看板、历史趋势与 bad case 演化。

当前项目已经具备非常好的轨迹事实层和单会话过程诊断能力；下一步最稳妥的落地方向，是先把外部评测 run 作为只读 artifact 导入并与本地 trajectory records 关联。这样既能吸收文章的工程实践，又不破坏 Agent Trajectory 的核心边界：不执行 Agent、不调用外部工具、不修改用户环境，只解释已经发生且可核验的轨迹与评测证据。
