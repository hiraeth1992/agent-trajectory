# 第 5 路调研：AIDE System Evaluator 与 Agent Trajectory 对比

调研对象：<https://aide.bytedance.net/chats/evaluation/system-evaluator?bz_code=003>
调研时间：2026-10-24（Asia/Shanghai）
本地项目：`agent-trajectory`
写入范围：仅本文档

## 1. 来源与访问状态

### 1.1 AIDE 页面访问状态

- 使用当前 Chrome 登录态只读打开目标 URL，页面可访问，浏览器标题为「Aide-大数据研发的 AI 助手」。
- 可见页面主标题为「把一次 Agent 会话拆成可验收的需求、结论、证据与治理动作」，协议标识为 `FULL ANALYSIS · skill_governance_v3`。
- 本次只读取页面可见文本和 DOM 文本，没有提交表单、没有触发评测、没有修改配置、没有写入外部系统。
- 页面没有出现登录页、权限拒绝页或错误页；因此本报告按可见页面内容分析。页面背后的接口、不可见配置和真实运行样例未访问，未作推断。

### 1.2 本地仓库访问状态

- 对本地仓库只做只读检查，重点读取 `README.md`、`src/trajectory-analysis.ts`、`src/trajectory-optimization.ts`、`src/trajectory-facts.ts`、`src/ai-summary-types.ts`、`server/summary/*`、`server/diagnosis/*`、`skills/trajectory-diagnosis/SKILL.md` 等文件。
- 工作区已有大量未提交改动；本报告未修改这些既有文件，仅新增当前 Markdown 文件。

### 1.3 证据编号说明

下文用两类证据：

- `AIDE-E*`：来自目标 AIDE 页面可见文本。
- `LOCAL-E*`：来自当前仓库源码或文档。

完整证据清单见文末。

## 2. AIDE System Evaluator 的产品 / 系统定位

AIDE System Evaluator 当前页面展示的不是一个泛化“轨迹浏览器”，而是一套面向 Agent 会话机评和治理闭环的结构化评测协议。它把一次 Agent 会话拆成四类核心对象：

1. 用户需求是否被理解和实现；
2. 用户视角的整体结论；
3. 多轮会话的信息承接；
4. 具体 Skill 的首次可治理偏离、证据边界和治理动作。

页面明确写到：

- `skill_governance_v3` 的目标是「把一次 Agent 会话拆成可验收的需求、结论、证据与治理动作」；
- 必填基座是 `requirement + overall + per_skill`；
- 嵌套动作位于 `per_skill_results[].actions[]`；
- 动态扩展是 `custom_tags + progress_metric`；
- 多轮条件字段是 `chain_result`。

因此，这套实践的核心定位可以概括为：

> 用固定基座协议保证跨业务可比，用动态标签和过程指标适配不同业务；先从用户需求事实出发，再定位 Skill 层偏离，并输出一条可验收的治理动作。

这个定位和当前 Agent Trajectory 的定位不同。当前 Agent Trajectory 在 README 中定位为「独立、只读的多来源 Agent 轨迹查看器」，把 DeepSeek Harness、Codex 和 ZCode 本地会话投影到时间线、虚拟账本和检查器中（`LOCAL-E1`）。它已经有评测和诊断能力，但基础目标仍是本地只读观察与解释，而 AIDE 页面更偏“结构化机评结果契约 + 治理动作生产”。

## 3. AIDE 工作流拆解

从页面字段关系看，AIDE 的 Full Analysis 工作流大致如下。

### 3.1 先逐项验收需求

`requirement_results[]` 是事实底座。每一项需求都需要：

- `text`：准确复述需要判断的一项用户要求；
- `state`：只判断该项需求的理解和实现状态；
- `span_id`：可选的证据步骤；
- `evidence`：说明该需求为什么达成或未达成。

页面特别强调：

- `requirement_results[]` 至少提交一项；
- `evidence` 只说明需求判断，不分析 Skill 机制，不写改进建议；
- `outcome_summary` 由 `requirement_results[]` 在 finalize 阶段派生，Agent 不写。

这说明 AIDE 把“需求验收事实”和“后续机制分析 / 建议”做了明确分层，避免一个字段同时承担事实、解释和建议。

### 3.2 再归纳用户视角的整体结论

`overall_result` 回答用户最终拿到了什么、缺了什么、问题属于哪一层。它包括：

- `goal_achievement`：完整达成 / 部分达成 / 未达成 / 证据不足；
- `failure_domain`：无问题、单个 Skill 内部、多 Skill 交接、Agent 通用执行问题、缺少用户输入、受外部条件限制、证据不足；
- `overall_verdict`：30–80 字说明结果是否可用；
- `overall_detail`：2–3 句说明核心缺口或完成点、直接原因、关键证据边界。

