# Agent Trajectory 行业评测实践对标与功能优化建议

> 调研日期：2026-10-24
> 当前项目基线：`d5a7f952bf8b41d5fe3090952512b4ee8fa180ff` 加当前工作区未提交改动
> 调研范围：1 份 Harvard 课程资料、3 篇行业文章、7 份公司内部实践，共 11 路独立分析

## 结论

Agent Trajectory 当前已经具备一套质量较高的**单会话轨迹事实与诊断底座**：

- DSH、Codex、ZCode 三来源统一投影；
- record 级 provenance、trace/span、工具输入输出、Token、耗时和 coverage；
- 固定五维的本地确定性过程评测；
- 有证据约束的 AI 语义增强；
- 私有、脱敏、不可变的诊断快照和按需取证；
- 本地优化建议及真实 record 定位。

与 11 份行业和内部实践相比，主要缺口不是“再增加一种总结”或“再增加一个诊断 Agent”，而是缺少把已有能力组织成持续 Evaluation Loop 的产品层：

1. 没有显式的评估合同、不可判断状态和指标依赖；
2. 没有逐项用户需求验收和多轮信息承接评测；
3. 没有任务/Skill 专用的过程检查规则；
4. 没有固定样本集、批量运行、Evaluator 版本和基线；
5. 没有对 Evaluator 自身做人工校准、误报/漏报和稳定性评测；
6. 没有 baseline/candidate 对比与回归门禁；
7. 优化建议尚未进入“采纳—复测—验证”的闭环。

推荐主线是：

```text
现有轨迹事实与冻结快照
  → 显式评估合同与逐项需求验收
  → 小型 Gold benchmark + 本地批量 runner
  → Skill/工作流 Process Check Spec
  → baseline/candidate 对比与回归门禁
  → 人工校准、badcase 回流和采纳账本
```

不建议把项目扩张为 Agent 执行平台、云端全量评测平台或自动修改/发布系统。其差异化价值仍应是：**local-first、read-only、多来源、证据可追溯的 Agent 轨迹评测与诊断工具**。

## 调研方法与证据边界

### 11 路来源状态

| # | 来源 | 访问结果 | 主要贡献 |
| ---: | --- | --- | --- |
| 1 | Harvard CS2680 Agent Evaluation | 首轮取得原始页面并确认 `#evaluation-loop`；替补复核超时；未追外链 | Evaluation Loop、outcome/trajectory grader、任务集维护、生产失败回流 |
| 2 | 淘宝 AI 购物助手在线评测 | 微信正文完整可读 | Judge-ready 数据治理、CTX 短路漏斗、上下文隔离、日级校准 |
| 3 | AI Agent 应用精细化评测 | 微信正文完整可读，并核验 Anthropic 一手资料 | 与 Agent 架构同构的模块评测、EvalTrace、Real/Mock、质量/成本/性能 |
| 4 | Graph Engineering 实践 | 微信正文完整可读 | 生成者/评测者/达标判定者分权、双侧样本、四象限门禁 |
| 5 | AIDE System Evaluator | 现有登录态可读目标页面 | 逐项需求验收、多轮承接、Skill 首次偏离、证据边界、动态指标 |
| 6 | Aide Solo 观测与评测 | 飞书 Docx 只读全文成功 | Skill Stage YAML、`applicable_if` / `pass_if`、批量专项分析和分母口径 |
| 7 | Skill 过程诊断及自进化 | 飞书 Wiki/Docx 分章节只读成功 | 关键环节检查、跨会话稳定率、采纳审核和版本回归 |
| 8 | Fornax 剧创 Agent 机评实践 | ByteTech 与内嵌 Docx 全文可读 | 评估合同、Gold/Target/Evaluator/Experiment、校准和版本冻结 |
| 9 | 短剧平台机评体系 | 飞书 Wiki/Docx 只读成功 | 金标/校准/对抗集、人机一致性、组合式 Evaluator、`cannot_judge` |
| 10 | Fornax 分享第 17 页 | 登录态读取 31 页 DOM 与讲稿成功 | live/frozen Target、真实结果与回放隔离、对齐失败单独记账 |
| 11 | 短剧机评能力地图 | Wiki 解析成功，核心内容来自只读 iframe | 能力成熟度地图、pinned Target、Kappa/FP/FN 和门禁等级 |

