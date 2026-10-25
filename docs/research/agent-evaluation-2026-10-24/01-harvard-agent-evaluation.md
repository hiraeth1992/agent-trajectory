# 01 路调研：Harvard CS2680 Agent Evaluation 方法对 Agent Trajectory 的启发

## 来源状态

- 唯一指定来源：Harvard CS2680 notes，`Agent Evaluation` 页面中的 `evaluation-loop` 锚点：<https://cs2680.seas.harvard.edu/notes/agent-evaluation#evaluation-loop>。
- 首个独立子 Agent 已通过只读 HTTP 成功取得原始页面，并确认目录与 `#evaluation-loop` 锚点；它完成来源核验与本地能力映射后未及时落盘。写作替补子 Agent 按收敛要求仅再做一次 HTTP 核验，该次请求在 TLS 握手阶段超时。本文只采用首轮已核实的页面核心与本地源码证据，不追外链、不补充页面外信息。
- 已核实核心可归纳为：Agent 评测循环围绕收集和维护代表性任务、定义 outcome / trajectory 等 grader、批量运行、分析失败、迭代 Agent、把生产失败回流数据集；grader 应组合 code / model / human；先建立 baseline，再关注分布切片、可靠性、成本 / 延迟和 grader 校准。

## Harvard 核心方法

Harvard 的 `#evaluation-loop` 对本项目最有价值的不是某个单点指标，而是“评测作为持续工程循环”的组织方式。它把 Agent 改进拆成可重复的闭环：

1. 维护代表性任务集。任务集不是一次性 demo，而是持续收集、清洗、版本化的 evaluation dataset。生产事故、用户失败、边界场景和典型成功路径都应回流进数据集。
2. 定义 grader。结果层面需要 outcome grader 判断任务是否完成；过程层面需要 trajectory grader 判断 Agent 是否走了可靠、可解释、低浪费、可恢复的路径。grader 不应单一依赖模型，应按问题类型组合 code grader、model grader 和 human grader。
3. 批量运行实验。每次 Agent、prompt、工具链或评测器变化后，用同一数据集和同一 grader 配置批量 run，生成可比较的结果。
4. 分析失败和切片。不只看总分，还要按任务类型、来源、难度、工具、错误类型、长短会话、成本区间等分布切片，定位可靠性、延迟、成本和能力边界问题。
5. 迭代 Agent 并建立 baseline。先有一个可复现 baseline，再比较每次变化对成功率、稳定性、成本和延迟的影响。
6. 校准 grader。grader 自身也要被评估：与人工判断的一致性、误杀 / 漏判、N/A 处理、对证据不足的表达、版本漂移和成本都需要监控。

这套方法的隐含工程原则是：评测结果必须可复现、可解释、可追溯、可比较；单次会话诊断有价值，但只有进入数据集、批量 runner、版本化 grader 和回归门禁后，才会形成稳定的 Agent 改进系统。

## 与 Agent Trajectory 当前能力的映射

当前项目已经具备“单会话、证据优先、过程可解释”的良好底座，但还没进入 Harvard 式批量实验系统。映射如下。

