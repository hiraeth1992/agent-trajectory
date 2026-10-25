# 第 11 路调研：短剧机评能力地图与 Agent Trajectory 对比

调研对象：<https://bytedance.larkoffice.com/wiki/QrJ9wQhpNiZ5jIkGs9BcaDiun3g>
调研时间：2026-10-24
执行边界：按要求只读解析 Wiki 节点、以 `--as user` 只读 fetch 正文；未编辑飞书内容，未下钻读取嵌入页中列出的其他飞书外链。本文只新增本地报告，不复制大段内部正文。

## 1. 来源元信息与访问状态

### 1.1 Wiki / Docx 访问

- `lark-cli auth status --json --verify` 显示 user 身份可用、token valid，并具备 wiki/docx 读取相关 scope。
- `lark-cli wiki +node-get --as user --node-token <目标 Wiki URL>` 成功：
  - 标题：`短剧机评建设能力地图（持续更新）`
  - Wiki node token：`QrJ9wQhpNiZ5jIkGs9BcaDiun3g`
  - 对象类型：`docx`
  - 对象 token：`YVNR...yZb`（报告中脱敏展示）
  - `has_child=false`
  - `updated_at=2026-08-12T07:17:31Z`
- `lark-cli docs +fetch --as user --doc <目标 Wiki URL> --scope outline --max-depth 4 --detail with-ids` 成功，但 outline 为空。
- `lark-cli docs +fetch --as user --doc <目标 Wiki URL> --doc-format markdown --detail simple` 成功；正文只包含标题和一个 `readonly-block` iframe。
- `lark-cli docs +fetch --as user --doc <目标 Wiki URL> --doc-format xml --detail full` 成功；full XML 也只包含：
  - 标题 block；
  - 一个 `readonly-block`，`href=https://cxelqk.gf-preview.bytedance.net/index.html`，`type=iframe`；
  - 两个空段落。

### 1.2 嵌入页访问

Wiki 正文的唯一实质内容入口是上述 iframe。对该 iframe URL 只读检查：

- `curl -I` 返回 HTTP 200，`Content-Type: text/html; charset=utf-8`。
- HTML 标题为 `Short Drama Eval Capability Map`。
- 页面可见标题为“短剧机评能力建设地图”，副标题是“从评测对象到发布门禁与问题回写；点击能力项查看现状、缺口和验收口径”。
- 结构化抽取到 43 个能力/路线按钮，状态统计为：
  - `ready`：8
  - `partial`：11
  - `missing`：12
  - `other`：12（主要为路线/职责/控制项）
- 嵌入页中出现 3 个飞书链接（如“AI 短剧评测方案”“重制剧机评建设规划”等），本轮未下钻读取；本文只把它们作为“嵌入页存在外链”的元信息，不引用其正文内容。

访问结论：目标 Wiki 节点和 Docx 正文可读；普通正文几乎为空，核心内容实际存放在 Wiki 内嵌 iframe。本文对内部实践的分析主要来自该 Wiki 嵌入页的可见结构化内容，而不是外链文档。

## 2. 核心实践总结

该能力地图不是单点指标说明，而是一套“机评能力建设地图”。它把评测拆成对象、样本、真实 Target、评估器、校准、门禁和回写几层，并按能力成熟度标注“已具备 / 需补强 / 待建设 / P0/P1”。

可归纳为七个核心实践：

1. 以闭环流程组织机评能力
   - 流程主线是：评测对象 → Gold/样本 → 真实 Target → 规则 + LLM/多模态 → 实验与校准 → 门禁决策 → 人评/回写。
   - 这避免只做一次性评测报告，而是把“样本、运行、判分、可信度、发布门禁、问题回流”连成工程流程。

2. 先定义“评什么”，再定义“怎么跑”和“怎么判”
   - 每个专项都拆出评测目标、评测维度、数据标尺、运行链路、判分能力、可信度与下一步。
   - 已建设能力和缺口都被放在同一张地图上，便于区分“功能已跑通”和“可以作为门禁使用”。

3. 使用固定 Gold / pinned Target 保证可复跑
   - 提示词专项已有固定 Gold 和评测标尺。
   - 视频专项有 pinned 视频候选，并记录候选、视频 hash、Prompt hash 等可追溯信息。
   - 重制剧专项规划固定人工校准集、原片事实和 Agent 各阶段产物。