页面要求 `goal_achievement` 需与 `requirement_results[]` 一致，这意味着整体结论不是自由总结，而是受逐项需求状态约束。

### 3.3 多轮时单独判断信息承接

`chain_result` 仅在多轮会话出现，单轮不生成。它判断上一轮信息是否被正确承接到下一轮，包括：

- `rounds_continuity`：承接正常 / 承接错误 / 承接缺失 / 证据不足；
- `failed_transition`：最关键的跨轮信息丢失点；
- `chain_verdict`：只判断多轮目标和已知信息是否持续被正确使用；
- `chain_evidence`：引用用户补充、后续使用和最终状态，说明前后信息差异。

这不是普通“故事线”，而是专门针对多轮信息遗失或错误继承的评测面。

### 3.4 按 Skill 定位首次可治理偏离

`per_skill_results[]` 记录 Skill 级问题。页面给出的核心思路是：

- 按 Skill 记录首次可治理偏离；
- 写明偏离前已知状态、实际选择、第一次偏离、根因机制和替代解释；
- 写明证据能证明什么、不能证明什么；
- 每个 Skill 的治理动作最多一条；
- 没有稳定根因时允许为空，证据不足时不生成正式 Action。

字段包括：

- `skill_name`
- `failure_stage`
- `final_gap`
- `known_state`
- `actual_choice`
- `first_deviation`
- `root_cause`
- `alternative_explanations`
- `confidence`
- `evidence_refs[]`
- `evidence_boundary`
- `execution_quality_flags[]`
- `verdict`
- `actions[]`

这套字段对“可治理”有非常强的约束：先证明首次偏离，再绑定一条治理动作，而不是把所有观察到的问题都变成建议。

### 3.5 自定义标签与过程指标独立扩展

`custom_tags` 是基座协议之外的动态维度，key 来自 `analysis_plan.custom_labeling.fields`，不同业务可以拥有不同维度。页面示例包括「业务场景」和「问题二级分类」。

`progress_metric` 记录「过程如何发生」，但页面明确说它是证据，不直接替代 `overall_result`；Full Analysis 的需求完成率来自 `requirement_results[]`，不再作为 agent 指标。

过程指标又分为：

- `rule`：机械可计算，例如 `rule.tool_success_rate`、`rule.user_round_count`；
- `agent`：语义判断，例如 `agent.correct_skill_load_count`、`agent.tool_error_recovery_rate`。

## 4. Evaluator 类型与配置

### 4.1 基座字段

| 字段 | 类型 | 生成条件 | 作用 |
| --- | --- | --- | --- |
| `requirement_results[]` | array · required | 至少一项 | 逐项判断需求是否被理解和实现，是 Full Analysis 的事实底座 |
| `overall_result` | object · required | 总是生成 | 用户视角的整体完成度、问题归属和结果可用性 |
| `per_skill_results[]` | array · 0..n | 有稳定 Skill 偏离时生成，无法定位时可为空 | Skill 级首次偏离、证据边界和治理动作 |
| `analysis_schema_version` | 系统写入 | finalize 阶段 | 标识协议版本；当前固定为 `skill_governance_v3` |
| `outcome_summary` | 只读派生 | finalize 阶段 | 根据需求状态生成完成计数与完成率，避免事实和派生值双源 |

### 4.2 条件字段

| 字段 | 类型 | 生成条件 | 作用 |
| --- | --- | --- | --- |
| `chain_result` | object · conditional | 仅多轮会话 | 判断上一轮信息是否被正确承接到下一轮 |

### 4.3 动态扩展字段

| 字段 | 类型 | 配置来源 | 作用 |
| --- | --- | --- | --- |
| `custom_tags` | object · dynamic | `analysis_plan.custom_labeling.fields` | 业务自定义筛选、分类和治理范围标记 |
| `progress_metric` | object · dynamic | registry + profile | 记录过程指标，辅助解释最终结论 |

### 4.4 主要枚举

`requirement_results[].state`：

- 未理解需求
- 已理解未实现
- 已理解且正确实现
- 证据不足

`overall_result.goal_achievement`：

- 完整达成
- 部分达成
- 未达成
- 证据不足

`overall_result.failure_domain`：

- 无问题
- 单个 Skill 内部
- 多 Skill 交接
- Agent 通用执行问题
- 缺少用户输入
- 受外部条件限制
- 证据不足

`chain_result.rounds_continuity`：

- 承接正常
- 承接错误
- 承接缺失
- 证据不足

`per_skill_results[].failure_stage`：

- 需求理解阶段
- 计划与拆解阶段
- 上下文保持与使用阶段
- 执行控制阶段
- 工具调用与结果处理阶段
- 验证与完成判断阶段
- 异常恢复阶段
- 无法判断首次偏离阶段

