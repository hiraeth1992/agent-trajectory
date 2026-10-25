# 第 6 路调研：Aide Solo 观测与评测实践对 Agent Trajectory 的启发

> 研究对象：`https://bytedance.sg.larkoffice.com/docx/SGPzdvOACobLtFxKViFln6qTgbe`
> 本报告只基于目标飞书 Docx 与本仓库源码/文档等一手材料；不复刻内部正文、截图或报告链接中的敏感内容。

## 1. 来源元信息与访问状态

| 项目 | 结果 |
|-|-|
| 调研日期 | 2026-10-24 |
| 访问身份 | `lark-cli docs +fetch --as user` |
| 文档类型 | 飞书 Docx |
| document_id | `SGPzdvOACobLtFxKViFln6qTgbe` |
| revision_id | `33` |
| 访问状态 | 可访问；完整读取 Markdown 成功；outline 读取成功 |
| 结构检查 | 未发现 `<sheet>`、`<bitable>`、`cite file-type="sheets/bitable"`、`vc-transcribe-tab` 或 `synced_reference`，无需转入表格/Base/会议纪要下钻 |
| 主要标题 | “从业务问题到 Skill 持续改进”：先跑通基础功能，再沿业务案例、定性分析、Skill Stage 评分器、专项分析报告与优化闭环展开 |

执行约束遵循情况：

- 已读取并遵循 `lark-doc`、其前置 `lark-shared` 与 `lark-doc-fetch` 引用，只使用 `lark-cli --as user` 做只读 `docs +fetch`。
- 已遵循 `research` 技能的“基于一手来源、写入单个 Markdown 文件”要求；当前环境没有可调用的背景子代理工具，因此由主流程直接完成取证与写作。
- 未对飞书文档或其他外部系统做任何写操作。

## 2. 核心实践摘要

这份内部实践不是单纯“看一条会话哪里错了”，而是把 Agent/Skill 的改进拆成一个可循环的评测生产流程：

1. 先拿到一条或一批线上会话轨迹，确认实际读取范围、缺失会话和权限边界。
2. 通过 Solo 对话做定性分析：按“用户目标—实际行为—问题表现—证据位置”还原问题，并要求区分已确认问题、可能原因、证据不足与正常样本对照。
3. 将定性发现转成 Skill Stage 评分器，而不是把讨论逐句变成零散规则；评分器用 YAML 表达阶段、适用条件和检查项。
4. 在评测工作台保存评分器后，圈选目标 Skill、时间范围、筛选条件、评测模型和评分器，批量运行专项分析。
5. 读报告时先确认统计对象与分母，再下钻检查项证据；把失败模式转成 Skill、知识、检索入口、工具依赖或评分器本身的建设动作。
6. 复测时保留 Skill 版本、评分器版本、样本范围、评测模型、有效样本数和报告，避免把规则口径变化误读成能力趋势。

这套方法的关键价值在于：把“单次事故复盘”升级为“带版本、带样本、带证据、可重复打标的改进闭环”。它最适合迁移到 Agent Trajectory 的部分，不是具体业务字段规则，而是“定性发现 → 可执行评分器 → 批量打标 → 证据化优化任务 → 新轨迹验证”的产品闭环。

## 3. 流程、指标、数据模型与案例

### 3.1 流程模型

目标 Docx 的流程可以抽象为 A–F 六段：

| 阶段 | 输入 | 动作 | 输出 |
|-|-|-|-|
| A. 会话取样 | 单条或一批历史会话 | 粘贴链接、@ 圈选历史会话、从已有任务带入 | 可分析的轨迹集合 |
| B. 定性分析 | 轨迹集合 + 分析问题 | 要求模型列出读取范围、缺失项、问题表现、证据位置、正常样本对照 | 人工核对过的定性报告 |
| C. 评分器生成与保存 | 定性报告 + Skill 工作流 + YAML 规范 | 生成并核对 Skill Stage YAML；在工作台应用并保存 | 版本化 Skill 专项评分器 |
| D. 批量专项分析 | 目标 Skill、筛选条件、时间范围、评测模型、评分器 | 圈选线上会话并运行打标任务 | Skill Stage 分析报告 |
| E. 报告解读 | 阶段/检查项统计与证据 | 区分分母、N/A、未通过、风险阶段和样本构成 | 待处理失败模式 |
| F. 建设与复测 | 失败模式、证据、建议 | 明确改 Skill、补知识、改检索、修依赖或修评分器；用新轨迹复测 | 可追溯改进记录 |

