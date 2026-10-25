# 第 7 路调研：基于 Aide 观测能力的 Skill 过程诊断与自进化实践

研究对象：<https://bytedance.larkoffice.com/wiki/NZDpwHKpFi9xqokWyLVctFisnCb>
调研时间：2026-10-24
本地对比项目：Agent Trajectory

## 结论摘要

该内部实践的核心不是“让模型再总结一次结果”，而是把 Skill 中要求发生的关键环节显式建模为可判定检查项，再批量跑真实线上轨迹，得到每个环节的执行稳定率、失败证据和样本分布；之后以诊断报告驱动 Skill 修改，并通过基线 / 候选对比实验确认无负向影响后再发布。

Agent Trajectory 当前已经具备较强的底座：统一轨迹记录、五维过程评测、本地规则优化建议、冻结脱敏诊断快照、按需证据读取、AI 增强事实包校验等。但它目前更偏“通用轨迹解释与通用反模式发现”，还没有把“某个 Skill / 工作流必须发生什么”作为一等数据模型，也缺少跨会话批量评分、版本对比实验和上线门禁。

最值得借鉴的是三件事：

1. 为关键过程定义可证伪检查项，而不是只评价最终结果。
2. 用同一套检查项批量跑固定样本，输出稳定率、失败样本和证据片段。
3. 把优化建议纳入“证据复核 → 人工采纳 → 回归评测 → 发布 / 回滚”的闭环。

不建议照搬的是一键创建分支 / MR / 发布链路，以及依赖 Aide / Sophon / DouSkill 的内部平台实现；Agent Trajectory 的产品边界是本地、只读、隐私优先，应优先做本地化、可复制、需用户确认的诊断与评测能力。

## 来源元信息与访问状态

### Wiki 节点解析

- 访问方式：`lark-cli wiki +node-get --as user --format json`
- 访问状态：成功，身份为 `user`
- 标题：`基于Aide观测能力实现Skill过程诊断及自进化`
- Wiki node token：`NZDpwHKpFi9xqokWyLVctFisnCb`
- 文档对象：`docx`
- obj_token：`IuCBd7rCYoMKOYxna3dcNR9Snxc`
- space_id：`7560668139936612354`
- has_child：`false`
- updated_at：`2026-09-16T08:54:10Z`

### 正文读取

- 访问方式：`lark-cli docs +fetch --as user`
- 访问状态：成功
- document_id：`IuCBd7rCYoMKOYxna3dcNR9Snxc`
- revision_id：`1447`
- 读取策略：先 `outline` 获取目录和章节锚点，再按章节读取 `写在前面`、`过程分析`、`Skill自进化`、`评测上线` 四段。
- 未执行动作：未写入飞书；未下载图片、白板或附件；未打开文档中外链报告。本文只基于 Wiki 正文及其文本化图片说明做摘要，不复制大段敏感正文。

### 目录结构

文档分为三段：

- 过程分析：量化“关键环节有没有被执行”
- Skill 自进化：诊断 → 优化链路闭环
- 评测上线：保障迭代效果无负向影响

## 内部实践拆解

### 1. 核心问题：Skill 写了，不等于 Agent 做了

文档强调的起点是：Skill 中声明了流程、门禁、检查或检索要求，但真实轨迹里可能出现不执行、跳步、假执行和不稳定执行。最终产物评测无法稳定识别这些过程偏差，因为模型可能在没检索、没验证或没跑门禁的情况下仍生成格式正确的结果。

因此实践把关注点从“结果是否像样”前移到“关键环节是否真的发生”，并要求每个结论回到轨迹证据。

### 2. 过程评测流程

内部流程可以概括为六步：

1. 读真实 case，把执行轨迹和 Skill 要求逐步对齐。
2. 找出“Skill 里写了，但轨迹里没发生 / 做歪了”的偏差。
3. 抽取必须长期盯住的关键环节。
4. 把环节写成机器可判的评分器。
5. 批量跑线上 trace，得到每条环节的满足率与失败证据。
6. 按“没做”和“做歪”分类制定改法，修改后用同一套评分器重跑。

关键点是检查项必须能被 trace 证伪。文档给出的结构包括：

```yaml
- name: 环节名
  criticality: required 或条件适用
  verify:
    method: judge
    pass_if: 可判真假的通过条件
    evidence_hint:
      - 去 trace 的哪里找证据
```

这比“正确执行了某步骤”更窄、更可复核，因为它规定了调用时序、产物条件、退出码或失败后的处理方式。