4. 可信度不是靠模型自信，而是靠人机一致性校准
   - 反复出现的校准指标包括 exact/adjacent agreement、Kappa、FP/FN、关键错误召回、误报率、低置信转人工比例、人机分歧率。
   - 这些指标用于判断机评结果是否可以进入门禁，而不是只看模型输出是否“像样”。

5. 强调证据定位和根因归属
   - 视频专项要求问题带时间点证据，并区分提示词/Agent 规划问题与视频模型生成问题。
   - 重制剧专项强调从原片事实到 Agent 产物再到成片的事件对齐链路，用来定位错误阶段。

6. 主观维度保留人评主导
   - 重制剧的表演、节奏、审美、改编效果等被归为低可行维度；机器只做辅助提示，不能单独决定发布。
   - 这体现了“机评可门禁”和“机评可辅助”的边界管理。

7. 以路线图和责任线推进
   - 页面列出 P0/P1 路线，例如通用人机一致性、视频运行合同、四个必做维度、GSB、重制剧 MVP 等。
   - 能力地图同时承担“现状盘点 + 建设 backlog + 验收口径”的作用。

## 3. 流程、指标、数据模型和案例

### 3.1 流程模型

来源中的主流程可以抽象为：

```text
评测对象
  -> Gold / 样本
  -> 真实 Target
  -> 规则 + LLM / 多模态评估器
  -> 实验与校准
  -> 门禁决策
  -> 人评 / 问题回写
```

这里的关键不是“使用 LLM 判分”，而是：

- Gold 与 Target 分离：Gold 是标准答案和标尺，Target 是真实项目候选或产物。
- 先 smoke，再全量：提示词专项提到先跑小样本 smoke 再跑全量。
- 校准后门禁：只有经过人工 Gold 校准的高置信规则才适合作为发布门禁。
- 问题回写：评测结果要能定位到上游阶段和具体问题，支撑修复。

### 3.2 指标体系

来源中的指标可分为四类：

| 指标类别 | 示例 | 目的 |
| --- | --- | --- |
| 一致性 | exact agreement、adjacent agreement、Kappa | 判断机器结论与人工标准是否一致 |
| 错误质量 | FP/FN、关键错误召回、误报率、漏检率 | 判断机评是否能发现真正重要的问题 |
| 稳定性 | 同样本重复运行稳定性、A/B 交换顺序后结论反转 | 排除随机性和位置偏置 |
| 成本与协同 | 低置信转人工比例、单集成本、人机分歧率 | 决定是否能进入生产门禁或人机协作队列 |

### 3.3 数据模型

来源中隐含的数据对象包括：

- `Gold`：人工标准答案、固定评测标尺、分层字段。
- `Target`：真实项目中的候选产物，例如 Agent 分镜/资产 Prompt、pinned 视频、重制剧各阶段产物。
- `Candidate identity`：候选 ID、视频 hash、Prompt hash 等可追溯标识。
- `Evidence`：时间点、关键帧、分项报告、维度证据、原片事实与产物对齐链路。
- `Dimension score`：分维度 1–3 分、严重问题标签、胜/平/负等。
- `Calibration result`：一致率、Kappa、FP/FN、重复稳定性、低置信转人工比例。
- `Gate decision`：可门禁、需人评、仅辅助、待建设。

### 3.4 三个案例/专项

#### 案例 A：分镜 / 资产提示词评测

目标是检查“生成前的文字方案”是否忠实、完整、可执行。已具备或接近具备的内容包括：

- 评测对象：台词、资产映射、结构、动作、集级拆并。
- 数据标尺：固定 Gold 与评测标尺已完成。
- 运行链路：从真实项目 Target 读取 Agent 分镜和资产 Prompt，经规则/LLM 输出分项报告。
- 缺口：抽样盲评和人机一致率计算，即用代表性样本计算 exact/adjacent agreement、Kappa、FP/FN。

#### 案例 B：视频评测

目标是检查最终生成画面是否完成分镜要求，并支持单视频查错和两版视频 GSB 比较。能力地图中标出的重点包括：