### 当前项目基线口径

当前工作区已有大量未提交功能和改动，因此本报告不是只对比 `HEAD`，而是以工作区现状为能力基线。判断优先级为：

1. 当前源码和测试能够证明的行为；
2. README 中与源码一致的已实现说明；
3. 现有优化和对标文档；
4. 无源码支撑的描述不计为已实现。

本轮只新增研究文档，没有修改产品源码、测试、配置或外部系统。

## 标杆实践的共同框架

11 路来源虽然来自课程、购物 Agent、数据研发 Skill 和多模态短剧评测，但高度收敛到同一套结构。

### 1. 先定义评估合同，再运行 Judge

评估器必须明确：

- 输入是什么；
- 输出是什么；
- 适用条件是什么；
- 怎样算通过；
- 哪些内容属于合同外；
- 哪些状态是失败、不可判断、系统错误或不适用；
- 需要引用什么证据；
- 哪些后续指标依赖前置指标。

这比“让一个强模型阅读完整轨迹然后打分”更可靠。

### 2. Outcome 和 trajectory 必须分开

最终任务是否完成，与执行路径是否可靠、高效、可恢复，是不同问题：

- outcome grader 判断用户需求是否达成、产物是否经过验证；
- trajectory/process grader 判断目标承接、工具使用、错误恢复、流程门禁和资源消耗；
- 过程成功不能代替业务正确；
- 结果正确也不能掩盖越权、泄漏、严重浪费或不可复现路径。

### 3. Code、model、human grader 组合使用

| Grader | 适合判断 | 不适合承担 |
| --- | --- | --- |
| Code/rule | 结构、状态、退出码、顺序、Token、耗时、是否执行验证、是否原样重试 | 开放语义、业务价值、复杂目标达成 |
| Model | 需求拆解、语义忠实度、根因候选、模糊场景解释 | 改写本地事实、决定确定性数值、无证据硬判 |
| Human | Gold 标签、争议仲裁、业务价值、主观和高风险边界 | 全量逐条审核 |

当前项目“本地事实权威、AI 只增强语义”的边界与该共识一致，应继续保留。

### 4. 数据集本身是产品

标杆实践普遍把样本分为：

- golden：人工确认的基准；
- calibration：优化 Evaluator；
- boundary/challenge/adversarial：覆盖边界与对抗；
- independent test：验证泛化；
- regression：固定版本比较；
- population/positive control：防止只修 badcase 时误伤正常样本；
- production candidates：由线上失败回流、去重、脱敏并审核后进入。

只看少数已知失败会诱导过拟合。Graph Engineering 的双侧样本尤其值得采用：一侧看已知问题是否修复，另一侧看正常样本是否被误伤。

### 5. 不可判断不是失败

以下状态不能都压成 `bad`：

- 证据不足；
- 当前检查不适用；
- 来源未记录；
- 投影 coverage gap；
- Target/字段映射/对齐失败；
- 评测器自身运行失败；
- 外部依赖不可用；
- 合同外问题；
- 质量风险，需要人工复核。

如果这些状态进入失败分母，指标会把观测缺口误写成 Agent 缺陷。

### 6. Evaluator 也必须被评测

不能只展示 Agent 得分，还要测 Evaluator：

- 与人工 Gold 的 exact/adjacent agreement；
- precision、recall、FP、FN；
- Kappa 或其他一致性指标；
- 正控通过率；
- 重复运行稳定性；
- 位置/顺序偏置；
- 低置信转人工比例；
- 结构化解析失败率；
- 证据请求、截断和非法引用；
- 成本与延迟；
- Rubric/Prompt/模型版本变化。