### 3. 指标与样本分析

文档中的指标侧重过程稳定性：

- 关键环节满足率 / 通过率
- 能力点或阶段的执行样本数
- 平均满足率与分布
- 验证执行率、验证通过率
- 问题样本及证据片段
- 失败原因与影响范围

文档示例中，同一套评分器用于对比某技术方案 Skill 的新旧版本，旧版“技术方案节点满足率”示例为 66.8%，新版示例为 73.4%。这不是作为可泛化业务结论，而是说明该体系能用同口径比较版本差异。

### 4. 自进化闭环

自进化部分把链路拆为三层：

- 诊断证据层：评分器结果、线上 trace、structured_result、spans。
- 自进化层：证据复核、重复模式聚合、建议生成。
- 人机协同交付层：负责人 review、采纳判断、分支改动和回归门禁。

文档示例中，诊断报告生成 33 条建议，经负责人 review 后采纳 5 条。建议保留问题证据、修改动作、Skill 落点和验收标准；被采纳项才进入 Skill 优化。这说明内部实践没有把模型建议直接当作事实，而是把它作为证据驱动改动的候选输入。

### 5. 评测上线门禁

上线环节用对比实验控制变量：

| 变量 | 控制方式 |
| --- | --- |
| 模型 | 对照组 / 实验组使用同一模型与采样参数 |
| 评测集 | 使用同一评测集，覆盖主流程、关键能力和历史风险场景 |
| 评估方法 | 同一评分器和指标口径 |
| 对照组 | 优化前基线版本 |
| 实验组 | 自迭代 MR 对应版本 |

流程分为构建实验、实验执行、实验分析、发版 / 回滚。通过条件是核心指标无负向且风险 case 可接受；若指标负向、风险不可解释或证据不足，则不发布或回滚，并把失败证据回流到优化环节。

## 与 Agent Trajectory 当前项目的映射

### 已具备的相似能力

#### 1. 统一轨迹记录模型

Agent Trajectory 已有跨来源统一记录结构。`TrajectoryRecord` 包含来源、原始事件 ID、可信度、轮次、步骤、记录类型、状态、输入输出、Token、指标、trace/span 等字段，已经具备承载“过程证据”的基础。

证据：

- `src/types.ts:81` 定义记录类型，如 system、user、assistant、tool、subtool、compaction。
- `src/types.ts:92` 定义状态 complete、running、error、interrupted。
- `src/types.ts:148` 起的 `TrajectoryRecord` 包含 `sourceEventIds`、`fidelity`、`turn`、`step`、`kind`、`status`、`input`、`output`、`usage`、`metrics`、`traceId`、`spanId` 等字段。

#### 2. 通用过程评测与证据定位

当前 `TrajectoryAnalysis` 已经包含目标、结论、统计、步骤、纠错链、评测维度和优化建议。评测维度包括 outcome、reliability、recovery、efficiency、observability；README 也明确“所有证据均可反向定位到轨迹记录”，并避免把“没有报错”表述为“结果正确”。

证据：

- `src/trajectory-analysis.ts:62` 定义 `AnalysisEvaluation` 的五类评测维度。
- `src/trajectory-analysis.ts:72` 定义 `TrajectoryAnalysis`，包含 stats、steps、corrections、evaluations、optimizations。
- `src/trajectory-analysis.ts:1077` 的 `analyzeTrajectory` 生成 objective、outcome、stats、steps、corrections、evaluations 和 optimizations。
- `README.md:222` 说明轨迹评测解释模型做了什么、为什么这样做、异常是否恢复，并可定位证据。

#### 3. 本地规则优化建议

项目已有本地优化建议引擎，能识别重复读取、同类错误重试、环境错误、修改后缺验证等模式，并输出推荐措施、目标、预期收益、验证方式、限制与可复制执行动作。

证据：

- `src/trajectory-optimization.ts:3` 定义优化措施类型：code、rule、hook、plugin、environment、workflow、verification。
- `src/trajectory-optimization.ts:6` 定义问题类别：duplicate、retry、environment、verification、detour、search、context、constraint。
- `src/trajectory-optimization.ts:24` 定义 `OptimizationSuggestion`，包含 priority、confidence、source、measures、effort、observation、cause、action、target、expectedBenefit、verification、limitation、executionActions 和 evidence。
- `src/trajectory-optimization.ts:372` 标注该分析无模型调用、无副作用；`src/trajectory-optimization.ts:373` 起按记录生成建议。
- `README.md:225` 说明优化建议只用于展示，不自动修改代码、规则、Hook、插件或环境。