| Harvard 方法要点 | 当前已具备 | 主要缺口 |
| --- | --- | --- |
| outcome / trajectory 双层 grader | `src/trajectory-analysis.ts:62-105` 定义 `AnalysisEvaluation` 与 `TrajectoryAnalysis`，包含 outcome、steps、corrections、evaluations、optimizations；`README.md:221-224` 明确轨迹评测区分事实、推断和来源未记录，不把“没有报错”表述为“结果正确”。 | 现在更像固定内置评测视图，缺少可注册、可版本化、可校准的 grader registry。 |
| 五维本地过程评测 | `src/trajectory-analysis.ts:940-1075` 构造 outcome、reliability、recovery、efficiency、observability 五维评测；`src/trajectory-analysis.ts:930-936` 在缺少测试、断言或业务真值时输出“无法判断正确性”。 | 五维评测只能评当前会话，缺少跨会话聚合指标、切片报表和历史趋势。 |
| 证据 recordId 可追溯 | `AnalysisStep.recordIds`、`AnalysisEvaluation.evidenceRecordIds` 见 `src/trajectory-analysis.ts:20-70`；AI 事实包也保留 `evidenceRecordIds`，见 `src/ai-summary-types.ts:84-126`。 | 证据已经能定位，但尚未形成 benchmark case 的输入、期望、证据、标签、判分结果的统一记录格式。 |
| AI 事实包与结构化校验 | `buildSummaryFacts` 从本地 analysis 生成 schemaVersion 2 的事实包、steps、corrections、evaluations、optimizations，见 `src/trajectory-facts.ts:19-73`；`summaryFactsHash` 与 preview hash 见 `src/trajectory-facts.ts:76-103`。 | 有 facts hash，但没有把 grader 版本、rubric 版本、dataset 版本、runner 版本一起写入实验元数据。 |
| 模型增强不改事实 | `server/summary/engine.ts:71-90` 的 prompt 明确本地事实包是唯一可信数字 / 状态 / ID / 证据关系来源；`server/summary/engine.ts:166-245` 校验模块完整性和证据 ID 合法性。 | 这接近 model grader 的安全外壳，但目前用途是语义增强，不是正式判分器；缺少与 human gold 的校准。 |
| 二阶段补证 | `server/summary/engine.ts:483-510` 允许模型请求事实包中存在的 `recordId`，再读取脱敏 raw evidence；`server/summary/engine.ts:513-561` 对补证后输出再次结构化校验。 | 适合作为 trajectory grader 的取证模式，但还没有批量运行时的证据预算、缓存和失败重试策略。 |
| 冻结诊断快照 | `DiagnosisEvidenceSnapshot` 包含 evaluator、target、sourceFingerprint、detail、analysis，见 `server/diagnosis/evidence-store.ts:21-30`；创建快照时写入脱敏 detail 和本地 analysis，见 `server/diagnosis/evidence-store.ts:83-107`。 | 冻结的是单次诊断目标，不是实验 run。还缺 runId、agentVersion、graderVersion、datasetVersion、baselineId。 |
| 诊断快照稳定性 | `server/diagnosis/service.ts:90-111` 在 freeze 时比较前后 fingerprint，若源会话变化则拒绝；`server/diagnosis/service.ts:114-152` 用只读诊断会话启动受控 Skill。 | 这解决“诊断对象漂移”，但没有解决“实验定义漂移”和“评测器口径漂移”。 |
| 专用诊断 Skill 合同 | `skills/trajectory-diagnosis/SKILL.md:8-27` 要求只诊断指定 snapshot，通过 evidence command 读取 overview、records、record、findings；`skills/trajectory-diagnosis/SKILL.md:31-36` 要求重建目标、行动链、结果和高杠杆问题。 | Skill 报告是人读文档，不是机器可聚合的 grader output；不适合作为唯一回归门禁。 |
| 成本 / 延迟可见性 | `README.md:233-244` 说明以 `turn + step` 聚合逻辑步骤，展示耗时、Token、缓存读取和未分配成本；`src/trajectory-analysis.ts:1017-1055` 已把 efficiency 纳入评测。 | 缺少跨 run 的成本 / 延迟预算门槛，例如 P95 延迟、平均输入 token、失败样本成本增幅。 |

## 建议优先级

### P0：把现有单会话评测固化成最小可回归闭环

1. 建立 benchmark dataset 格式。
   - 建议新增 `docs` 或 `tests/fixtures` 下的脱敏 case 清单，字段至少包括 `caseId`、`source`、`sourceSessionId` 或快照路径、任务类型、期望 outcome、允许的 N/A、人工标签、证据 recordId、创建来源、回流原因。
   - 价值：把现在的“打开一个会话看评测”变成“同一批会话反复比较”。
   - 验证：选 20～30 个已脱敏会话，runner 能逐个载入并产出同一结构的评测 JSON。