- 必做维度：画面元素、动作与事件、物理空间、台词准确性。
- 扩展维度：音画/字幕、跨镜一致性。
- 数据标尺：已有 pinned 视频候选，可追到同一候选；记录候选、视频 hash、Prompt hash 等。
- 运行缺口：媒体合同仍有失败项，需固化媒体缓存与快照。
- 判分缺口：绝对分已有基础，但需补分维度协议和 GSB 判分协议。
- 可信度缺口：重复一致性与盲评校准尚未完成。

#### 案例 C：重制剧评测

目标是从原片到重制成片检查“还原度”，并定位错误阶段。能力地图将维度按可行性分层：

- 高可行维度：资产、台词、核心事件、顺序、重复镜头。
- 中可行维度：动作、角色/变装、回忆、分镜拆并。
- 低可行维度：表演、节奏、审美、改编效果，明确人评主导。
- 数据标尺：固定人工校准集 + 原片事实 + Agent 各阶段产物。
- 技术链路缺口：原片事实与 Agent 产物的事件对齐链路尚未搭建。
- 路线：MVP 先做高可行维度，第二阶段接入视频与根因定位，第三阶段做整集体验与人机协同门禁。

## 4. 与当前 Agent Trajectory 的映射

### 4.1 当前项目已有的对应能力

| 来源实践 | Agent Trajectory 现状 | 本地证据 |
| --- | --- | --- |
| 多来源真实 Target | 项目定位为本地只读多来源轨迹查看器，读取 DSH、Codex、ZCode 三类事实源 | `README.md:1-18` |
| 统一投影数据模型 | `TrajectoryRecord` 保留 `source/sourceEventIds/fidelity`、时间、状态、调用、usage、trace/span、policy 等字段 | `src/types.ts:148-197` |
| 关系与覆盖 | `TrajectoryProjection` 包含 records、turns、relations、coverage、taskState、usage | `src/types.ts:245-266` |
| 本地确定性评测 | `analyzeTrajectory` 聚合步骤、纠错、结果、统计、五维过程评测和优化建议 | `src/trajectory-analysis.ts:1077-1100` |
| 评测维度 | 当前已有 outcome、reliability、recovery、efficiency、observability 五类评测 | `src/trajectory-analysis.ts:940-1075` |
| 成本/Token 口径 | 统计 duration、turns、steps、errors、retries、Token 分配覆盖率等 | `src/trajectory-analysis.ts:747-790` |
| 可执行优化建议 | 本地规则发现重复读取、原样重试、环境错误、验证缺口等，并给出 evidence | `src/trajectory-optimization.ts:373-566` |
| AI 增强事实包 | `SummaryFactPackage` 把本地事实、目标、结果、步骤、纠错、故事线、评测、优化传给模型 | `src/trajectory-facts.ts:19-73`、`src/ai-summary-types.ts:111-126` |
| 冻结证据 Target | 诊断服务在 source fingerprint 稳定时冻结快照，快照包含脱敏 detail 与 analysis | `server/diagnosis/service.ts:90-141`、`server/diagnosis/evidence-store.ts:83-107` |
| 只读证据查询 | 诊断 evidence query 提供 overview/findings/records/record，单记录输入输出默认限 64 KiB | `server/diagnosis/evidence-query.ts:79-147` |
| 报告约束 | `trajectory-diagnosis` Skill 要求四段报告，按证据读取，不读 live session，不编造隐藏思维链 | `skills/trajectory-diagnosis/SKILL.md:8-36`、`skills/trajectory-diagnosis/SKILL.md:54-81` |
| 审计导出 | 项目提供投影导出和完整脱敏审计导出 | `README.md:294-300` |
| 验证覆盖 | README 描述测试覆盖三来源 fixture、surface replacement、coverage、lineage、诊断证据等 | `README.md:362-369` |

### 4.2 主要差距

1. 缺少“能力地图”层
   - 当前 Agent Trajectory 已有单会话评测与诊断能力，但缺少一张面向评测系统自身的能力地图：每个评测能力是否已具备、是否只可辅助、是否可门禁、缺什么 Gold/Target/校准。

2. 缺少显式 Gold / 人工标签体系
   - 当前测试覆盖 fixture 和投影正确性，但没有看到针对“轨迹评测结论”的人工 Gold 标签，例如某会话最终结果应判为“验证不足”、某段应归因为“环境错误”、某条优化建议是否为 FP/FN。