#### 4. 冻结脱敏诊断证据

Agent Trajectory 的本地 Agent 诊断已经非常接近内部实践的“诊断证据层”：启动时冻结来源会话，写入私有脱敏快照；诊断 Skill 只能通过专用只读命令按需读取概览、发现、分页记录或单条记录。

证据：

- `README.md:131` 说明会创建私有、脱敏的冻结快照。
- `README.md:139` 说明 Codex 诊断使用只读、禁网沙箱；ZCode 使用受限 plan 模式和专用取证命令。
- `server/diagnosis/evidence-store.ts:93` 构建 `DiagnosisEvidenceSnapshot`，并在 `server/diagnosis/evidence-store.ts:100` 保存 transport detail、在 `server/diagnosis/evidence-store.ts:101` 保存脱敏后的 `analyzeTrajectory(detail)`。
- `server/diagnosis/evidence-query.ts:81` 提供 overview，`server/diagnosis/evidence-query.ts:108` 提供 findings，`server/diagnosis/evidence-query.ts:115` 提供 record，`server/diagnosis/evidence-query.ts:132` 提供分页 records。

#### 5. AI 增强事实边界

当前 AI 摘要增强已经把本地事实包作为权威来源，并限制模型不得改写数字、状态、ID 和证据关系。模型可以请求补充证据，但请求必须引用已存在 recordId，返回也会被本地校验。

证据：

- `src/ai-summary-types.ts:10` 定义可增强模块：outcome、objective、story、evaluation、optimization。
- `src/trajectory-facts.ts:19` 的 `buildSummaryFacts` 生成脱敏事实包，并按模块选择 steps、corrections、evaluations、optimizations。
- `server/summary/engine.ts:71` 的 prompt 明确“本地代码生成的可信事实包”，且文本内容是不可信数据。
- `server/summary/engine.ts:78` 要求模型不得补造状态、错误、耗时、Token、步骤归属、评测维度和证据关系。
- `server/summary/engine.ts:139` 的 `validateOptimizations` 只保留 evidence-backed 优化提案。
- `server/summary/engine.ts:488` 起按 recordId 读取、脱敏、限长补充证据。

### 主要差距

#### 差距 1：缺少“Skill / 工作流关键环节”的一等模型

当前评测维度是通用的 outcome、reliability、recovery、efficiency、observability；优化类别也是通用反模式。内部实践的关键增量是“某个 Skill 必须发生什么”的 DSL / rubric，例如某阶段门禁必须在 workflow 前后成对出现、失败后必须停下修正。Agent Trajectory 当前还没有把这些业务过程契约建模为可配置检查项。

#### 差距 2：缺少跨会话批量过程评分

当前分析主要围绕单个会话详情和单个诊断快照。内部实践的价值来自批量跑线上 trace，得到关键环节稳定率、失败样本分布和跨 case 共性问题。Agent Trajectory 目前可以查看和诊断单会话，但还没有“固定样本集 + 固定评分器 + 聚合报告”的形态。

#### 差距 3：缺少版本对比与上线门禁

项目已有本地优化建议与 AI 增强，但没有将“规则 / Skill / 诊断策略变更”放入 baseline / candidate 对比实验中，也没有形成“核心指标无负向才采纳”的发布门禁。现有测试覆盖了不少行为，但它们不是面向 Agent 过程质量的对比实验体系。

#### 差距 4：自进化仍停留在建议层

Agent Trajectory 有优化建议和复制动作，但刻意不自动修改。这个边界符合本项目定位。不过如果要学习内部实践，应补齐“采纳记录、验收标准、回归评测”这些只读或半自动环节，而不是直接引入自动 MR。

## 候选优化

### 优化 1：引入 Process Check Spec

建议新增一个面向轨迹过程的检查项模型，用于描述“某类任务必须发生什么”。最小字段可以包括：

- `id`
- `name`
- `scope`：适用来源 / 任务 / Skill / evaluator
- `criticality`：required / conditional / advisory
- `applicability`：何时适用
- `pass_if`：可证伪判据
- `evidence_selector`：从 record kind、title、input/output、status、turn/step、trace/span 中取证
- `failure_modes`：missing、wrong_order、fake_execution、unstable、insufficient_evidence
- `evidenceRecordIds`

价值：把内部实践中最核心的“Skill 过程契约”迁移到 Agent Trajectory。它能让项目从通用过程解释升级为任务 / Skill 定制化评测。