### 3.2 Skill Stage 评分器数据模型

文档中的 YAML 规范可以整理为以下概念模型：

| 概念 | 字段/约束 | 含义 |
|-|-|-|
| 评分器 | `title`、`skill_set`、`trigger_mode` | 绑定一个或多个目标 Skill；`trigger_mode` 决定命中方式 |
| 分区/阶段 | `sections[].name`、`applicable_if` | 按业务阶段或适用场景组织检查，避免全量会话都套同一标准 |
| 检查项 | `checks[].name`、`criticality` | 表达必须检查或条件性检查的行为要求 |
| 判断方法 | `verify.method: judge` | 由评测模型根据轨迹证据判断 |
| 通过标准 | `verify.pass_if` | 必须能从轨迹核验，不允许臆造不存在的工具结果 |
| 证据提示 | `evidence_hint` 可选 | 提醒看哪里，但不能替代通过标准 |
| 口径要求 | 不生成无来源 `id`；规则从最小可用开始 | 降低过拟合和不可判定风险 |

这里最重要的设计点是 `applicable_if` 与 `pass_if`：前者解决“这个检查是否应该发生”，后者解决“发生到什么程度才算通过”。这比单纯给会话打一个总分更适合 Agent 轨迹，因为很多任务没有业务真值，只有过程证据。

### 3.3 报告指标与读法

目标实践强调不同分母不能混用，主要指标包括：

| 指标 | 含义 | 误读风险 |
|-|-|-|
| 会话完整达成率 | 以完整会话目标为单位 | 不能直接替代需求条目达成率 |
| 需求项达成率 | 以会话内拆出的需求条目为单位 | 一个会话可能部分达成，因此分母不同 |
| 工具成功率 | 工具调用是否成功返回 | 工具成功不等于业务结果正确 |
| 检查项通过率 | 某检查通过次数 / 有效评分次数 | 不是全部会话业务成功率 |
| 未通过样本数 | 当前检查失败的样本数量 | 不同检查可能命中同一会话，不能简单相加 |
| 阶段成功比例 | 阶段内有效检查的通过情况 | 不是“全部检查都通过的会话占比” |
| N/A / 无法判定 | 不适用或证据不足 | 不等于通过，也不等于失败 |
| 风险/关注/稳定 | 报告阈值下的阶段分档 | 样本不足时不能过度解释 |
| 过程成本 | 均值、P50、P90、步骤数、耗时、澄清次数等 | 能力变好但成本暴涨时仍需优化 |

### 3.4 案例抽象

文档用一个字段新增/验收未通过的业务案例说明评测读法。为避免复制内部正文，这里只保留抽象模式：

- 用户目标：将上游字段映射或聚合到下游表/JSON 字段。
- 现象：开发产物已生成，试跑或部分测试通过，但字段一致性验收存在失败项。
- 关键拆分：字段来源/聚合口径/下游解析值的一致性问题，与后续因目标分区无数据而暂停等待用户选择的问题，不应混成一个根因。
- 评测动作：先从整体报告确认影响面，再下钻到问题样本和证据位置，形成可复现的改进项。
- 建设动作：若权威口径缺失，应补知识；若口径已知但未落实，应改 Skill 流程、状态传递或交付前校验；若评分器误判，应修 `applicable_if` 和 `pass_if`。

这个案例对 Agent Trajectory 的启发是：评测要能区分“业务语义错”“流程没做”“环境/权限阻断”“证据不足”“评分规则不适用”。当前项目的本地过程评测已经具备部分基础，但还缺少业务可配置的检查项与批量样本维度。

## 4. 与当前 Agent Trajectory 的映射

### 4.1 当前项目已有能力