`per_skill_results[].confidence`：

- 已确认
- 高置信
- 证据不足

`per_skill_results[].execution_quality_flags[]`：

- 重复执行
- 多余操作
- 循环或停滞

`actions[].solution_type`：

- 补规则或示例
- 结构化上下文
- 规划与流程控制
- 输入与参数校验
- 自动规则检查
- 实际运行验收
- 完成前强制验收
- 重试、续跑或降级
- 修复工具或平台
- 增加能力或权限
- 增加观测或实验

页面还说明：运行时提交枚举 code，发布到 `final_result` 时展示中文 label；动态字段不属于固定基座契约。这意味着中文 label 不应被当作唯一稳定存储值。

## 5. 输入、输出、证据与指标

### 5.1 输入模型

页面没有暴露后端接口，但可见字段说明表明输入至少包括：

- 一次 Agent 会话；
- 用户需求与后续补充；
- 会话中的 span / 步骤；
- Skill 加载和执行过程；
- 工具调用、错误和恢复记录；
- 业务 profile / registry 中定义的指标和自定义标签配置。

注意：以上是从页面字段依赖推导出的“协议所需信息”，不是对未见后端实现的断言。

### 5.2 输出模型

输出是结构化评测结果，至少包括：

- 需求验收：`requirement_results[]`
- 整体结论：`overall_result`
- 条件多轮衔接：`chain_result`
- Skill 治理：`per_skill_results[]`
- 动态打标：`custom_tags`
- 过程指标：`progress_metric`
- 系统派生：`analysis_schema_version`、`outcome_summary`

其中 `outcome_summary` 根据需求状态自动生成完成计数和完成率，不由 Agent 写入。

### 5.3 证据设计

AIDE 的证据设计有几个值得落地的点：

1. 需求判断层有 `span_id` 和 `evidence`，且 evidence 只能解释该需求为何达成或未达成。
2. Skill 治理层有 `evidence_refs[]`，可引用 1–12 个 span、文件或阶段事实。
3. 对上下文使用类问题，页面要求至少两个证据点，覆盖“已知事实”和“首次未使用”。
4. `evidence_boundary` 必填，用于说明证据能证明什么、不能证明什么。
5. `alternative_explanations` 必填，避免把相关性直接写成确定因果。

这比当前 Agent Trajectory 已有的 `evidenceRecordIds` 更进一步：当前项目能定位证据，但较少强制表达“证据边界”和“替代解释”。

### 5.4 指标设计

`progress_metric` 的关键思想是把指标分为两类：

- rule：直接由 registry 机械计算，可复现；
- agent：由 profile 语义判断，但仍要附带 evidence。

同时，页面明确指标只是证据，不替代 `overall_result`。这能避免“工具成功率高，所以任务成功”这类常见误判。

## 6. 与当前 Agent Trajectory 的逐项映射

### 6.1 定位映射

| AIDE System Evaluator | 当前 Agent Trajectory | 差异 |
| --- | --- | --- |
| 结构化机评和治理协议，面向 final result / governance | 本地只读多来源轨迹查看器 | AIDE 强结果契约，Agent Trajectory 强轨迹投影和可解释浏览 |
| 以需求验收为事实底座 | 以目标、结果、步骤、纠错、五维评测和优化建议为事实底座 | 当前缺少一等公民的“逐项用户需求验收” |
| 按 Skill 记录首次可治理偏离 | 当前优化建议按重复读取、重试、环境、验证缺口等轨迹模式生成 | 当前没有 Skill 级 first-deviation 结构 |
| 动态标签和动态过程指标 | 当前 AI 增强模块和评测维度较固定 | 当前缺少 profile / registry 风格的动态扩展层 |

本地证据：README 把 Agent Trajectory 定义为「独立、只读的多来源 Agent 轨迹查看器」（`LOCAL-E1`）。

### 6.2 工作流映射