3. 可信度指标还偏工程自检，少了人机一致性指标
   - 当前五维评测提供 deterministic confidence，但没有 exact/adjacent agreement、Kappa、FP/FN 等校准指标。

4. Target 冻结已有雏形，但还没有发展为 benchmark runner
   - 诊断快照已能冻结证据并限制读取，但更多服务于单次诊断；还可以扩展为固定评测集的重复评估、版本对比和回归门禁。

5. 根因归属还可更显式
   - 当前优化分类覆盖 duplicate/retry/environment/verification 等，但来源实践强调“上游规划问题 vs 生成模型问题 vs 评估链路问题”的归因。对 Agent Trajectory 来说，可对应为 Agent 策略、工具/环境、来源可观测性、用户改道、模型输出质量、项目约束不清等。

## 5. 候选优化

| 候选优化 | 价值 | 成本 | 风险 | 验证方式 |
| --- | --- | --- | --- | --- |
| 建立 Agent Trajectory 自身的评测能力地图 | 把 outcome/reliability/recovery/efficiency/observability、AI 增强、诊断、审计导出等能力的成熟度、缺口和门禁边界可视化；减少只看单会话效果的盲区 | M | 状态手工维护后容易过期 | 用代码/测试派生状态：每个能力项绑定至少一个测试、fixture 或文档证据；CI 中检查能力地图引用的证据仍存在 |
| 建立轨迹评测 Gold 集 | 用人工标注的冻结会话校准“结果判断、异常恢复、优化建议、根因归属”；把当前 deterministic 规则从“看起来合理”推进到“可度量可靠” | M-H | 真实轨迹有隐私风险，人工标签有主观性 | 使用脱敏冻结快照；每条 Gold 记录期望 outcome/evaluation/optimization；统计 exact/adjacent agreement、Kappa、FP/FN |
| 把诊断快照扩展为 benchmark Target 合同 | 复用现有 `DiagnosisEvidenceStore` 的 fingerprint/detail/analysis 快照能力，增加 benchmark ID、期望标签、facts hash、评测版本 | M | 快照体积和 schema 演进成本；不能泄露原始会话 | 同一 snapshot 多次运行输出稳定；source fingerprint 不变时结果 hash 可复核；schema 升级有迁移测试 |
| 增加根因归属 taxonomy | 将优化建议和纠错链归因到 Agent 策略、工具/环境、来源数据缺失、用户改道、模型输出、项目约束等，方便回写到规则、代码或文档 | M | 过度归因会制造错误责任判断 | Gold 集中标注 root cause；低置信时必须输出 `unknown/needs-evidence`；统计归因准确率和误归因样例 |
| 为 AI 增强增加稳定性/偏置评估 | 对 AI 生成的 outcome/story/evaluation/optimization 做重复运行稳定性检查，避免模型波动影响用户信任 | M | 增加 Token 成本；不同模型自然存在表述差异 | 固定 facts hash，同模型重复运行，比较结构化字段一致率；对比较类 prompt 做 A/B 顺序交换测试 |
| 增加“可门禁 / 需人工 / 仅辅助”结论层 | 借鉴来源中“机器不能替代审美判断”的边界，把轨迹评测结论区分为可自动判定、需人工复核、只能提示风险 | L-M | 用户可能误以为低置信结论无价值 | 在 UI 和报告中展示 gate level；测试缺少验证、缺少可观测性、来源不支持 trace 等场景是否降级 |

## 6. 不建议照搬项

1. 不建议照搬短剧媒体维度
   - VLM、ASR、lip-sync、OCR、音画同步、跨镜角色一致性等是视频生产领域能力，不应直接变成 Agent Trajectory 指标。
   - 可借鉴的是“维度拆解 + 证据定位 + 人机校准”，不是这些媒体维度本身。

2. 不建议把固定样本数量照搬为目标
   - 来源中的 39 条 pinned 视频、10–20 集人工校准集属于短剧场景的阶段性样本设计。
   - Agent Trajectory 应按来源类型、任务类型、风险类型分层抽样，例如 DSH/Codex/ZCode、成功/失败/中断、工具密集/模型密集、含父子会话/不含父子会话。

3. 不建议把 Kappa 或一致率变成所有功能上线前的硬门槛
   - 对投影、脱敏、导出等工程功能，单元测试/fixture/性质测试更直接。
   - Kappa/FP/FN 更适合评估“模型化或规则化判断”的正确性，例如结果判定、根因归属、优化建议。