| 内部实践能力 | Agent Trajectory 现状 | 本地证据 |
|-|-|-|
| 统一读取 Agent 轨迹 | 已支持 DeepSeek Harness、Codex、ZCode，本地只读投影到统一时间线/检查器 | `README.md:3-18`：项目定位、多来源与安全边界 |
| 轨迹事实模型 | 已有 `TrajectoryRecord`，包含 turn/step、kind、status、输入输出、错误、usage、metrics、policy、retry 等 | `src/types.ts:148-197` |
| 会话/任务状态 | 已有 session header、task target/todos、relations/coverage 等基础结构 | `src/types.ts:66-79`、`src/types.ts:223-260` |
| 单会话过程评测 | 已有 `AnalysisEvaluation` 五维：结果证据、路径稳定性、恢复能力、资源效率、可观测性 | `src/trajectory-analysis.ts:62-70`、`src/trajectory-analysis.ts:940-1075` |
| 过程故事线 | 已把步骤压缩为阶段：分析目标、检查证据、修改实现、验证、恢复、汇报、上下文整理等 | `src/trajectory-story.ts:18-38`、`src/trajectory-story.ts:374-390` |
| 证据定位 | UI 中评测项、步骤、优化建议都支持回到 record evidence | `src/components/TrajectorySummary.tsx:151-182`、`src/components/OptimizationPanel.tsx:202-218` |
| 优化建议 | 已有本地确定性优化建议模型，包含问题、原因、措施、位置、预期改善、验证方式、判断限制、可执行动作 | `src/trajectory-optimization.ts:24-43`、`README.md:225-230` |
| AI 增强 | 已有 outcome/objective/story/evaluation/optimization 五类增强模块，使用脱敏事实包与证据请求二阶段校验 | `src/ai-summary-types.ts:10-26`、`server/summary/engine.ts:71-90`、`server/summary/engine.ts:483-510` |
| 诊断会话 | 已能冻结快照，用内置 `trajectory-diagnosis` Skill 只读取证据并生成四段诊断报告 | `README.md:126-150`、`server/diagnosis/service.ts:90-152`、`skills/trajectory-diagnosis/SKILL.md:10-28` |
| 不制造虚假总分 | UI 明确“过程评测：分项结论，不合成虚假精确的总分” | `src/components/TrajectorySummary.tsx:570-588` |

这些能力说明 Agent Trajectory 已经有“单会话可观测 + 本地事实评估 + 建议生成 + 受限诊断”的基础，适合承接内部实践中的“证据化改进”部分。

### 4.2 当前明显缺口

| 缺口 | 影响 |
|-|-|
| 没有可配置评分器/检查项 DSL | 只能看固定五维过程评测，不能表达某个 Skill 的业务阶段要求 |
| 没有批量 EvaluationRun / BatchReport 实体 | 难以回答“这一批同类需求整体完成得怎样” |
| 没有 `applicable_if` / N/A 口径 | 容易把“不适用”“证据不足”“未执行”混在一起 |
| 没有评分器版本、评测模型、样本范围记录 | 难以做周期对比和改动后复测 |
| 优化建议还停留在展示/复制层 | 已能生成可执行动作，但缺少“采纳—改动—新轨迹复测—报告对比”的闭环 |
| AI 增强是模块增强，不是业务 judge | 现有 SummaryEngine 可以辅助语义分析，但没有执行可配置 `pass_if` 判断 |

代码搜索也支持这一判断：仓库中能找到 `stage`、`evaluation`、`optimization`、`AI enhancement` 等概念，但未发现产品级 `scorer` / `rubric` / `Skill Stage YAML` / `pass_if` / `applicable_if` 等评分器实体。

## 5. 候选优化方案

### 5.1 建议优先级总览

| 优先级 | 候选优化 | 价值 | 成本 | 风险 | 验证方式 |
|-|-|-|-|-|-|
| P0 | 引入本地 `ScoringRubric` / `EvaluationRun` / `CheckResult` 数据模型 | 承接 Skill Stage 评分器和批量报告，是后续能力地基 | 高 | DSL 过早复杂化；judge 结论不可复现 | 用 2–3 个 fixture 会话跑最小 YAML，产出 pass/fail/N/A 与证据 recordId |
| P0 | 支持 `applicable_if`、`pass_if`、`evidence_hint` 的最小 YAML | 能表达“是否适用”和“怎样算通过”，避免固定五维不够用 | 中 | 规则写得模糊导致大量 N/A 或误判 | 正常样本、失败样本、无关样本三类 golden test |
| P1 | 基于已有 SummaryEngine 做“证据受限 judge” | 复用脱敏事实包、证据请求、ID 校验和模型适配器 | 中 | 模型将证据外知识带入；评测成本增加 | 要求 judge 输出只能引用允许 recordId；非法 ID 被过滤；成本记录到 run |
| P1 | 增加批量报告视图 | 回答某 Skill/时间范围内的通过率、失败样本、N/A 和成本变化 | 高 | 性能、隐私、样本偏差 | 先支持手动选择 session IDs；报告只存脱敏摘要和 recordId 引用 |
| P1 | 把优化建议连接到“改进记录” | 将问题、候选动作、验收标准、复测样本绑定，形成闭环 | 中 | 被误用成自动修改 | 保持只读/复制，不自动执行；复测报告需用户显式关联 |
| P2 | 增加过程指标分位数与有效样本分母 | 更接近内部报告的 P50/P90、有效评分次数、样本范围读法 | 低到中 | 分母解释不足时误导用户 | UI 强制展示分母、N/A、有效样本数和口径说明 |