| AIDE 工作流 | 当前项目对应实现 | 可落地差距 |
| --- | --- | --- |
| 逐项需求验收 `requirement_results[]` | `objectiveFrom()` 生成单一目标；`TrajectoryAnalysis` 保存 `objective`、`outcome`、`steps` 等（`LOCAL-E2`） | 需要增加多需求拆解、逐项状态、逐项证据 |
| 由需求结果派生 `outcome_summary` | `outcomeEvaluation()` 根据验证、错误、恢复状态生成 outcome（`LOCAL-E3`） | 当前 outcome 主要由轨迹执行状态推导，不由逐项需求状态派生 |
| `overall_result` 与需求状态一致 | `AnalysisEvaluation` 固定五维：结果、稳定性、恢复、效率、可观测性（`LOCAL-E4`） | 需要增加 goal_achievement / failure_domain 这类用户视角归因 |
| 多轮 `chain_result` | 当前有 turn/step 聚合和故事线，但没有专门的跨轮信息承接字段 | 可增加多轮约束承接检查 |
| Skill 首次偏离与最多一条 Action | 当前 `OptimizationSuggestion` 有 evidence、executionActions、verification 等（`LOCAL-E5`） | 建议结构已经接近，但缺 known_state / actual_choice / first_deviation / evidence_boundary / guardrail |
| `custom_tags` 动态扩展 | `AI_ENHANCEMENT_MODULES` 固定为 outcome/objective/story/evaluation/optimization（`LOCAL-E6`） | 可增加 profile 配置层，不把业务标签硬编码到核心模型 |
| `progress_metric` rule/agent 分层 | `stats` 与 evaluation 可计算耗时、错误、重试、Token、可观测性（`LOCAL-E2`、`LOCAL-E4`） | 可显式建 metric registry，区分机械指标和语义指标 |

### 6.3 Evaluator 类型映射

当前 Agent Trajectory 已经有两条“评测器”路径：

1. 本地确定性分析：`analyzeTrajectory()` 生成 `TrajectoryAnalysis`，包含 outcome、stats、steps、corrections、evaluations、optimizations（`LOCAL-E2`）。
2. 本地 Agent 诊断：`TRAJECTORY_DIAGNOSIS_EVALUATOR` 是一个 skill evaluator，描述为“按需取证并输出四块抽象诊断报告”（`LOCAL-E7`）。

AIDE 的 `skill_governance_v3` 则更像第三类：

3. 结构化治理 evaluator：输出固定 JSON 协议，包含需求、整体结论、多轮承接、Skill 证据链、动态标签和过程指标。

这提示当前项目可以把“诊断报告 Markdown”和“结构化评测结果”拆开：Markdown 适合人读，结构化协议适合筛选、统计、回归和治理闭环。

### 6.4 输入 / 输出映射

当前 AI 增强事实包 `SummaryFactPackage` 已经包含：

- 来源和会话 ID；
- 本地统计；
- 目标；
- outcome；
- steps；
- corrections；
- story；
- evaluations；
- optimizations（`LOCAL-E8`）。

当前增强输出包含：

- `AiOutcomeEnhancement`
- `AiObjectiveEnhancement`
- `AiStoryEnhancement`
- `AiEvaluationEnhancement`
- `AiOptimization`
- `AiEvidenceRequest`（`LOCAL-E6`）。

与 AIDE 相比，当前输出更偏“评测叙事增强”，而不是“需求验收 + Skill 治理协议”。尤其缺少：

- `requirement_results[]`
- `overall_result.goal_achievement`
- `overall_result.failure_domain`
- `chain_result`
- `per_skill_results[].known_state`
- `per_skill_results[].actual_choice`
- `per_skill_results[].first_deviation`
- `per_skill_results[].root_cause`
- `per_skill_results[].alternative_explanations`
- `per_skill_results[].evidence_boundary`
- `actions[].guardrail`
- `custom_tags`
- `progress_metric`

### 6.5 证据映射

当前项目已有较好的证据安全基础：

- AI prompt 明确本地事实包权威，AI 不得修改或补造状态、错误、耗时、Token、步骤归属、评测维度和证据关系（`LOCAL-E9`）。
- `validateDraft()` 会过滤 evidence ID，确保输出只引用事实包中存在的证据；evaluation 还要求覆盖每个维度（`LOCAL-E10`）。
- 补充证据最多 24 条、单条 12 KiB、总量 96 KiB，并进行脱敏（`LOCAL-E11`）。
- 诊断快照会去掉 raw 和 searchText、脱敏，并保存冻结分析结果（`LOCAL-E12`）。
- 诊断取证命令只提供 `overview`、`findings`、`records`、`record` 四类只读视图，`record` 默认 64 KiB 截断（`LOCAL-E13`）。

相比 AIDE，主要差距不是“有没有证据 ID”，而是“证据边界有没有结构化表达”：

- 当前有 `evidenceRecordIds`；
- AIDE 还要求 `evidence_boundary` 和 `alternative_explanations`，并对 context-use 类证据规定至少两个点。

### 6.6 指标映射

当前 `TrajectoryAnalysis.stats` 包括耗时、turn、step、错误、重试、恢复、Token、步骤成本覆盖率等（`LOCAL-E2`）。`buildEvaluations()` 还计算：

- 路径稳定性：失败 / 中断 / 重试；
- 恢复能力：未解决 / 已恢复；
- 资源效率：Token 成本集中度和口径一致性；
- 可观测性：原因、耗时、Token、工具结果四类信号（`LOCAL-E4`）。

