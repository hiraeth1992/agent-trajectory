# Agent Trajectory

Agent Trajectory 是一个本地优先、只读的多来源 Agent 轨迹查看器。它将
DeepSeek Harness、Codex 和 ZCode 的本地会话转换为统一视图，帮助你查看对话、
模型上下文、工具调用、Token 消耗、执行过程和评测结果。

项目以本地 Node.js 服务运行，通过系统浏览器展示数据。它不携带 Chromium，
普通浏览不会上传或修改来源会话；可选 AI 增强只有在用户主动触发时才会调用所选模型。

## 核心功能

- **统一查看多种 Agent**：使用相同界面浏览 DSH、Codex 和 ZCode 会话。
- **还原执行过程**：按轮次和步骤查看消息、推理片段、工具调用、错误、重试和耗时。
- **分析资源消耗**：汇总 Token、缓存读取、TTFT、模型耗时和工具耗时。
- **解释上下文变化**：区分用户看到的对话、模型当前上下文和完整审计轨迹。
- **评测轨迹质量**：检查目标完成、要求承接、错误恢复和验证缺口，并定位原始证据。
- **本地诊断与校准**：生成脱敏冻结快照，支持 Agent 诊断、人工双标、裁决和回归评测。
- **可选 AI 增强**：使用 Codex 当前配置或自定义 OpenAI-compatible 模型优化语义表达。
- **保护本地数据**：来源只读、服务仅监听本机、敏感字段递归脱敏。

## 支持的数据来源

| 来源               | 默认事实源                                              | 主要能力                                    |
| ---------------- | -------------------------------------------------- | --------------------------------------- |
| DeepSeek Harness | `~/.dsh/sessions/**/session.vN.jsonl[.zst\|.zstd]` | v4 会话、模型上下文、Goal/Todo、谱系、工具与用量          |
| Codex            | `~/.codex/sessions/**/rollout-*.jsonl`             | 消息、推理、工具调用、完成状态与 Token 用量               |
| ZCode            | `~/.zcode/cli/db/db.sqlite`                        | 消息、工具、模型与轮次用量，以及可选 trace/policy/task 能力 |

来源缺少可选字段时，界面会明确标记能力降级，不会推测不存在的事实。

## 架构

```text
DSH JSONL/Zstd ---> DshSource -----+
Codex JSONL ------> CodexSource ---+--> 投影 Worker --> SourceRegistry
ZCode SQLite -----> SQLite Worker -+                         |
                                                             v
                                                    本地 API + SSE
                                                             |
                                                             v
                                                    React Web 界面
```

架构分为四层：

1. **来源适配层**读取三种本地格式。DSH 和 Codex 支持安全增量读取；ZCode 通过只读
   SQLite Worker 查询，避免阻塞服务主线程。
2. **统一投影层**将来源事件转换为共同的会话、轮次、步骤、记录、用量和关系模型，
   同时保留来源 ID 和保真度，便于回到原始证据。
3. **服务层**通过仅绑定 `127.0.0.1` 的 Node.js API 提供会话列表、详情、导出和
   SSE 更新；缓存与 Worker 均有容量边界。
4. **展示层**在浏览器中提供对话、模型上下文、轨迹、检查器、过程评测和评测中心。

不同来源的解析逻辑彼此隔离。一个来源不可用时，不会阻断其他来源；无法验证的结构和
关联会安全失败，而不是被包装成统一事实。可选 AI 增强作为独立支路工作，只能改进语义
描述，不能覆盖本地事实、数值、状态或证据关系。

## 快速开始

### 环境要求

- Node.js 22.12 或更高版本

### 启动

```bash
npx agent-trajectory
```

命令会启动本地服务并打开系统默认浏览器。服务使用随机的 `127.0.0.1` 端口；
关闭前台进程会同步关闭服务和 Worker。

只启动服务、不打开浏览器：

```bash
npx agent-trajectory start --no-open
```

### 检查数据来源

```bash
npx agent-trajectory doctor
```

`doctor` 会显示各来源的路径、可用状态、会话数量，以及 Hook 是否需要刷新。

如果 Agent 数据不在默认位置，可以交互式保存配置：

```bash
npx agent-trajectory setup
```

也可以直接指定路径：

```bash
npx agent-trajectory setup \
  --dsh-dir /path/to/dsh/sessions \
  --codex-home /path/to/.codex \
  --codex-sessions-dir /path/to/codex/sessions \
  --zcode-db /path/to/zcode/db.sqlite
```