### 7. 控制面不能交给生成者

文章中的失败经验非常一致：

- 生成候选的模型不能自己决定是否达标；
- 不能让同一个模型自行选择最有利的 baseline；
- 不能只在固定 badcase 上循环优化；
- 状态推进、阈值、早停、版本冻结和发布门禁应由代码控制；
- AI 可生成候选解释与建议，但 pass/fail、证据 ID 和确定性指标必须受本地门禁。

## 当前项目能力矩阵

| 能力 | 当前状态 | 证据 | 判断 |
| --- | --- | --- | --- |
| 多来源统一轨迹 | 已支持 | `src/types.ts`、三来源 projector/source | 核心优势 |
| record provenance | 已支持 | `sourceEventIds`、`fidelity`、trace/span、relation | 可直接作为 grader 证据层 |
| 单会话结果判断 | 已支持 | `outcomeEvaluation()` | 对明确验证和未恢复错误较可靠 |
| 固定五维过程评测 | 已支持 | `AnalysisEvaluation` | 适合默认通用视图，不足以覆盖业务/Skill 专项 |
| 确定性反模式检测 | 已支持 | `analyzeTrajectoryOptimizations()` | 可注册为首批 code grader |
| 事实/推断/未知区分 | 已支持 | `reasonLevel`、confidence、coverage | 基础良好 |
| AI 事实包与结构化校验 | 已支持 | `SummaryFactPackage`、`validateDraft()` | 可复用为受限 model grader 外壳 |
| 二阶段按需补证 | 已支持 | `evidenceRequests` | 比整段轨迹注入更安全 |
| 冻结诊断 Target | 已支持 | `DiagnosisEvidenceSnapshot`、fingerprint 双检 | 可扩展为 benchmark target |
| 诊断报告 | 已支持 | `trajectory-diagnosis` Skill | 适合人读诊断，不适合作为唯一门禁输出 |
| 逐项用户需求验收 | 缺失 | 当前只有单一 `objective` | 无法准确表达多要求的部分达成 |
| 多轮信息承接评测 | 部分支持 | 有 turn/story/steering，无 `chain_result` | 不能单独回答已知信息是否遗失 |
| Judge-ready 数据质量报告 | 缺失 | 有 coverage，但未形成评测输入质量合同 | 评测前置风险不可见 |
| 可配置 Rubric/Process Check | 缺失 | 固定五维和固定 advice | 不能评估特定 Skill 必须发生的步骤 |
| `pass/fail/na/unknown/error` 状态 | 部分支持 | grade 有 unknown，缺 N/A/error/out-of-scope 统一语义 | 聚合分母容易失真 |
| 指标依赖图 | 缺失 | 无 blocked-by/denominator 语义 | 上游失败会污染下游指标 |
| Dataset / Case | 缺失 | 只有测试 fixture，不是产品级评测集 | 无稳定样本基线 |
| Batch EvaluationRun | 缺失 | 单会话分析 | 无稳定率与跨 case 聚合 |
| Evaluator registry/version | 极弱 | 诊断 evaluator 只有一个常量 | 无版本冻结与组合 |
| 人工 Gold 与校准 | 缺失 | 无人工标签 schema | 无法测 Evaluator 是否可信 |
| Baseline/candidate diff | 缺失 | 有单次分析与缓存 | 无回归门禁 |
| 生产失败回流 | 缺失 | 可冻结快照，但不能标成 case candidate | 无持续数据集演进 |
| 建议采纳与复测 | 缺失 | 建议只展示/复制 | 无改进闭环 |

## 推荐功能路线

### P0：先让当前评测结果“可定义、可复核、可校准”

#### P0-1：新增统一 Evaluation Contract

不要直接修改现有 `TrajectoryAnalysis` 的所有字段。建议新增独立评测模型层，把当前分析作为第一批 evaluator 输入。