4. 不建议用 iframe 可视页作为长期知识源形态
   - 本次 Wiki 正文只暴露 iframe，普通 Docx outline 为空；对长期研究和审计并不友好。
   - 如果 Agent Trajectory 后续建设能力地图，建议将能力项同时保存在可 diff 的 Markdown/JSON/YAML 中，再渲染为页面。

5. 不建议让机评单独决定主观价值判断
   - 来源明确把审美、节奏、表演等低可行维度交给人评主导。
   - Agent Trajectory 中类似“是否走了最优路径”“建议是否业务上值得做”也可能需要人工确认；系统应输出证据和候选建议，而不是伪装成绝对裁判。

## 7. 证据清单

### 7.1 飞书 / Wiki 证据

- 认证：`lark-cli auth status --json --verify`，user 身份可用，读取 scope 充足。
- Wiki 节点解析：`lark-cli wiki +node-get --as user --node-token <目标 Wiki URL>`，返回 docx 节点、标题、更新时间、无子节点。
- 正文 outline：`lark-cli docs +fetch --as user --doc <目标 Wiki URL> --scope outline --max-depth 4 --detail with-ids`，返回空 outline。
- 正文 simple markdown：`lark-cli docs +fetch --as user --doc <目标 Wiki URL> --doc-format markdown --detail simple`，返回标题 + `readonly-block` iframe。
- 正文 full XML：`lark-cli docs +fetch --as user --doc <目标 Wiki URL> --doc-format xml --detail full`，确认只有标题、iframe block 和空段落。
- iframe 访问：`curl -I https://cxelqk.gf-preview.bytedance.net/index.html` 返回 200。
- iframe 结构化抽取：
  - 页面标题：`Short Drama Eval Capability Map`
  - 可见标题：`短剧机评能力建设地图`
  - 主流程：评测对象 → Gold/样本 → 真实 Target → 规则 + LLM/多模态 → 实验与校准 → 门禁决策 → 人评/回写
  - 能力按钮数：43
  - 状态统计：ready 8、partial 11、missing 12、other 12
  - 三个专项：提示词专项、视频专项、重制剧专项

### 7.2 本地项目证据

- 项目定位与三来源事实源：`README.md:1-18`
- 本地轨迹诊断与只读冻结证据说明：`README.md:120-153`
- 已实现的轨迹评测、优化建议、故事线、诊断入口：`README.md:221-255`
- 投影/审计导出：`README.md:294-300`
- 安全边界：`README.md:315-326`
- 验证覆盖：`README.md:328-369`
- 核心记录模型：`src/types.ts:148-197`
- 投影模型：`src/types.ts:245-266`
- 轨迹分析接口与评测类型：`src/trajectory-analysis.ts:62-105`
- 统计口径：`src/trajectory-analysis.ts:747-790`
- 结果判断：`src/trajectory-analysis.ts:793-938`
- 五维过程评测：`src/trajectory-analysis.ts:940-1075`
- 分析总入口：`src/trajectory-analysis.ts:1077-1100`
- 优化建议规则：`src/trajectory-optimization.ts:373-566`
- AI 增强事实包：`src/trajectory-facts.ts:19-73`、`src/ai-summary-types.ts:111-126`
- 诊断快照冻结：`server/diagnosis/service.ts:90-141`、`server/diagnosis/evidence-store.ts:83-107`
- 诊断证据查询：`server/diagnosis/evidence-query.ts:79-147`
- 诊断 Skill 方法与报告契约：`skills/trajectory-diagnosis/SKILL.md:8-36`、`skills/trajectory-diagnosis/SKILL.md:54-81`

## 8. 结论

这份内部实践对 Agent Trajectory 最有价值的启发，不是“短剧评测指标”本身，而是它的工程化组织方式：先把评测能力做成地图，再用固定 Gold/Target、可复跑合同、人机一致性、误报漏报、稳定性和门禁边界来判断能力是否可信。

Agent Trajectory 当前已经具备很好的事实采集、统一投影、单会话评测、证据冻结和只读诊断基础。下一阶段如果要提升“评测自身的可信度”，优先应补的是：能力地图、Gold benchmark、人机校准指标、根因归属 taxonomy，以及面向 AI 增强的稳定性评估。