AIDE 的 progress metric 更强调“可扩展指标注册”：

- `rule.tool_success_rate`
- `rule.user_round_count`
- `agent.correct_skill_load_count`
- `agent.tool_error_recovery_rate`

当前项目可以从已有 stats/evaluations 中抽取 rule metrics，但还没有独立的 metric registry/profile 结构。

## 7. 候选优化

以下优化按“价值 / 成本 / 风险 / 验证”描述，均为候选方案，不在本次调研中实施。

### 7.1 P0：新增 `requirement_results[]`，把需求验收变成事实底座

**价值**

- 当前 `objective` 是单一目标摘要，难以表达用户有多个并列要求时“部分达成”的具体位置。
- AIDE 的逐项需求状态可以直接支撑完成率、未实现项和整体结论，减少“整体说完成但某个明确要求遗漏”的偏差。

**建议落点**

- `src/trajectory-analysis.ts`：在 `TrajectoryAnalysis` 中新增 `requirements` 或 `requirementResults`。
- `src/trajectory-facts.ts`：把 requirements 放进 `SummaryFactPackage`。
- `server/summary/protocol.ts`：如果交给 AI 增强语义，需要新增结构化 schema 和 evidence 校验。
- UI 可能落在 `src/components/TrajectorySummary.tsx` 或当前轨迹评测展示组件。

**最小结构草案**

```ts
interface RequirementResult {
  id: string
  text: string
  state: 'misunderstood' | 'understood_unimplemented' | 'implemented' | 'insufficient_evidence'
  evidenceRecordIds: string[]
  evidence: string
  confidence: 'high' | 'medium' | 'low'
}
```

**成本**

- 中到高。需求拆解涉及语义判断，纯本地规则可能只能覆盖显式列表；AI 增强可做得更好，但必须受本地证据约束。

**风险**

- 把“实现步骤”误拆成“用户需求”。
- 多轮修正后旧需求是否仍有效，需要定义状态机。
- 如果完全依赖 AI，可能引入不可复现差异。

**验证**

- 为多需求 fixture 增加测试：一个需求实现、一个需求未实现、一个需求证据不足。
- 检查每个 requirement 的 `evidenceRecordIds` 都存在于事实包。
- 检查整体结论不能与 requirement 状态矛盾。

### 7.2 P0：让整体结论显式包含 `goal_achievement` 和 `failure_domain`

**价值**

- 当前 outcome 更强调验证状态：是否有测试、错误是否恢复、最终修改是否验证（`LOCAL-E3`）。
- AIDE 的 `failure_domain` 能把问题归到单个 Skill、多 Skill 交接、Agent 通用执行、缺少用户输入或外部条件，更适合治理闭环。

**建议落点**

- `src/trajectory-analysis.ts` 的 outcome / evaluation 结构；
- `src/ai-summary-types.ts` 的 `AiOutcomeEnhancement`；
- `server/summary/protocol.ts` 的 outcome schema。

**成本**

- 中。字段本身简单，难点在归因规则。

**风险**

- 当前来源不一定都有 Skill 信息；直接照搬 `单个 Skill 内部` 等枚举会让非 Skill 轨迹不自然。

**验证**

- 构造验证失败、外部命令缺失、缺少用户输入、已完成但无验证四类轨迹样例。
- 检查 `goal_achievement` 与 `requirement_results[]` 一致。
- 检查 `failure_domain` 在证据不足时返回 `insufficient_evidence`，不强行归因。

### 7.3 P1：新增 `chain_result`，专门评估多轮信息承接

**价值**

- 当前故事线可以解释阶段，但没有专门回答“上一轮用户补充是否被下一轮正确使用”。
- 多轮遗漏约束是 Agent 评测中高价值问题，AIDE 把它单独建模是合理的。

**建议落点**

- `src/objective-synthesis.ts`：可复用目标演化和 steering/user record 识别。
- `src/trajectory-analysis.ts`：在 analysis 中新增可选 `chainResult`。
- `src/trajectory-facts.ts`：将多轮承接证据加入事实包。

**成本**

- 中到高。简单版本可以先只在多用户轮次出现时输出“承接证据不足 / 未评估”；成熟版本需要识别约束是否进入后续行动。

**风险**

- “没有文本重复出现”不等于没有承接；需要避免误判。
- 对代码修改类任务，约束可能体现为文件 diff 或测试而非自然语言。

**验证**

- 使用包含两轮用户补充的 fixture：一条正常承接，一条遗漏约束。
- 要求 `failed_transition` 必须引用前后两个证据点。
- 单轮会话不生成 `chain_result`。

