# /codex/v1/models codex ModelsResponse 格式设计

**日期**: 2026-06-23
**状态**: Draft
**范围**: v0 — 将 `/codex/v1/models` 响应从 OpenAI 格式改为 codex `ModelsResponse` 格式;懒加载 `codex debug models --bundled` 缓存整个 catalog;支持 4 层配置覆盖(默认/全局/provider/model),`templateSlug` 与所有 `ModelInfo` 字段(除 `slug`)可覆盖

> 本 spec 演进 `2026-06-23-codex-endpoint-design.md` 中 `/codex/v1/models` 的响应格式(原为 OpenAI `{object,data}`,改为 codex `{models:[...]}`)。`/codex/v1/responses` 与其它端点不变。

## 1. 目标

让 codex CLI 指向本代理时,`GET /codex/v1/models` 返回 codex 专有 `ModelsResponse { models: [ModelInfo] }`,使 codex 能反序列化、模型进入 picker。prompt 与能力字段取自 codex 最新版内置 catalog(动态执行 `codex debug models --bundled`),并支持 4 层配置覆盖。

**不在范围内**:
- 不替换 codex template 的 L1 身份行(直接用 codex 原版;如需可经 model 层覆盖 `base_instructions`/`model_messages`)
- 不实现 ETag / If-None-Match 缓存(codex 可选,不返回也能用)
- 不改动 `/codex/v1/responses`、`/v1/models`、现有 settings model 必填字段
- 不做嵌套对象深合并(覆盖为字段级浅合并,`model_messages`/`truncation_policy` 等整体替换)
- 不允许覆盖 `slug`(见 §9 理由)

## 2. 背景

codex CLI 的 model picker 请求 provider 的 `GET /models`(codex `base_url` 配 `/codex/v1` 时即 `/codex/v1/models`),反序列化为 codex 专有 `ModelsResponse`。标准 OpenAI `/models` 格式(`{object,data}`)会让 codex 反序列化失败(缺 `models` 字段、缺 `slug`/`visibility`/`supported_in_api`/`base_instructions`/`truncation_policy` 等必填字段、key 名不匹配),导致 catalog 为空、picker 选不到模型。

完整契约见 `D:/code/github/codex/temp/codex-models-handoff.md`:13 个必填字段、picker 过滤条件(`visibility="list"` + `supported_in_api=true`)、slug 匹配逻辑(最长前缀 + namespaced suffix)。

## 3. 架构

### 数据流

```
客户端 → GET /codex/v1/models
       → 主 app 全局中间件(requestId / logger / x-request-id)
       → /codex 子应用路由
       → 若 catalog 未缓存:
           执行 `codex debug models --bundled` → stdout JSON → 缓存整个 catalog(按 slug 索引)
       → buildCodexModelsResponse(settings, catalog):
           遍历 listModels 所有 id → 每个 id 按 4 层合并(templateSlug 决定取哪个 template)生成 ModelInfo(slug=id 固定)
       → 返回 { models: [ModelInfo, ...] }
```

### catalog 获取与缓存(懒加载)

- 首次访问 `/codex/v1/models` 时执行 `codex debug models --bundled`(`node:child_process` execFile),取 stdout,`JSON.parse` 为 `{models:[...]}`。
- 校验每个条目含 `slug` 字段后,缓存**整个 catalog**:按 `slug` 索引所有 `ModelInfo`(`Map<slug, ModelInfo>`),模块级内存,重启刷新。
- 首次加载的并发请求去重(共享进行中的 Promise),避免重复 exec。
- 每个模型:合并 4 层得到 `templateSlug`(默认 `gpt-5.4`),从缓存 catalog 取该 slug 的 `ModelInfo` 作 template。若该 slug 不在 catalog → 抛错(handler 返回 503)。
- 不同模型可用不同 `templateSlug`(如某模型 gpt-5.5、另一模型 gpt-5.4),因整个 catalog 已缓存。
- 执行器可注入(测试用 mock),默认用 `node:child_process`。

### 配置层级与合并

优先级(低 → 高,后者覆盖前者):

1. **默认**:template(由合并后 `templateSlug` 决定)+ settings 推导(`slug`=id、`display_name`=id、`context_window`=`limit.context`??4 层 `context_window`、`visibility`="list"、`supported_in_api`=true、`priority`=0、`experimental_supported_tools`=[])
2. **全局**:`settings.codex`(`templateSlug` + `CodexModelOverride`,非 optional,`templateSlug` 默认 `gpt-5.4`、`context_window` 默认 `200000`)
3. **provider**:`provider.options.codex`(`templateSlug` + `CodexModelOverride`)
4. **model**:`model.codex`(`templateSlug` + `CodexModelOverride`)

