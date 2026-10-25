import {
  AI_ENHANCEMENT_MODULE_LABELS,
  type AiEnhancementModule,
} from '../../src/ai-summary-types'

const GUIDES: Record<AiEnhancementModule, string> = {
  outcome: [
    '区分“执行结束”“实现完成”和“结果已被验证”，结论强度不得超过证据。',
    '说明目标达成情况、验证实际覆盖的范围、仍未解决或无法判断的事项。',
    '不要用没有继续报错替代正确性证明。',
  ].join(' '),
  objective: [
    '从用户要求、后续调整和实际执行中提炼核心目标。',
    '给出可核查的成功标准、明确约束和目标演变；不要把实现手段写成最终目标。',
    '若目标发生变化，解释最终目标如何吸收或取代较早要求。',
  ].join(' '),
  story: [
    '保留事实包给出的阶段 ID、步骤归属和顺序，只深化阶段标题与专业叙事。',
    '每个阶段说明模型判断、关键行动、阶段结果和转折；避免逐条复述工具调用。',
    '失败及其诊断、修正和验证应形成连贯因果链。',
  ].join(' '),
  evaluation: [
    '只评估事实包中给出的固定维度，不生成总分。',
    '每个维度分别说明结论、优势、风险和证据限制。',
    '效率判断要区分必要验证、用户要求的复核、正常轮询与无信息增益的重复动作。',
  ].join(' '),
  optimization: [
    '提出有证据、可执行、可验证的改进，优先深化本地发现。',
    '措施可落在代码、Agent 规则、Skill、Hook、插件/MCP、环境、工作流或观测验证。',
    '说明为什么适合该载体、实施位置、预期收益、验证方式和判断限制。',
    '每条建议必须给出至少一项 executionActions：明确动作类型、目标文件或候选位置、操作步骤、可直接复制的完整内容和单独验证方式。',
    '规则类优先给出可放入项目根目录 AGENTS.md 的 Markdown；代码类给出修改位置和最小代码草案。没有真实文件证据时必须标记“候选位置”，不得伪造路径。',
    '不得假设未记录的插件、Skill 或环境一定存在，也不得自动执行建议。',
  ].join(' '),
}

export function enhancementGuide(modules: readonly AiEnhancementModule[]): string {
  return modules.map(module =>
    `【${AI_ENHANCEMENT_MODULE_LABELS[module]}】${GUIDES[module]}`)
    .join('\n')
}