候选类型：

```ts
type EvaluationVerdict =
  | 'pass'
  | 'fail'
  | 'warning'
  | 'not_applicable'
  | 'insufficient_evidence'
  | 'evaluator_error'
  | 'out_of_scope'

interface EvaluationTargetRef {
  source: SourceId
  sourceSessionId: string
  mode: 'live' | 'frozen'
  fingerprint: string
  snapshotId?: string
}

interface EvaluationResult {
  evaluatorId: string
  evaluatorVersion: string
  criterionId: string
  verdict: EvaluationVerdict
  confidence: 'high' | 'medium' | 'low'
  evidenceRecordIds: string[]
  counterEvidenceRecordIds: string[]
  evidenceBoundary: string
  attribution?: string
  blockedBy?: string[]
}
```

关键行为：

- `not_applicable`、`insufficient_evidence` 和 `evaluator_error` 不进入质量失败分母；
- 每个结论必须带 evidence 或明确 evidence boundary；
- 系统/投影/字段错误与 Agent 质量失败分开；
- 结果记录 evaluator、schema、事实包和 Target 版本；
- 本地确定性事实始终优先于 AI 输出。

建议涉及模块：

- 新增 `src/evaluation-types.ts`；
- `src/trajectory-analysis.ts` 作为默认本地 evaluator；
- `src/trajectory-facts.ts` 输出评测事实包和数据质量；
- `src/components/TrajectorySummary.tsx` 增加状态与边界展示；
- `server/summary/protocol.ts` 增加受限 Judge schema。

验收条件：

- coverage gap、会话仍运行、最后修改未验证、未恢复错误、来源不支持 trace 等 fixture 能得到不同且正确的 verdict；
- 不可判断样本不计入失败分母；
- UI 能解释“为什么不判断”，并定位最小补证步骤。

#### P0-2：新增 Judge-ready Fact Quality Report

在调用 AI 或 Process Check 前，先判断事实包是否适合评测。

最小检查：

- input/output/error 是否缺失或截断；
- 工具调用与结果是否配对；
- trace/span/parent 是否断裂；
- 当前结论涉及的来源能力是否可用；
- coverage gap 是否影响判据；
- 时间锚点是否存在；
- live Target 是否仍变化；
- replacement/shadowed context 是否被误用；
- 当前模块允许的 context scope 是 session、turn、step、span 还是 tool call。

价值：

- 防止来源缺字段被归因成 Agent 错；
- 防止前一轮工具结果污染当前轮 Judge；
- 为 `insufficient_evidence` 提供结构化原因；
- 评测失败时先区分“数据问题、Rubric 问题、Agent 问题”。

验收条件：

- 三来源 fixture 都能生成稳定质量报告；
- 超长字段、截断、缺 result、coverage gap 有明确 warning；
- facts hash 包含质量报告，质量边界变化会使旧缓存失效。

#### P0-3：新增逐项 RequirementResult 和 ChainResult

当前单一 `objective` 无法准确表达“多个用户要求中完成了哪些”。建议新增：

```ts
interface RequirementResult {
  id: string
  text: string
  state:
    | 'misunderstood'
    | 'understood_unimplemented'
    | 'implemented'
    | 'superseded'
    | 'insufficient_evidence'
  evidenceRecordIds: string[]
}

interface ChainResult {
  continuity: 'normal' | 'incorrect' | 'missing' | 'insufficient_evidence'
  failedTransition?: { fromTurn: number; toTurn: number }
  evidenceRecordIds: string[]
}
```

约束：

- requirement 的事实、整体结论、Skill 根因和优化建议分层；
- 多轮修正后的旧要求可标记 superseded；
- overall outcome 必须与 requirement 状态一致；
- chain 只评估已知信息承接，不替代故事线。

验收条件：