**合并顺序**(关键,消除歧义):

1. 合并 `templateSlug`(优先级 model > provider > 全局;全局 `settings.codex.templateSlug` 默认 `gpt-5.4`),从 catalog 取该 slug 的 `ModelInfo` 作**基底 template**
2. 应用 settings 推导默认值(覆盖 template 对应字段):`slug`=listModels id(固定)、`display_name`=slug、`context_window`/`max_context_window`=`limit.context`??合并后 `contextWindow`(优先级 model > provider > 全局,默认 `200000`)、`visibility`="list"、`supported_in_api`=true、`priority`=0、`experimental_supported_tools`=[]
3. 应用三层字段覆盖(全局 → provider → model,字段级浅合并,嵌套对象整体替换)

`slug` 固定为 listModels id,**不在 `CodexModelOverride` 中,不可覆盖**。

### 文件结构

```
新增/修改文件:
src/server/
  codex-catalog.ts            ← 新增:fetchCodexBundledCatalog + buildCodexModelsResponse + 4 层合并 + catalog 缓存 + 类型
  codex.ts                    ← 修改:/codex/v1/models handler 改为返回 codex ModelsResponse
src/
  config.ts                   ← 修改:加 codexModelOverrideSchema + codexSchema;挂到 settings.codex、commonProviderOptions.codex、modelRouteConfig.codex
test/server/
  codex-catalog.test.ts       ← 新增:4 层合并 + catalog/懒加载/503 测试(mock exec)
  codex-endpoint.test.ts      ← 修改:/codex/v1/models 用例改为断言 codex 格式
```

## 4. ModelInfo 字段映射

每个 listModels id 生成一个 `ModelInfo`,字段按 §3 合并顺序生成。

**13 个必填字段**(handoff §3.1,缺失则 codex 反序列化失败):`slug`、`display_name`、`supported_reasoning_levels`、`shell_type`、`visibility`、`supported_in_api`、`priority`、`base_instructions`、`supports_reasoning_summaries`、`support_verbosity`、`truncation_policy`、`supports_parallel_tool_calls`、`experimental_supported_tools`。

| 字段 | 必填 | 默认来源 | 可覆盖 |
|---|---|---|---|
| `slug` | ✅ | listModels id(`provider/modelKey` / `modelKey` / alias) | ❌ 固定 |
| `display_name` | ✅ | `slug` | ✅ |
| `description` |   | template | ✅ |
| `context_window` / `max_context_window` |   | `limit.context` ?? 4 层 `contextWindow`(默认 `200000`);`context_window` 覆盖字段优先 | ✅ |
| `base_instructions` | ✅ | template | ✅ |
| `model_messages` |   | template | ✅ |
| `supported_reasoning_levels` | ✅ | template | ✅ |
| `default_reasoning_level` |   | template(null 可接受) | ✅ |
| `shell_type` | ✅ | template | ✅ |
| `visibility` | ✅ | `"list"` | ✅ |
| `supported_in_api` | ✅ | `true` | ✅ |
| `priority` | ✅ | `0` | ✅ |
| `additional_speed_tiers` / `service_tiers` |   | template(默认 `[]`) | ✅ |
| `default_service_tier` / `availability_nux` / `upgrade` |   | template(默认 `null`) | ✅ |
| `supports_reasoning_summaries` | ✅ | template | ✅ |
| `default_reasoning_summary` |   | template(默认 `"auto"`) | ✅ |
| `support_verbosity` | ✅ | template | ✅ |
| `default_verbosity` |   | template(默认 `null`) | ✅ |
| `apply_patch_tool_type` |   | template(默认 `null`) | ✅ |
| `web_search_tool_type` |   | template(默认 `"text"`) | ✅ |
| `truncation_policy` | ✅ | template | ✅ |
| `supports_parallel_tool_calls` | ✅ | template | ✅ |
| `supports_image_detail_original` |   | template(默认 `false`) | ✅ |
| `auto_compact_token_limit` / `comp_hash` |   | template(默认 `null`) | ✅ |
| `effective_context_window_percent` |   | template(默认 `95`) | ✅ |
| `experimental_supported_tools` | ✅ | `[]` | ✅ |
| `input_modalities` |   | template(默认 `["text"]`) | ✅ |
| `supports_search_tool` / `use_responses_lite` |   | template(默认 `false`) | ✅ |
| `auto_review_model_override` / `tool_mode` / `multi_agent_version` |   | template(默认 `null`) | ✅ |

> 可选字段若 template 未提供且无覆盖,省略输出(codex serde 用默认值);`used_fallback_model_metadata` 不输出(handoff §3 内部标记)。