### 5.2 最小可行数据模型草案

可先在前端/本地服务中增加一层只读评测配置与结果结构，不急于做云端工作台：

```ts
interface ScoringRubric {
  id: string
  title: string
  version: number
  skillSet: string[]
  triggerMode: 'any' | 'all'
  sections: RubricSection[]
  createdAt: number
}

interface RubricSection {
  name: string
  applicableIf?: string
  checks: RubricCheck[]
}

interface RubricCheck {
  name: string
  criticality: 'required' | 'conditional'
  verify: {
    method: 'judge'
    passIf: string
    evidenceHint?: string
  }
}

interface EvaluationRun {
  id: string
  rubricId: string
  rubricVersion: number
  source: SourceId
  sessionIds: string[]
  model?: string
  createdAt: number
}

interface CheckResult {
  sessionId: string
  sectionName: string
  checkName: string
  status: 'pass' | 'fail' | 'na' | 'unknown'
  rationale: string
  evidenceRecordIds: string[]
}
```

这套结构与当前项目的 `TrajectoryRecord.id`、`SourceId`、AI fact package、OptimizationSuggestion 都能对上，不需要先重做轨迹投影层。

### 5.3 可复用现有模块的实现路径

1. **取证层复用现有 projection**：评分器 judge 输入只用 `TrajectoryAnalysis.steps`、`corrections`、`evaluations`、`optimizations` 和有限 record 详情，不直接塞完整原始轨迹。
2. **模型调用复用 SummaryEngine**：沿用“脱敏事实包 → 模型 draft → 校验 ID → 可选读取补充 evidence → 再校验”的模式，避免 judge 引用不存在证据。
3. **报告层复用 TrajectorySummary/OptimizationPanel 交互**：每个检查项都必须能定位 record；N/A 与 unknown 单独展示。
4. **诊断层复用 frozen snapshot 思路**：批量评测 run 应绑定 session fingerprint 或 revision，避免源会话变化后结果漂移。
5. **安全边界沿用 README 的本地只读原则**：报告只建议，不自动修改 Skill、代码、Hook 或环境。

## 6. 不建议照搬项

| 不建议照搬 | 原因 | 更适合 Agent Trajectory 的做法 |
|-|-|-|
| 直接接入云端业务空间/线上会话选择 | 本项目定位是 local-first、read-only，多来源本地轨迹查看器；直接接入外部业务空间会扩大权限与隐私边界 | 先做本地 session 手动选择和导入式批量 run |
| 一键优化直接修改 Skill/知识 | 当前项目明确优化建议只展示/复制，不自动改代码或环境；自动修改会越过用户审阅 | 保持“建议—复制—人工采用—新轨迹复测” |
| 用一个总分替代多维证据 | 当前 UI 已明确不合成虚假精确总分；Agent 任务缺业务真值时总分尤其容易误导 | 展示 check pass/fail/N/A、分母、证据和判断限制 |
| 把文档中的 data-dev 字段规则硬编码 | 该案例是业务教学样例，不是通用 Agent 评测标准 | 抽象成可配置 YAML 示例，不进入默认规则 |
| 把工具成功率当作业务正确性 | 内部文档也强调工具成功不证明业务结果正确 | 继续区分工具返回、验证证据和业务真值 |
| 批量趋势不记录版本口径 | 评分器、评测模型、样本构成变化会导致趋势不可比 | 每个 EvaluationRun 固化 rubric version、model、session set、fingerprint |