- 多要求、多轮补充、用户改道和部分完成 fixture 能逐项显示；
- “整体完成”不能与未实现 required requirement 并存；
- chain 能识别后续丢失前轮信息，但不把合法目标修正判错。

#### P0-4：建立最小 Gold Benchmark

先不做复杂评测平台，选择 30～50 条脱敏冻结快照：

- 三来源均有样本；
- 成功、未验证、失败、恢复、中断、长会话、工具密集等切片；
- 至少两类正常正控；
- 每条含人工 outcome、关键问题、允许 N/A、证据 ID 和主因标签；
- 分为 calibration、challenge、independent test、regression。

复用现有能力：

- `DiagnosisEvidenceStore` 作为 frozen Target；
- `analyzeTrajectory()` 作为 `local-trajectory-v1`；
- `SummaryFactPackage` 作为可选 model grader 输入；
- 现有 fixture 作为起始 synthetic case。

验收条件：

- 同 commit、同 dataset 连跑输出稳定；
- 报告能计算 precision、recall、FP、FN、N/A 和稳定性；
- 真实内容保持脱敏，不提交原始会话路径、ID 和正文。

### P1：从单会话评测升级为轻量 Evaluation Loop

#### P1-1：Process Check Spec

这是内部 Skill 实践中共识最强的功能。建议支持最小 YAML/JSON：

```yaml
id: trajectory-diagnosis-contract
version: 1
scope:
  skill: trajectory-diagnosis
sections:
  - name: evidence-loop
    applicable_if: session_is_frozen
    checks:
      - id: starts-with-overview-findings
        criticality: required
        pass_if: 先读取 overview 和 findings，再按需读取 records/record
        evidence_hint:
          - evidence command records
```

首版字段：

- id、version、scope；
- section；
- `applicable_if`；
- check id/name；
- criticality；
- `pass_if`；
- context scope；
- evidence hint；
- allowed verdict；
- dependency / blockedBy。

首个被评对象应是仓库内置 `trajectory-diagnosis` Skill，因为：

- 流程合同已明确；
- 已有冻结 fixture 和证据 CLI；
- 可验证“先 overview/findings、按需下钻、四块报告、不得读取 live source”；
- 不依赖外部业务真值。

验收条件：

- 通过、缺失、错误顺序、不适用、证据不足 fixture 均有明确结果；
- 每个 fail 能定位到 recordId；
- 模糊 `pass_if` 不允许直接进入发布门禁。

#### P1-2：Batch EvaluationRun 和报告

建议新增：

```ts
interface EvaluationDataset {
  id: string
  version: string
  cases: EvaluationCase[]
}

interface EvaluationRun {
  id: string
  dataset: { id: string; version: string }
  evaluators: Array<{ id: string; version: string }>
  targets: EvaluationTargetRef[]
  baselineRunId?: string
  createdAt: number
}
```

首版只支持：

- 用户显式选择 session/snapshot；
- 有界并发；
- 本地 JSON/Markdown 产物；
- 会话 hash，不输出原始 ID；
- 样本级 pass/fail/N/A/error；
- criterion、来源和任务类型切片；
- 质量、成本、性能三栏。

不支持：

- 全盘自动扫描；
- 自动运行/修改 Agent；
- 自动上传外部平台；
- 自动写 Skill。

验收条件：

- 三来源固定样本可重复运行；
- 聚合报告分母正确；
- 任何 case 可下钻到本地轨迹证据；
- 中途中断可恢复或明确标记 error。

#### P1-3：Baseline/Candidate 对比和双侧样本门禁

对同一 dataset、Target 和 evaluator 版本比较：

- improved；
- regressed；
- unchanged；
- inconclusive；
- 新增 FP/FN；
- Token、工具调用、耗时变化；
- P0 required criterion 是否退化。

采用 Graph Engineering 的双侧设计：

- issue/badcase set：检查已知问题是否修复；
- population/positive-control set：检查正常样本是否误伤。

建议判据：