## 5. 配置体系(4 层)

### CodexModelOverride

`templateSlug` + `contextWindow` + 所有 `ModelInfo` 字段(除 `slug`),全部可选,用于全局/provider/model 三层覆盖:
- `templateSlug`:选 template 源模型。`settings.codex.templateSlug` zod default `"gpt-5.4"`(`settings.codex` 非 optional);provider/model 可覆盖
- `contextWindow`:`limit.context` 缺失时的 `context_window`/`max_context_window` fallback(4 层覆盖,非 ModelInfo 字段,不参与 applyOverride)。`settings.codex.contextWindow` zod default `200000`;provider/model 可覆盖
- 其余 `ModelInfo` 字段(除 `slug`):字段覆盖(applyOverride)

字段(均可选):`templateSlug`、`contextWindow`、`display_name`、`description`、`default_reasoning_level`、`supported_reasoning_levels`、`shell_type`、`visibility`、`supported_in_api`、`priority`、`additional_speed_tiers`、`service_tiers`、`default_service_tier`、`availability_nux`、`upgrade`、`base_instructions`、`model_messages`、`supports_reasoning_summaries`、`default_reasoning_summary`、`support_verbosity`、`default_verbosity`、`apply_patch_tool_type`、`web_search_tool_type`、`truncation_policy`、`supports_parallel_tool_calls`、`supports_image_detail_original`、`context_window`、`max_context_window`、`auto_compact_token_limit`、`comp_hash`、`effective_context_window_percent`、`experimental_supported_tools`、`input_modalities`、`supports_search_tool`、`use_responses_lite`、`auto_review_model_override`、`tool_mode`、`multi_agent_version`。

### 挂载点

三层共用同一 `CodexModelOverride` schema:
- `settings.codex`——全局,挂到 `settingsSchema`
- `provider.options.codex`——provider scope,加到 `commonProviderOptionsSchema`(所有 provider 类型共享)
- `model.codex`——model scope,加到 `modelRouteConfigSchema`

### config.jsonc 示例

```jsonc
{
  "service": { "host": "127.0.0.1", "port": 8056 },
  "codex": {
    "templateSlug": "gpt-5.4",          // 全局:template 源 + 字段覆盖
    "default_reasoning_level": "medium"
  },
  "providers": {
    "zhipu": {
      "type": "openai-compatible",
      "baseURL": "https://open.bigmodel.cn/api/paas/v4",
      "apiKey": "${ZHIPU_API_KEY}",
      "options": {
        "codex": {                        // provider scope:覆盖该 provider 下所有模型
          "templateSlug": "gpt-5.5",      // 该 provider 模型改用 gpt-5.5 template
          "context_window": 128000,
          "max_context_window": 128000
        }
      },
      "models": {
        "glm-5.1": {
          "upstreamModel": "glm-5.1",
          "limit": { "context": 128000 },
          "codex": {                      // model scope:覆盖该单个模型(最高优先级)
            "display_name": "GLM-5.1",
            "supports_parallel_tool_calls": true
          }
        }
      }
    }
  }
}
```

## 6. 错误处理

- codex 命令未装 / 执行失败 / 非零退出 → 503 `{error:{type:"server_error",message:"Failed to fetch codex bundled catalog: <reason>"}}`
- 命令成功但 stdout 非 JSON / 解析失败 / 条目缺 `slug` → 503
- **任一**模型的合并后 `templateSlug` 不在 catalog → 整个 `/codex/v1/models` 返回 503(catalog 对 codex 必须原子,避免缓存部分 catalog)
- `buildCodexModelsResponse`:空 providers 返回 `{models:[]}`;任一模型 template 缺失抛错,handler 捕获返回 503
- handler catch 记录错误日志(含完整 `err` 与堆栈,如 `logger.error({ err }, msg)`),不得只返回 503 响应体——响应体不替代日志

## 7. 测试策略

新增 `test/server/codex-catalog.test.ts`,修改 `codex-endpoint.test.ts`。**全程 mock exec,不依赖真实 codex CLI**。

- `buildCodexModelsResponse` 4 层合并:给定 mock catalog(含多 slug)+ settings(含全局/provider/model 覆盖),断言:
  - 每个 ModelInfo 13 必填字段齐全
  - `slug` = listModels id(固定,不可覆盖;配置写 `slug` 不生效)
  - `templateSlug` 合并:全局 < provider < model(后者胜);按合并后 slug 取对应 template
  - 合并顺序:先取 template → settings 推导默认 → 三层覆盖
  - `display_name` 默认 = slug;被覆盖时取覆盖值
  - `context_window` = `limit.context` ?? 4 层 `contextWindow`(model > provider > 全局,默认 200000);limit.context 优先于 contextWindow;`context_window` 覆盖字段(applyOverride)优先于两者
  - template 字段(`base_instructions`/`model_messages`/能力)默认 = 按 templateSlug 取的 template
  - 嵌套对象覆盖为整体替换(`model_messages`/`truncation_policy`)
  - `visibility`/`supported_in_api`/`priority`/`experimental_supported_tools` 默认 list/true/0/[],可被覆盖