2. 为当前五维评测建立 baseline runner。
   - 直接复用 `analyzeTrajectory(detail)` 和 `buildSummaryFacts(detail, analysis, modules)`，先不引入模型 grader。
   - 输出固定结构：caseId、analysis 摘要、五维 grade、关键 evidenceRecordIds、duration/token stats、factsHash、代码版本和运行时间。
   - 价值：先建立 baseline，再谈优化；避免每次改评测文案都无法判断是否退化。
   - 验证：同一 commit、同一 dataset 连跑两次，除时间戳外输出稳定；修改一条 fixture 后只影响对应 case。

3. 明确 grader registry / version 的最小接口。
   - 当前可把内置本地评测注册为 `local-trajectory-v1`，把事实包 schema 记为 `summary-facts-v2`，把诊断 Skill 记为 `trajectory-diagnosis@skill-version`。
   - 不需要一开始做复杂插件系统；先保证每次结果都带 grader id、grader version、schema version、dataset version。
   - 验证：实验报告能回答“这次分数由哪个 grader、哪套数据、哪次代码生成”。

4. 把生产失败回流成 case。
   - 结合现有冻结快照机制：诊断入口已经能生成稳定 snapshot；下一步应允许把 snapshot 标记为 benchmark candidate，并补人工 outcome 标签。
   - 价值：符合 Harvard 循环中“生产失败回流数据集”的关键环节。
   - 验证：一次真实失败从诊断快照进入 candidate，再经人工标注进入 dataset，有审计记录。

### P1：引入分层 grader 与校准机制

1. 拆分 code / model / human grader 职责。
   - code grader：确定性检查结构事实，例如是否有未恢复错误、修改后是否验证、token 归属是否完整、是否出现重复读取或同类错误重试。
   - model grader：只处理语义判断，例如目标是否满足、行动链是否合理、失败根因分类；必须使用事实包和受限补证，不直接读取活源会话。
   - human grader：为 outcome、严重度、N/A、误判原因提供 gold 标签，用于校准 code/model grader。
   - 验证：每个 case 至少能看出判分来自哪个 grader 类型；模型判断不能覆盖本地事实。

2. 建立 grader calibration 报表。
   - 指标不要只看一致率。至少记录 precision、recall、false positive、false negative、N/A 比例、人工仲裁差异和 grader 成本。
   - 对 `unknown`、`无法判断正确性`、证据不足应单独统计，不把它们混进 fail。
   - 验证：抽样 50 个 case 后，能定位某个 grader 是“保守漏判”还是“激进误杀”。

3. 增加分布切片。
   - 推荐先按 source（Codex / ZCode / DSH）、任务长度、是否有工具错误、是否有文件修改、是否有验证、token 档位、是否触发诊断切片。
   - 与现有字段自然对应：`TrajectoryAnalysis.stats`、`AnalysisStep.kind/status/usage`、`AnalysisCorrection.status`。
   - 验证：报告能显示“总体没变，但长会话 / 高 token / 有恢复链 case 退化”。

4. 建立实验对比视图。
   - 输入两个 run：baseline 与 candidate。
   - 输出 pass/fail/unknown 变化、五维 grade 变化、成本 / 延迟变化、失败新增和恢复样本。
   - 验证：一次改动能明确列出 improved、regressed、unchanged、inconclusive case。

### P2：把评测接入研发流程和产品反馈

1. 回归门禁。
   - PR 或 release 前跑核心 benchmark；门禁不应只看总分，可设硬阈值：新增 bad 不超过 N、P0 case 不退化、平均 token 不增长超过阈值、unknown 不异常飙升。
   - 验证：人为引入一个未恢复错误 fixture，门禁失败并指向 caseId 和 evidenceRecordIds。

2. 成本 / 延迟预算。
   - 对不同任务切片建立预算，而不是全局一个 token 阈值。长会话诊断、短会话浏览、含大量 raw evidence 的 case 应分别看。
   - 验证：报告同时给出质量变化和成本变化，避免“质量小幅提升但成本翻倍”被忽略。

3. 从诊断报告到结构化训练信号。
   - 当前 `trajectory-diagnosis` Skill 的四段报告适合人读；后续可增加旁路 JSON 输出：问题类型、严重度、根因、建议对象、验证条件、证据 ID。
   - 验证：诊断报告可以自动生成 dataset candidate 标签或 issue 模板，但仍保留人工确认。