### 7.4 P1：把优化建议升级为 `per_skill_results[]` 式“首次偏离 + 一条治理动作”

**价值**

- 当前 `OptimizationSuggestion` 已有 category、cause、action、target、verification、executionActions 和 evidence（`LOCAL-E5`），基础很好。
- AIDE 的 first-deviation 结构可以让建议更收敛：先说明偏离前已知状态和实际选择，再解释 root cause，最后只给一条可验收动作。

**建议落点**

- `src/trajectory-optimization.ts`：新增或扩展 `OptimizationSuggestion`，加入：
  - `knownState`
  - `actualChoice`
  - `firstDeviation`
  - `alternativeExplanations`
  - `evidenceBoundary`
  - `guardrail`
  - `solutionType`
- `server/summary/guides.ts`：优化模块提示补充 evidence boundary / guardrail。
- `server/summary/protocol.ts`：要求 schema 和 parser 校验这些字段。

**成本**

- 中。字段扩展不难，难点是从轨迹可靠定位“首次偏离”。

**风险**

- 当前三类来源不一定有 Skill 名称；应使用通用 `actor/component` 字段，Skill 可选。
- 若证据不足仍生成 action，会降低可信度。

**验证**

- 对已有重复读取、原样重试、最终修改未验证三类本地发现，检查能生成 first-deviation 和 guardrail。
- 证据不足时不得生成正式 action，只保留候选补证步骤。
- 每个 problem 最多一个 preferred action。

### 7.5 P1：建立 `progress_metric` registry/profile 分层

**价值**

- 当前 stats/evaluations 已能算很多指标，但分散在分析逻辑里。
- AIDE 的 rule/agent 分层有助于让指标可复现、可扩展、可解释。

**建议落点**

- 新增 `src/trajectory-metrics.ts` 或在 `src/trajectory-analysis.ts` 中先内联实现。
- rule metrics 初始可包含：
  - `rule.tool_success_rate`
  - `rule.user_round_count`
  - `rule.validation_after_last_edit`
  - `rule.error_recovery_count`
  - `rule.token_allocation_coverage`
- agent metrics 初始只在 AI 增强启用时产生，并强制 evidence。

**成本**

- 中。rule metrics 可复用现有 records/stats；profile 配置需要设计。

**风险**

- 指标容易被误读为结果结论。需要像 AIDE 一样明确“指标是证据，不直接替代 overall_result”。

**验证**

- 单元测试 rule metrics 的确定性。
- 修改输入轨迹后 facts hash 能变化。
- UI 上将 progress metric 放在“证据 / 过程”区域，不覆盖 outcome。

### 7.6 P2：增加 `analysis_schema_version` 和结构化导出

**价值**

- 当前 `SummaryFactPackage` 有 `schemaVersion: 2`（`LOCAL-E6`），AI 增强缓存也有 `promptVersion`（`LOCAL-E9`），但用户侧评测结果没有像 AIDE 一样公开的 `analysis_schema_version`。
- 如果后续要做批量评测、回归和跨版本对比，结构化版本字段很重要。

**建议落点**

- `src/ai-summary-types.ts` / `src/trajectory-analysis.ts`：新增分析结果协议版本常量。
- API 增加只读导出：例如 `/api/sessions/:source/:id/analysis` 返回结构化 analysis。

**成本**

- 低到中。

**风险**

- 需要维护向后兼容，避免现有 UI/测试因字段变动失效。

**验证**

- 快照测试导出 JSON。
- 版本升级时旧缓存失效或兼容迁移行为明确。

### 7.7 P2：在 AI 增强中加入 `evidence_boundary` 和 `guardrail`

**价值**

- 当前 AI 增强已经限制证据 ID，但仍可能给出过强解释。
- AIDE 要求证据边界和副作用护栏，可以显著提高建议的可审阅性。

**建议落点**

- `src/trajectory-optimization.ts`：`AiOptimization` / `OptimizationExecutionAction` 增加 `guardrail` 或建议级 guardrail。
- `server/summary/protocol.ts`：schema 和 parser 要求 guardrail。
- `server/summary/guides.ts`：提示模型明确证据能证明和不能证明什么。

**成本**

- 低到中。

**风险**

- UI 文案变长，建议卡片需要折叠显示。

**验证**

- parser 对缺失 guardrail 的 AI 输出报错或丢弃。
- 每条 AI 建议至少有一个证据 ID、一个证据边界、一个 guardrail。

## 8. 边界和不建议照搬项

1. **不要把 AIDE 的 Skill 中心 schema 原样套到所有来源。**
   Agent Trajectory 支持 Codex、ZCode、DSH，并非所有轨迹都有 Skill 概念。应设计为 `component/actor` 通用层，Skill 作为可选类型。