成本：中等。需要新增类型、检查执行器、fixture 和 UI 展示；初期可只支持 JSON/YAML spec 与确定性匹配，judge 类检查后置。

风险：判据过宽会产生“看似评分、实际不可证伪”的假信号；判据过窄会误伤正常路径。还要防止把轨迹文本当作指令执行。

验证：

- 为 `skills/trajectory-diagnosis/SKILL.md` 写 3～5 条本地检查项，例如“必须先读 overview/findings，再按需读 records/record”“不得读取 live source session”“最终报告固定四块”。
- 用现有 diagnosis fixture 构造通过、缺失、顺序错误和证据不足样本。
- 增加 `tests/process-checks.test.ts`，断言每条失败都能定位到 recordId 或明确为 insufficient evidence。

### 优化 2：增加批量过程评测报告

基于已有 source registry 和 `analyzeTrajectory`，增加一个本地批量运行入口：用户显式选择若干 session 或固定 evidence manifest，对同一套 Process Check Spec 运行并生成聚合 Markdown / JSON。

价值：补齐内部实践的稳定率视角，避免单 case 诊断无法区分偶发问题和系统性问题。

成本：中高。需要样本选择、并发限制、隐私提示、结果缓存和聚合格式。

风险：批量扫描可能触碰隐私和性能边界；必须保持显式选择，不应自动扫描大范围目录。

验证：

- 只支持 explicit session IDs，不支持默认全盘扫描。
- 输出只包含会话哈希、recordId、检查结果和脱敏摘要。
- 用 3 个来源 fixture 跑小样本，验证通过率、失败分布、样本计数稳定。

### 优化 3：为诊断 Skill 建立回归评测集

本项目已经内置 `trajectory-diagnosis` Skill。可以先不做通用平台，而是把它作为第一个被评测对象：维护一组冻结的脱敏诊断快照和期望行为检查项，任何修改该 Skill 或诊断证据协议时都跑回归。

价值：范围小、收益直接，能把内部实践落到当前最相关模块。

成本：低到中等。现有 `tests/diagnosis-evidence.test.ts`、`tests/trajectory-diagnosis*.test.ts` 已有很多基础设施。

风险：测试容易只验证 prompt 文本包含某些句子，无法代表真实诊断质量；需要加入过程检查和输出结构检查。

验证：

- 保留现有单元测试。
- 新增“诊断过程检查”fixture：模拟错误路径、缺验证路径、重复读取路径。
- 验证诊断任务必须引用 evidence command，且报告不能出现第五个标题、不能编造路径、不能给多个等价方案。

### 优化 4：提供 baseline / candidate 分析对比

在不修改外部系统的前提下，支持比较两套本地分析配置或两版 Process Check Spec 在同一批 session 上的结果差异。

价值：学习内部实践的“同模型、同评测集、同指标，只改一个变量”，可用于评估新检查项是否引入过多误报，也可用于评估优化规则调整是否负向。

成本：中等。需要结果版本化、diff 展示和门限配置。

风险：如果 baseline 和 candidate 使用的样本不一致，差异不可归因；如果门限只看总分，可能掩盖关键环节劣化。

验证：

- 强制同一 session manifest。
- 输出新增失败、修复失败、无变化、证据不足四类。
- 至少覆盖“总通过率提升但 P0 required 检查劣化时不通过”的测试。

### 优化 5：扩展优化建议为“采纳账本”

当前优化建议能展示 action 和 verification，但缺少内部实践中的“负责人 review / 采纳 / 不采纳 / 验收标准 / 回归结果”。可以先在前端提供本地导出或复制，不自动写仓库。

价值：把建议从一次性展示变成可审计的改进队列，便于多轮诊断闭环。

成本：中等。需要 UI 状态、导出格式和缓存策略。

风险：如果引入写入本地状态，需要明确隐私和可删除；如果做成自动执行会偏离只读定位。

验证：

- 默认不写项目文件。
- 用户显式导出时生成 Markdown / JSON。
- 每条采纳项必须带 evidenceRecordIds、预期改善和验证方式。

### 优化 6：把 AI 增强限定到“解释检查结果”，而非决定检查结果

内部实践中 judge 类评分器会参与判定，但 Agent Trajectory 当前优势是本地事实权威和证据校验。建议短期让 AI 只解释确定性检查结果、聚合模式和生成建议草案，不让 AI 直接改写 pass/fail。

价值：保留当前可信边界，减少模型幻觉对评测指标的污染。