来源路径的优先级为：

```text
CLI 参数 → ~/.agent-trajectory/config-v1.json → 环境变量 → 默认目录
```

配置文件支持 `${HOME}` 和 `${CONFIG_DIR}`，便于迁移到不同用户或电脑。

## 使用说明

### 会话分析

启动后，在“会话分析”中选择来源和会话。页面提供以下视图：

- **对话**：聚焦用户与助手正文，按轮次折叠运行上下文、推理和工具。
- **模型上下文**：在来源提供 replacement 事实时，显示模型下一次请求实际看到的内容。
- **轨迹**：展示完整审计记录、步骤关系、工具输入输出、状态、耗时和 Token。
- **轨迹评测**：以故事线、执行结论、纠错链和过程指标解释任务如何推进。
- **检查器**：查看单条记录的来源、关联、trace/span、错误及脱敏后的原始事件。

搜索、证据定位和检查器在各视图间共享。当前会话落盘后，页面通常会在约 1–2 秒内更新。

### 本地 Agent 诊断

“轨迹评测”中的本地分析始终自动运行，不调用模型。需要进一步诊断时，可以点击
“本地 Agent 诊断”：

1. 服务在本机创建私有、脱敏的冻结快照；
2. 页面生成并复制一个轻量诊断 Prompt；
3. 你在可访问本机文件的新 Agent 会话中粘贴执行；
4. 内置 `trajectory-diagnosis` Skill 按需读取证据并生成报告。

该入口不会自动创建 Agent 会话、发送消息或读取 Agent 凭证。报告只总结可观察到的判断、
行动和反馈，不展示或编造隐藏思维链。

### 可选 AI 增强

轨迹评测默认使用本地确定性分析，不调用模型。你也可以主动运行“AI 增强”，让模型优化
目标、结果、故事线、评测和建议的中文表达：

- 可以复用 Codex 当前配置，或添加自定义 OpenAI-compatible HTTPS/本地端点；
- 运行前可在“将发送的信息”中查看脱敏事实包和预估输入 Token；
- 只发送所选模块需要的事实，模型申请补充证据时还会再次脱敏并限制大小；
- 模型响应必须通过本地结构和事实校验，不能修改数值、状态和证据 ID；
- API Key 可来自环境变量，也可以加密保存在本机数据目录。

如果使用远程模型端点，预览中的脱敏事实会发送给该服务商。是否使用、发送范围和模型选择
均由用户显式决定；不运行 AI 增强时，本地分析不会产生模型请求。

### 评测中心

“评测中心”用于跨会话质量评估，包含数据集、Reviewer 双标、分歧裁决、
EvaluationRun、baseline 对比和 badcase 管理。内置脱敏合成数据集可直接运行：

```bash
npx agent-trajectory evaluate
```

报告默认写入 `~/.agent-trajectory/evaluations/`，也可以指定目录或 baseline：

```bash
npx agent-trajectory evaluate --output-dir ./evaluation-reports
npx agent-trajectory evaluate --baseline ./evaluation-reports/baseline.json
```

需要用本机真实轨迹校准时，使用三阶段流程：

```bash
# 1. 冻结并脱敏候选
npx agent-trajectory calibrate prepare \
  --dataset ~/.agent-trajectory/calibration/real-v1 \
  --count 30

# 2. 两位 Reviewer 完成模板后，生成一致性报告和裁决模板
npx agent-trajectory calibrate agreement \
  --dataset ~/.agent-trajectory/calibration/real-v1 \
  --reviewer-a ~/.agent-trajectory/calibration/real-v1/reviewer-a.json \
  --reviewer-b ~/.agent-trajectory/calibration/real-v1/reviewer-b.json

# 3. 独立裁决完成后运行指定 split
npx agent-trajectory evaluate \
  --dataset ~/.agent-trajectory/calibration/real-v1 \
  --adjudication ~/.agent-trajectory/calibration/real-v1/adjudication.json \
  --split regression
```

真实候选可能包含完成评测所必需的业务文本，只应保留在本机私有目录，不要提交或上传。
`independent` split 仅用于最终验收，避免根据独立测试结果反向调整规则。

### 新会话自动联动

安装 Hook 后，新建顶层 DSH、Codex 或 ZCode 会话时，Agent Trajectory 会自动打开或复用
页面并切换到对应会话：

```bash
npx agent-trajectory install-hooks
```

