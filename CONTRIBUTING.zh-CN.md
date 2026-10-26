# 为 Agent Trajectory 做贡献

[English](CONTRIBUTING.md) | **简体中文**

感谢你帮助改进 Agent Trajectory。

参与本项目须遵守[行为准则](CODE_OF_CONDUCT.zh-CN.md)。

## 开发环境

请使用 Node.js 22.12 或更高版本：

```bash
npm ci
npm run dev
```

提交修改前请运行：

```bash
npm test
npm run build
npm audit
```

## 修改准则

- 所有来源适配器及常规查看、评测路径都必须保持只读。它们不得对 DSH、Codex 或
  ZCode 执行写入、注入、解密或工具调用。
- `install-hooks` 和 `uninstall-hooks` 是唯二可以修改上游配置的路径。它们只能在用户
  显式执行命令后运行，只能修改标记为 Agent Trajectory 激活 Hook 的条目，并且必须使用
  经过回滚测试的文件事务。不得将此例外用于会话内容、Agent 控制、工具执行或隐式设置。
- 保持 opaque session ID 路由和仅限回环地址的 HTTP 访问。
- 行为发生变化时，请新增或更新测试，尤其是解析、投影、脱敏、来源隔离和缓存失效方面。
- 使用合成 fixture。不要提交真实 Agent 会话、本地路径、凭证、私有 Prompt、专有源代码，
  或生成的 `evidence/real-source-verification.json`。
- 将来源专属解析逻辑保留在 `server/sources` 或 `server/projectors`，统一模型只应暴露
  具有证据支持的共享事实。
- 保持 Pull Request 聚焦，并说明面向用户的变化、安全影响和已完成的验证。

## 报告安全问题

不要在公开 Issue 中披露疑似漏洞或敏感样本数据。请遵循[安全策略](SECURITY.zh-CN.md)
中的私密报告方式。

提交贡献即表示你同意根据 [MIT License 英文原文](LICENSE)许可你的贡献。
[中文翻译](LICENSE.zh-CN.md)仅供参考。