4. 长期维护任务集。
   - 定期清理过时 case、合并重复 case、保留代表性失败；对 dataset 做 changelog。
   - 验证：删除或改写 case 必须说明原因，历史 run 仍能解释当时用的是哪个 dataset version。

## 不适合照搬的部分

- 不应把 Harvard 的通用 Agent 评测循环理解为“立刻上模型打分”。本项目当前优势是本地事实、结构化证据和冻结快照；如果过早让模型直接判分，反而会削弱可复现性。
- 不应把单一总分作为核心目标。Agent Trajectory 面向调试和复盘，`outcome/reliability/recovery/efficiency/observability` 五维比一个总分更适合定位问题。
- 不应把 human grader 变成人工全量审核。更合理的是对代表性 case、争议 case、模型 grader 低置信 case 做抽样校准。
- 不应把生产失败无筛选地全部加入 benchmark。需要去重、脱敏、标注、分层抽样，否则数据集会被重复事故和噪声污染。
- 不应让诊断 Skill 直接承担回归门禁。Skill 合同强调可读报告和高杠杆建议，适合失败分析；门禁需要稳定 JSON 输出、版本化 grader 和可比较指标。
- 不应忽视 N/A 与 unknown。当前项目已经谨慎表达“缺少业务真值时无法判断正确性”，未来批量评测也应保留该语义，不能为了报表好看把 unknown 强行算成 pass 或 fail。

## 证据清单

- H1：Harvard 来源锚点为 <https://cs2680.seas.harvard.edu/notes/agent-evaluation#evaluation-loop>；首个子 Agent 成功取得原始页面并确认该锚点，写作替补的单次复核请求超时。本文只使用首轮已核实核心，不引用未核验外链。
- L1：`src/trajectory-analysis.ts:62-105` 定义五维评测和整体 `TrajectoryAnalysis`，包括 outcome、stats、steps、corrections、evaluations、optimizations。
- L2：`src/trajectory-analysis.ts:930-936` 在缺少测试、断言或业务真值时返回“无法判断正确性”。
- L3：`src/trajectory-analysis.ts:940-1075` 构造 reliability、recovery、efficiency、observability 等过程评测维度，并使用 evidenceRecordIds 关联证据。
- L4：`src/trajectory-facts.ts:19-73` 将本地 analysis 转成 schemaVersion 2 的 AI 事实包；`src/trajectory-facts.ts:76-103` 生成 facts hash 和 preview。
- L5：`src/ai-summary-types.ts:84-126` 定义事实包 step、correction、evaluation、optimization 的结构化证据字段。
- L6：`server/summary/engine.ts:71-90` 要求模型只基于本地事实包增强语义，不得补造状态、错误、耗时、Token、步骤归属、评测维度和证据关系。
- L7：`server/summary/engine.ts:166-245` 对 AI 返回的模块完整性、证据 ID 和 evaluation 覆盖进行结构化校验。
- L8：`server/summary/engine.ts:483-561` 支持按 `recordId` 二阶段补证，并在补证后再次校验。
- L9：`server/diagnosis/evidence-store.ts:21-30` 定义冻结诊断快照，包含 evaluator、target、sourceFingerprint、detail、analysis。
- L10：`server/diagnosis/evidence-store.ts:83-107` 创建私有脱敏快照并写入本地 analysis。
- L11：`server/diagnosis/service.ts:90-111` 通过前后 fingerprint 一致性保证冻结对象稳定；`server/diagnosis/service.ts:114-152` 使用只读诊断会话启动受控 Skill。
- L12：`README.md:120-153` 说明本地轨迹诊断、冻结快照、只读取证命令和四块报告合同。
- L13：`README.md:221-244` 说明“轨迹评测”视图区分事实 / 推断 / 未记录，展示耗时、Token、缓存和未分配成本。
- L14：`skills/trajectory-diagnosis/SKILL.md:8-27` 要求只诊断指定 snapshot，并通过 overview、records、record、findings 读取最小证据。
- L15：`skills/trajectory-diagnosis/SKILL.md:31-36` 与 `skills/trajectory-diagnosis/SKILL.md:54-83` 规定诊断方法和四段报告合同。