2. **不要让 progress metrics 替代结果结论。**
   AIDE 页面明确指出指标是证据，不直接替代 `overall_result`。当前项目也应避免用工具成功率、Token 成本或错误数直接判断任务成功。

3. **不要让模型写派生完成率。**
   AIDE 的 `outcome_summary` 由系统根据 `requirement_results[]` 派生，避免事实和派生值双源。当前若新增需求验收，也应由代码派生完成率。

4. **不要在证据不足时强行生成治理动作。**
   AIDE 允许 `per_skill_results[]` 为空，并说明证据不足时不生成正式 Action。当前优化建议也应保留“不足以建议修改”的状态。

5. **不要把中文 label 当作稳定协议值。**
   页面说明运行时提交枚举 code，发布到 `final_result` 时展示中文 label。当前若借鉴枚举，应保留稳定 code 和本地化 label 的分层。

6. **不要引入会写外部系统的评测流程。**
   本次目标页面只读访问；当前 Agent Trajectory 的优势是本地只读和脱敏冻结快照。任何 AIDE 式 evaluator 集成都应保持只读，至少默认不触发外部评测任务。

7. **不要把内部 AIDE 协议当作公开 API。**
   本报告只基于页面可见文本，未读取后端接口和隐藏配置。实现时应把它当作产品实践参考，而不是依赖内部未确认接口。

## 9. 建议落地顺序

1. **先做需求验收结构（P0）**：新增 `requirement_results[]` 和派生完成摘要，这是 AIDE 实践中最基础、也最能提升结果可信度的部分。
2. **再做整体归因（P0）**：把 `goal_achievement` 和 `failure_domain` 加入 outcome，避免只有验证状态、缺少用户视角归因。
3. **随后做首次偏离治理（P1）**：在现有 optimization 基础上补 `known_state / actual_choice / first_deviation / evidence_boundary / guardrail`。
4. **再做多轮承接（P1）**：先做条件字段和保守证据展示，成熟后再做语义判断。
5. **最后做动态标签和指标 registry（P1/P2）**：先固化几个 rule metrics，再考虑 profile 化和 agent metrics。

## 10. 证据清单

### AIDE 页面证据

- `AIDE-E1`：目标 URL 可访问，页面标题为「Aide-大数据研发的 AI 助手」；页面主标题为「把一次 Agent 会话拆成可验收的需求、结论、证据与治理动作」。
- `AIDE-E2`：页面显示 `FULL ANALYSIS · skill_governance_v3`；协议为 `skill_governance_v3`。
- `AIDE-E3`：页面显示「必填基座 requirement + overall + per_skill」「嵌套动作 per_skill_results[].actions[]」「动态扩展 custom_tags + progress_metric」「多轮条件 chain_result」。
- `AIDE-E4`：`requirement_results[]` 说明为「逐项判断用户要求是否被理解、实现，并给出可复核证据；至少提交一项」。
- `AIDE-E5`：页面说明 `requirement_results[]` 是 Full Analysis 的事实底座；`outcome_summary` 由 finalize 阶段派生，只读展示，不是 Agent 写入字段。
- `AIDE-E6`：`requirement_results[]` 字段包括 `text`、`state`、`span_id`、`evidence`；`state` 枚举包括未理解需求、已理解未实现、已理解且正确实现、证据不足。
- `AIDE-E7`：`overall_result` 说明为「从用户视角回答：最终拿到了什么、缺了什么，问题属于哪一层」。
- `AIDE-E8`：`overall_result.goal_achievement` 枚举包括完整达成、部分达成、未达成、证据不足；`failure_domain` 枚举包括无问题、单个 Skill 内部、多 Skill 交接、Agent 通用执行问题、缺少用户输入、受外部条件限制、证据不足。
- `AIDE-E9`：`chain_result` 仅在多轮会话出现，用于判断上一轮信息是否被正确承接到下一轮；单轮不生成。
- `AIDE-E10`：`chain_result` 字段包括 `rounds_continuity`、`failed_transition`、`chain_verdict`、`chain_evidence`。
- `AIDE-E11`：`per_skill_results[]` 说明为按 Skill 记录首次可治理偏离、证据边界和最多一条可验收的改进动作；没有稳定根因时允许为空。
- `AIDE-E12`：`per_skill_results[]` 字段包括 `known_state`、`actual_choice`、`first_deviation`、`root_cause`、`alternative_explanations`、`confidence`、`evidence_refs[]`、`evidence_boundary`、`execution_quality_flags[]`、`verdict`。
- `AIDE-E13`：页面说明 `evidence_refs[]` 引用 1–12 个可复核的 span、文件或阶段事实；context_use 至少需要两个证据点。
- `AIDE-E14`：`actions[]` 绑定当前 Skill 和首次偏离，最多一条；证据不足时不生成正式 Action。
- `AIDE-E15`：`actions[]` 字段包括 `solution_type`、`change_target`、`action`、`acceptance_criteria[]`、`guardrail`。
- `AIDE-E16`：`custom_tags` 是基座协议之外的动态维度，key 来自 `analysis_plan.custom_labeling.fields`。
- `AIDE-E17`：`progress_metric` 分为 rule 和 agent 两层；指标是证据，不直接替代 `overall_result`；Full Analysis 的需求完成率来自 `requirement_results[]`。
- `AIDE-E18`：页面示例 rule metrics 包括 `rule.tool_success_rate`、`rule.user_round_count`；agent metrics 包括 `agent.correct_skill_load_count`、`agent.tool_error_recovery_rate`。
- `AIDE-E19`：页面说明运行时提交枚举 code，发布到 `final_result` 时展示中文 label；动态字段不属于固定基座契约。