## 7. 证据清单

### 7.1 飞书 Docx 证据

- `lark-cli docs +fetch --as user --doc <目标URL> --scope outline --detail with-ids` 返回 `ok: true`、`identity: user`，文档 `revision_id=33`。
- 完整 Markdown 读取成功，标题为“Aide Solo 观测与评测：从业务问题到 Skill 持续改进”。
- outline 覆盖：基础功能、BP 案例、与 Solo 讨论会话、生成 Skill Stage 评分规则、产品中输入 YAML、圈选会话运行专项分析、读报告、转成 Skill/知识建设动作、常见卡点。
- XML 结构检查未发现需要下钻的表格/Base/会议纪要引用；文档中存在 whiteboard 和图片素材，但本调研只需要文字流程与指标定义，未下载素材。

### 7.2 本地项目证据

| 证据 | 说明 |
|-|-|
| `README.md:3-18` | Agent Trajectory 是本地只读、多来源轨迹查看器，并说明不读取凭据 |
| `README.md:120-150` | 本地轨迹诊断、冻结快照、只读证据命令与四段报告 |
| `README.md:221-230` | 默认轨迹评测、证据定位、优化建议展示但不自动修改 |
| `src/types.ts:148-197` | `TrajectoryRecord` 统一记录模型 |
| `src/types.ts:223-260` | task state、relations、coverage 等投影结构 |
| `src/trajectory-analysis.ts:62-105` | `TrajectoryAnalysis` 的评测维度、统计、步骤、纠错、优化建议 |
| `src/trajectory-analysis.ts:940-1075` | 五维评测生成逻辑 |
| `src/trajectory-story.ts:18-38` | 故事线阶段数据结构 |
| `src/trajectory-story.ts:374-390` | 将分析步骤压缩为最多若干阶段并建立 step→stage 映射 |
| `src/trajectory-optimization.ts:24-43` | 优化建议结构，包含证据、改法、验证与限制 |
| `src/components/TrajectorySummary.tsx:570-588` | UI 明确过程评测不合成虚假总分 |
| `src/components/OptimizationPanel.tsx:103-167` | 优化建议面板展示原因、措施、实施位置、预期改善、验证方式、判断限制 |
| `server/summary/engine.ts:71-90` | AI 增强提示词要求本地事实、数字、ID 和证据关系权威 |
| `server/summary/engine.ts:166-245` | AI draft 校验，过滤非法证据 ID 和缺失模块 |
| `server/summary/engine.ts:483-510` | 二阶段按需读取、脱敏并限制证据 |
| `server/diagnosis/service.ts:90-152` | 诊断前冻结目标 session，并只向诊断会话传 snapshot/evidence 命令 |
| `skills/trajectory-diagnosis/SKILL.md:10-28` | 诊断 Skill 的只读证据循环 |
| `tests/trajectory-analysis.test.ts:80-140`、`tests/trajectory-analysis.test.ts:704-729` | 本地评测对恢复故事、Token 覆盖等行为已有测试 |
| `tests/trajectory-optimization.test.ts:42-104`、`tests/trajectory-optimization.test.ts:238-268` | 本地优化建议避免把验证、轮询、缺数据等误判为浪费 |
| `tests/summary-engine.test.ts:363-409` | AI 增强只读取请求且合法的证据，并避免泄漏私有值 |

## 8. 结论

内部实践对 Agent Trajectory 最有价值的启发，是把当前“单会话过程评测 + 优化建议”推进到“可配置、可批量、可版本化、可复测”的评测闭环。

建议下一步不要先做完整工作台，而是从最小闭环开始：

1. 定义 `ScoringRubric` / `EvaluationRun` / `CheckResult`。
2. 支持一个最小 Skill Stage YAML 子集：`title`、`skill_set`、`trigger_mode`、`sections`、`applicable_if`、`checks`、`pass_if`。
3. 复用 SummaryEngine 的事实包与证据校验机制做受限 judge。
4. 先对手动选择的少量本地 session 生成报告，展示 pass/fail/N/A、证据 recordId、分母和判断限制。
5. 再考虑版本对比、周期报告和改进记录。

这样既能吸收内部实践的核心方法，又能保持 Agent Trajectory 的本地只读、安全边界和“证据不足不强判”的产品原则。
