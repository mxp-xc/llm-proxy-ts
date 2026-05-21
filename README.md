# llm-proxy-ts

`llm-proxy-ts` 是 `llm-proxy` 的 TypeScript 迁移仓库，目标是将现有 Python FastAPI 版本的本地优先 LLM 反向代理实现迁移到 TypeScript 生态。

当前仓库仅完成初始化，尚未包含运行时代码。

## 迁移来源

原实现位于本机目录：

```text
D:\code\github\llm-proxy
```

原 Python 版本已具备的核心能力包括：

- OpenAI-compatible LLM provider/model 路由
- `/v1/chat/completions` 非流式与 SSE 流式代理
- JSONC 配置文件与环境变量配置
- 上游错误安全处理
- Provider/model 级插件配置
- 本地 `/health` 健康检查

## 迁移原则

- 先迁移行为和测试，再做 TypeScript 生态优化。
- 保持 OpenAI-compatible API 的客户端兼容性。
- 本地配置和密钥只保留在未提交文件中。
- 不提交真实 API key、`.env`、`config/settings.jsonc` 或其他本地敏感配置。

## 后续工作

后续开发开始时再选择具体 TypeScript 运行时、框架、测试工具和包结构。本次初始化不包含业务代码或脚手架实现。