- 已知问题召回提升；
- 正常样本误报不超过阈值；
- P0 criterion 不允许退化；
- unknown/N/A 比例不能异常上升；
- 成本和延迟增幅必须在预算内。

验收条件：

- 总通过率提升但 required criterion 退化时仍判 Reject；
- 只修 badcase、误伤正控时明确显示“疑似过拟合”；
- baseline 与 candidate 样本不一致时拒绝直接归因。

#### P1-4：Evaluator Registry 和校准报告

Evaluator 类型建议：

- code/rule；
- model；
- human/imported；
- composite；
- diagnostic Skill。

每个 evaluator 记录：

- id/version；
- input schema；
- output schema；
- contract；
- context scope；
- dependencies；
- model/adapter/temperature；
- prompt/rubric hash；
- cost；
- calibration status；
- gate level：可门禁、需人工、仅辅助。

校准报告包括：

- exact/adjacent agreement；
- precision/recall/FP/FN；
- Kappa（有足够双人标签时）；
- 正控通过率；
- 多次运行稳定性；
- 低置信转人工；
- 解析失败、非法证据、截断；
- 质量/成本/延迟。

### P2：形成可持续改进闭环

#### P2-1：Badcase Candidate 和 Casebook

允许用户把失败快照标记为 dataset candidate：

- 自动生成脱敏候选；
- 保留 user goal、observed result、failure category、evidence ID；
- 人工补充 expected behavior；
- 去重后加入 dataset；
- 记录来源和回流原因。

默认只写本地私有数据，不自动提交仓库。

#### P2-2：优化建议采纳账本

在现有 `OptimizationSuggestion` 之上记录：

- accepted/rejected/deferred；
- 决策理由；
- 目标规则/Skill/代码；
- baseline run；
- candidate run；
- 验证条件；
- 实际改善；
- 是否回滚。

仍不提供一键执行，只提供导出/复制和显式关联复测结果。

#### P2-3：只读导入外部 Evaluation Run

对已经由 Fornax、AIDE 或其他系统产生的结果，支持导入不可信 JSON artifact：

- 校验 schema；
- 标记来源和 evaluator；
- 关联本地 sourceSessionId/recordIds；
- 展示 run、case、metrics、judge outputs；
- 不把外部得分改写成本地事实；
- 不执行外部 Agent 或 Mock。

这条路径能吸收企业评测平台结果，同时保持本项目轻量与只读。

#### P2-4：AI Judge 稳定性与抗过拟合

在使用 model grader 后补充：

- 同一 facts hash 重复运行稳定性；
- A/B 顺序交换；
- quote/evidence grounding；
- 规则形态和证据泄漏扫描；
- 防止硬编码样本、路径或长段复制；
- 失败反馈只进入下一轮，长期经验必须蒸馏且有客观评测支持。

## 推荐的最小实施切片

如果只做一轮功能建设，建议范围固定为：

1. `EvaluationVerdict`、`EvaluationTargetRef`、`EvaluationResult`；
2. Judge-ready facts quality；
3. `trajectory-diagnosis` 的 4～6 条 Process Check；
4. 20～30 个 synthetic/frozen benchmark case；
5. 本地 CLI runner；
6. Markdown/JSON 报告；
7. baseline/candidate diff；
8. 不做新云服务、不执行 Agent、不自动改代码。

预期修改范围：

| 模块 | 候选改动 |
| --- | --- |
| `src/evaluation-types.ts` | 新增合同、Target、criterion/result/run/dataset 类型 |
| `src/trajectory-analysis.ts` | 将当前五维分析注册为 `local-trajectory-v1` |
| `src/trajectory-facts.ts` | 增加评测 facts quality 与 context scope |
| `server/evaluation/` | 新增本地 dataset、runner、registry、report |
| `server/diagnosis/evidence-store.ts` | 允许冻结快照被显式引用为 benchmark Target |
| `server/summary/protocol.ts` | 新增受限 model grader schema |
| `skills/trajectory-diagnosis/` | 增加自身过程检查 spec，不修改执行权限 |
| `tests/evaluation-*.test.ts` | benchmark、分母、依赖、diff、隐私和稳定性测试 |
| UI | 第一阶段可不做，先交付 CLI/Markdown；第二阶段再加 runs/diff 页面 |