成本：低到中等。现有 `SummaryEngine` 已经有事实包、evidenceRequests、validateDraft 机制。

风险：过度限制会让部分语义类检查无法落地；可以通过 `insufficient_evidence` 和人工 review 过渡。

验证：

- AI 输出中任何 pass/fail 字段都被忽略或拒绝。
- AI 建议必须引用已有 findingId 或合法 recordId。
- 本地 factsHash 变化时缓存失效。

## 不建议照搬项

1. 不建议引入一键创建分支、commit、push、MR 和发布。Agent Trajectory 的边界是本地只读查看器，自动写外部仓库会显著扩大权限和风险。
2. 不建议依赖 Aide、Sophon、DouSkill 的内部平台对象作为核心抽象。可以学习 baseline / candidate、固定变量和门禁思想，但实现应落到本地 session manifest、Process Check Spec 和脱敏报告。
3. 不建议把图片截图里的指标当作可机器复核事实。截图适合作案例说明；项目实现应依赖结构化轨迹、recordId 和脱敏证据。
4. 不建议只做结果评测。内部文档的核心教训恰恰是最终产物可能掩盖过程跳步、假执行和缺验证。
5. 不建议把整段原始轨迹直接塞给模型。当前项目的冻结快照、按需 record 读取、限长和脱敏机制更安全，应继续保留。
6. 不建议使用宽泛判据，例如“正确执行了检查”。每条检查都应写成可证伪条件，否则批量评分会变成主观总结。

## 证据清单

### 飞书 Wiki 证据

- `wiki +node-get` 成功解析目标 Wiki：标题为“基于Aide观测能力实现Skill过程诊断及自进化”，对象类型 `docx`，身份 `user`。
- `docs +fetch --scope outline` 成功读取目录，revision_id 为 `1447`。
- “写在前面”章节说明整体链路：看得见、改得动、敢上线。
- “过程分析”章节说明偏差形态、过程评测流程、评分器结构和新旧版本过程指标对比。
- “Skill自进化”章节说明诊断证据层、自进化层、人机协同交付层，以及 33 条建议 / 采纳 5 条的案例。
- “评测上线”章节说明 baseline / candidate 对比实验、变量控制、实验执行、分析和发布 / 回滚门禁。

### 本地项目证据

- `README.md:120` 起说明本地轨迹诊断、冻结脱敏快照、只读诊断命令和四块报告。
- `README.md:222` 起说明过程评测和优化建议要求证据反向定位，不把“没有报错”当作正确。
- `README.md:247` 起说明诊断入口使用内置评测器和当前来源 / 会话生成冻结快照。
- `src/types.ts:81` 起定义统一记录类型、状态、Token、metrics 和 `TrajectoryRecord`。
- `src/trajectory-analysis.ts:62` 起定义五维评测；`src/trajectory-analysis.ts:1077` 起生成完整轨迹分析。
- `src/trajectory-optimization.ts:3` 起定义优化措施和类别；`src/trajectory-optimization.ts:372` 起说明本地优化分析无模型调用和副作用。
- `server/diagnosis/evidence-store.ts:93` 起创建冻结诊断快照并保存脱敏分析。
- `server/diagnosis/evidence-query.ts:80` 起提供 overview、findings、record、records 等只读证据视图。
- `server/summary/engine.ts:71` 起定义 AI 增强事实包提示；`server/summary/engine.ts:139` 起校验 evidence-backed 优化；`server/summary/engine.ts:488` 起按需读取脱敏补充证据。
- `tests/trajectory-optimization.test.ts` 覆盖重复读取、重试、环境错误、缺验证和 evidence-backed AI proposal 合并。
- `tests/diagnosis-evidence.test.ts` 覆盖冻结脱敏证据和有界只读视图。
- `tests/summary-engine.test.ts` 覆盖脱敏事实预览、按需证据读取、优化提案证据校验和缓存合并。

## 后续建议优先级

| 优先级 | 建议 | 原因 |
| --- | --- | --- |
| P0 | 为 `trajectory-diagnosis` Skill 建立最小 Process Check Spec 和 fixture | 范围最小，能最快验证内部实践是否适合本项目 |
| P1 | 批量过程评测报告 | 补齐稳定率和跨 case 共性问题视角 |
| P1 | baseline / candidate 对比 | 让规则或 Skill 改动有无负向门禁 |
| P2 | 采纳账本 | 把建议沉淀为可审计闭环，但不应自动写外部仓库 |
| P2 | AI 解释检查结果 | 延续当前事实权威边界，避免模型决定指标 |
