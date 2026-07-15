# Models Sync 模型描述扩展设计

## 目标

为下游模型发现插件预留可选描述，并在 `bun dev models sync` 的模型选择界面展示，帮助用户理解当前聚焦的候选模型。

## 数据契约

- `DiscoveredModel` 增加可选 `description` 字符串。
- 下游 `discoverModels` 可以填充描述；HTTP fallback 暂不生成描述。
- 描述只属于模型发现和 CLI 展示，不进入模型路由配置。

## CLI 行为

- 非空描述作为 `autocompleteMultiselect` 选项的 `hint` 展示。
- 描述过长时沿用终端与 Clack 的自然换行行为，不截断内容。
- 搜索仅对模型 ID 做大小写不敏感匹配，不匹配描述。
- 缺少描述或描述为空时，候选项保持原有显示方式。

## 同步边界

`description` 不参与模型选择结果、同步计划、增删统计、配置 schema 或 `settings.jsonc` 写入。现有模型同步与 `--dry-run` 行为保持不变。

## 测试

- 验证有描述、无描述和空描述的选项映射。
- 验证模型 ID 搜索忽略大小写，描述内容不参与搜索。
- 验证带描述的发现结果写入配置时仍只保留既有模型字段。
- 运行相关 CLI 测试、typecheck 和 Prettier 检查。