风险：

- 将业务正确性和过程健康度混成一个分数；
- 人工 Gold 样本偏置；
- 真实轨迹隐私泄漏；
- model grader 不稳定；
- Rubric 过拟合固定 case；
- Dataset、Rubric、Prompt 和代码版本未一起冻结；
- 批量扫描给本地服务带来性能压力。

对应门禁：

- 分项结论，不合成虚假精确总分；
- 显式选择样本；
- 冻结/脱敏 Target；
- 独立测试集和正控；
- evaluator/schema/dataset 版本化；
- N/A/unknown/error 独立计数；
- AI 不能改本地事实或证据关系；
- 任何外部写操作保持禁用。

## 不建议照搬

1. 不复制 Fornax/AIDE 的云端任务、组织权限和全量数仓流程。
2. 不增加自动建项、自动运行 Agent、自动提交 MR 或自动发布。
3. 不把 LLM-as-Judge 作为唯一真值。
4. 不把商品、短剧、媒体领域的 Rubric 直接硬编码进通用轨迹模型。
5. 不把完整 raw 轨迹长期保存或默认发送给模型。
6. 不用总体一致率或总分掩盖 required criterion、FP/FN 和不可判断。
7. 不把“工具调用成功”写成“任务结果正确”。
8. 不让生成优化建议的模型自行决定建议已通过回归。
9. 不把 `warning`、`unknown`、`N/A`、系统错误和质量失败合并。
10. 不在没有共同 case/Target 的情况下做跨版本因果比较。

## 独立报告索引

1. [Harvard Agent Evaluation](research/agent-evaluation-2026-10-24/01-harvard-agent-evaluation.md)
2. [淘宝 AI 购物助手在线评测](research/agent-evaluation-2026-10-24/02-wechat-blmj.md)
3. [AI Agent 应用精细化评测](research/agent-evaluation-2026-10-24/03-wechat-5tvv.md)
4. [Graph Engineering 实践](research/agent-evaluation-2026-10-24/04-wechat-53zg.md)
5. [AIDE System Evaluator](research/agent-evaluation-2026-10-24/05-aide-system-evaluator.md)
6. [Aide Solo 观测与评测](research/agent-evaluation-2026-10-24/06-lark-sgpz.md)
7. [Skill 过程诊断及自进化](research/agent-evaluation-2026-10-24/07-lark-nzdp.md)
8. [Fornax 剧创 Agent 机评](research/agent-evaluation-2026-10-24/08-bytetech-768982.md)
9. [短剧平台评测体系](research/agent-evaluation-2026-10-24/09-lark-nc4p.md)
10. [Fornax 分享第 17 页](research/agent-evaluation-2026-10-24/10-gf-preview-17.md)
11. [短剧机评能力地图](research/agent-evaluation-2026-10-24/11-lark-qrj9.md)

## 最终判断

当前项目已经完成了 Evaluation Loop 最困难的一半：可信事实、统一轨迹、证据定位、只读安全和单会话诊断。下一阶段不应继续横向增加展示模块，而应把这些能力固化为**可版本化、可批量、可校准、可对比的本地评测系统**。

最优先的产品命题不是“模型能否给出更聪明的总结”，而是：

> 对同一批冻结 Agent 轨迹，在同一评估合同下，当前版本是否比基线更可靠；如果结论发生变化，能否定位到具体 criterion、case 和 record evidence，并证明不是 Evaluator 自身漂移。

只要先完成这个最小闭环，现有五维评测、AI 增强、诊断 Skill 和优化建议就会从单次观察功能，升级为可持续改善 Agent 与 Skill 的工程系统。