- 集成 `/codex/v1/models`:注入 mock exec(返回固定 bundled JSON),断言响应 `{models:[...]}`,条目数 = listModels id 数
- 懒加载 + 缓存:mock exec 计数,多次请求只执行 1 次;并发首次请求去重
- 多 `templateSlug`:两个模型用不同 templateSlug,断言各自取对应 template 字段
- `templateSlug` 不在 catalog → 503(整个响应)
- codex 失败(exec 抛错 / 非零退出 / 坏 JSON / 条目缺 slug)→ 503

## 8. 与现有代码的复用

- `listModels` 的 id 生成逻辑(`src/providers/models.ts`):复用其遍历(`provider/modelKey` + flat + alias)
- `isFlatLookupEnabled`(`src/config-helpers.ts`):判断是否含 flat modelKey/alias
- `ModelLimit`(`src/providers/model-types.ts`):`context_window` 来源
- `commonProviderOptionsSchema`(`src/config.ts`):provider scope codex 挂载点
- `/codex` 子应用挂载(`src/server/codex.ts`):仅改 `/v1/models` handler
- 全局中间件覆盖:已验证(`/codex/*` 注入 `x-request-id`)

## 9. 约束与已知陷阱

- **`slug` 固定不可覆盖**(路由一致性):`CodexModelOverride` 不含 `slug`,配置中写 `slug` 不生效(zod strip)。codex `config.model` 用 catalog slug 请求 `/codex/v1/responses`,llm-proxy-ts 路由该值——slug 必须是可路由 id。默认 catalog 已输出 `provider/modelKey` + flat `modelKey` + `alias` 三类可路由 slug,覆盖 slug 只会制造 catalog-slug ≠ 路由-id 的断裂(codex picker 能选但 responses 404),无正面价值,故禁止
- 默认 slug = `provider/modelKey`(含 /)走 codex 精确匹配;flat 启用时同时输出短名 `modelKey`/`alias` slug,供 codex namespaced-suffix 或短名 `config.model` 匹配。两类 slug 都可路由,用户 `config.model` 任选
- `templateSlug` 全层支持,合并后决定每模型 template 源;不同模型可用不同 template(整个 catalog 已缓存)
- 合并顺序固定:templateSlug 合并 → 取 template → settings 推导默认 → 三层字段覆盖(浅合并,嵌套对象整体替换)
- **`templateSlug=gpt-5.2` 无 `model_messages`**(handoff §8,旧式结构),身份嵌在 `base_instructions`;选它作 template 时若要自定义身份须覆盖 `base_instructions`(无法经 `model_messages` 覆盖)。gpt-5.4/5.5/5.4-mini/5.3-codex 有 `model_messages`
- catalog 获取依赖宿主机装了 codex CLI 且 `codex` 在 PATH;未装 → 503(不降级)
- catalog 缓存仅内存,重启刷新;codex 升级后需重启代理(或后续加刷新接口)
- L1 身份行用 codex 原版(含 "You are Codex... GPT-5"),不替换;如需自定义身份,经 model 层覆盖 `base_instructions`/`model_messages`
- 多个 id(`provider/modelKey`、`modelKey`、alias)指向同一 upstream 模型时,catalog 有多条内容相同(除 `slug`/`display_name`/被覆盖字段)的 `ModelInfo`;codex 按 slug 匹配,可接受
- `context_window` / `max_context_window` = `limit.context` ?? 4 层 `contextWindow`(model > provider > 全局,默认 `200000`);`contextWindow` 是 fallback 配置(非 ModelInfo 字段,不参与 applyOverride);`context_window` 覆盖字段(applyOverride)优先于 limit/contextWindow;建议在 settings 配 `limit.context` 或 codex 覆盖以匹配真实模型上下文
- 可选字段(template 未提供且无覆盖)省略输出,codex serde 用默认值(`effective_context_window_percent`=95、`web_search_tool_type`="text"、`input_modalities`=["text"] 等)
- 测试全程 mock exec,不实际执行 codex
- `additional_speed_tiers` 为字符串数组(`string[]`,如 `["fast"]`),`service_tiers` 为对象数组;二者类型不同,schema 分别定义,勿混用