### 本地项目证据

- `LOCAL-E1`：`README.md:1-4` 将 Agent Trajectory 定位为独立、只读的多来源 Agent 轨迹查看器。
- `LOCAL-E2`：`src/trajectory-analysis.ts:72-104` 定义 `TrajectoryAnalysis`，包含 `objective`、`outcome`、`stats`、`steps`、`costSteps`、`corrections`、`evaluations`、`optimizations`。
- `LOCAL-E3`：`src/trajectory-analysis.ts:793-938` 的 `outcomeEvaluation()` 根据运行中、验证失败、验证成功、最终修改未验证、纠错恢复等轨迹事实生成 outcome。
- `LOCAL-E4`：`src/trajectory-analysis.ts:940-1075` 的 `buildEvaluations()` 生成结果证据、路径稳定性、恢复能力、资源效率、可观测性五类评测。
- `LOCAL-E5`：`src/trajectory-optimization.ts:15-42` 定义 `OptimizationSuggestion` 和 `OptimizationExecutionAction`；`src/trajectory-optimization.ts:372-565` 的 `analyzeTrajectoryOptimizations()` 以本地规则生成优化建议；`src/trajectory-optimization.ts:568-617` 限制 AI 只能细化建议，不能改变本地证据和严重度。
- `LOCAL-E6`：`src/ai-summary-types.ts:10-26` 定义 AI 增强模块为 outcome、objective、story、evaluation、optimization；`src/ai-summary-types.ts:111-126` 定义 `SummaryFactPackage`；`src/ai-summary-types.ts:128-181` 定义 AI 增强输出和 evidence request。
- `LOCAL-E7`：`src/diagnosis-types.ts:15-24` 定义唯一内置 `TRAJECTORY_DIAGNOSIS_EVALUATOR`，类型为 skill，描述为按需取证并输出四块抽象诊断报告。
- `LOCAL-E8`：`src/trajectory-facts.ts:19-73` 的 `buildSummaryFacts()` 从本地 analysis 构造脱敏事实包，并携带 evidenceRecordIds。
- `LOCAL-E9`：`server/summary/engine.ts:71-90` 的 facts prompt 要求 AI 不得修改或补造状态、错误、耗时、Token、步骤归属、评测维度和证据关系，并声明本地事实、数字、ID 和证据关系始终权威。
- `LOCAL-E10`：`server/summary/engine.ts:166-245` 的 `validateDraft()` 过滤并校验 evidence IDs、story stage、evaluation 覆盖和模块完整性。
- `LOCAL-E11`：`server/summary/engine.ts:483-510` 的补充证据读取最多 24 条、单条 12 KiB、总量 96 KiB，并脱敏。
- `LOCAL-E12`：`server/diagnosis/evidence-store.ts:43-57` 生成诊断快照时移除 raw 和 searchText；`server/diagnosis/evidence-store.ts:83-107` 保存带 `analysis` 的私有脱敏冻结快照。
- `LOCAL-E13`：`server/diagnosis/evidence-query.ts:10-23` 定义只读 evidence view；`server/diagnosis/evidence-query.ts:81-147` 提供 overview、findings、record、records 查询。
- `LOCAL-E14`：`skills/trajectory-diagnosis/SKILL.md:18-27` 要求诊断会话通过 evidence command 只读取证，不能改项目、配置、网络或外部系统。
- `LOCAL-E15`：`skills/trajectory-diagnosis/SKILL.md:54-83` 固定诊断报告四个顶层标题：最终目标、模型思维&行动、结果、问题&建议。
- `LOCAL-E16`：`README.md:120-153` 描述本地轨迹诊断：冻结脱敏快照、只读取证、64 KiB 截断、四块报告、Codex/ZCode 受限启动。