安装后需要重启 DSH 和 ZCode；Codex 需要通过 `/hooks` 检查并信任新增 Hook。
Node 路径、系统、数据目录或版本变化后，重新运行 `install-hooks` 即可刷新。

移除本项目安装的联动项：

```bash
npx agent-trajectory uninstall-hooks
```

Hook 安装与卸载是唯一会修改 Agent 配置的功能。修改使用项目标记和文件事务，
任一步失败都会恢复原内容；Hook 失败也不会阻断 Agent 会话。

## 常用命令

| 命令                                       | 用途            |
| ---------------------------------------- | ------------- |
| `agent-trajectory`                       | 启动或复用实例并打开页面  |
| `agent-trajectory start --no-open`       | 只启动本地服务       |
| `agent-trajectory doctor`                | 检查来源和 Hook 状态 |
| `agent-trajectory setup`                 | 保存自定义来源路径     |
| `agent-trajectory install-hooks`         | 安装新会话联动       |
| `agent-trajectory uninstall-hooks`       | 移除本项目的联动项     |
| `agent-trajectory evaluate`              | 运行内置评测并生成报告   |
| `agent-trajectory casebook list`         | 查看本地 badcase  |
| `agent-trajectory calibrate prepare ...` | 准备真实轨迹校准数据集   |

所有命令都可使用 `--data-dir <路径>` 指定 Agent Trajectory 的本地数据目录。

### 离线或内网分发

```bash
npm run pack:tgz
npx --yes ./agent-trajectory-0.1.0.tgz
```

发行物只包含 Node.js 服务、React 静态页面、Worker 和内置 Zstandard 解码器。

## 导出

- **投影导出**：导出浏览器当前加载的统一会话视图，适合查看和二次处理。
- **审计导出**：导出完整、已脱敏的投影和来源事件，包括未形成展示记录的事件。

详情接口默认只返回脱敏预览；超长输入输出会明确标记截断，原始事件按需加载。

## 安全与隐私

- 服务只绑定 `127.0.0.1`，并校验 Host、端口和远端地址。
- 客户端只能提交来源和 opaque session ID，不能提交任意本地路径。
- DSH 和 Codex 只扫描预设目录中的白名单文件；ZCode 数据库以只读模式打开。
- 不读取凭证、证书、Cookie、浏览器存储或模型请求头。
- 工具输入输出、原始事件和导出内容中的敏感键会递归脱敏。
- 普通浏览、投影、诊断和评测不会修改来源会话或执行 Agent 工具。
- 可选 AI 增强仅在用户触发后发送界面可预览的脱敏事实；远程端点受对应服务商策略约束。
- 诊断快照、校准数据、评测报告和 badcase 均保存在本机数据目录。

完整的安全边界和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 本地开发

```bash
npm ci
npm run dev
```

开发服务默认地址为 <http://127.0.0.1:4317>，会监听前端和服务端源码变化。

生产构建与启动：

```bash
npm run build
npm start
```

常用环境变量：

```bash
PORT=4318 npm run dev
DSH_SESSIONS_DIR=/path/to/sessions npm run dev
CODEX_HOME=/path/to/.codex npm run dev
CODEX_SESSIONS_DIR=/path/to/codex/sessions npm run dev
ZCODE_DB=/path/to/zcode/db.sqlite npm run dev
```

默认使用内置 JavaScript Zstandard 解码器；只有显式设置 `ZSTD_BIN` 时才使用外部
`zstd` 可执行文件。

## 验证

```bash
npm test
npm run build
npm audit --registry=https://registry.npmjs.org
```

在三个来源都可用时，可以运行真实来源冒烟验证：

```bash
npm run verify:real-sources
```

验证摘要默认只写到标准输出，不包含会话正文、原始 session ID、主目录路径或凭据。
如使用 `--output` 保存摘要，该文件仍由本机真实会话派生，不应提交到公开仓库。

## 相关文档

- [性能与架构优化说明](docs/OPTIMIZATION.md)
- [与上游项目的能力比较](docs/UPSTREAM-COMPARISON-2026-10-21.md)
- [DeepSeek Harness 实现比较](docs/DEEPSEEK-HARNESS-IMPLEMENTATION-COMPARISON-2026-10-24.md)
- [Agent 评测复核](docs/AGENT-EVALUATION-REEVALUATION-2026-10-25.md)

## 参与贡献

提交修改前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。请只使用合成 fixture，
不要提交真实 Agent 会话、本地路径、凭证、私有 Prompt 或未脱敏导出。

## 许可证

本项目采用 [MIT License](LICENSE)。
