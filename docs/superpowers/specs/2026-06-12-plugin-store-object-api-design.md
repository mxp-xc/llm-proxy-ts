# PluginStore 对象读写 + 自动命名空间

## Context

当前 `auth.json` 中 `_plugins` 子树使用扁平冒号分隔键名（如 `"w3-auth:w3:accessToken": "xxx"`），可读性差，不支持结构化嵌套。插件需要手动用冒号拼接命名空间，且只能存取字符串标量值。

**目标**：改为按插件名自动命名空间隔离的对象读写接口，auth.json 中存储为嵌套结构。

## 接口设计

```typescript
/** 插件持久化存储。数据自动存储在 _plugins.{pluginName} 下。 */
interface PluginStore {
  /** 读取当前插件的全部存储数据。无数据时返回空对象。 */
  get(): Promise<Record<string, unknown>>
  /** 替换当前插件的全部存储数据。 */
  set(data: Record<string, unknown>): Promise<void>
}
```

### 语义

- `get()` 返回当前插件子树的**浅拷贝**，无数据时返回 `{}`
- `set(data)` **替换**当前插件的整个子树，不保留旧字段
- 数据自动存储在 `_plugins.{pluginName}` 下，插件无需关心命名空间

## auth.json 存储结构

```json
{
  "provider-a": { "accessToken": "...", "tokenType": "Bearer" },
  "_plugins": {
    "demo-auth": {
      "accessToken": "xxx",
      "expiresAt": "123"
    },
    "w3-auth": {
      "w3": { "accessToken": "yyy" },
      "zhipu": { "accessToken": "zzz" }
    }
  }
}
```

## 插件代码示例

**简单场景**（demo-auth）：

```typescript
// 读取
const stored = await ctx.store.get()
if (stored.accessToken && stored.expiresAt) { ... }

// 写入（完整替换）
await ctx.store.set({ accessToken: token, expiresAt: String(ts) })
```

**多 provider 嵌套场景**（w3-auth）：

```typescript
// 读取
const stored = await ctx.store.get()
const w3Token = (stored.w3 as Record<string, unknown>)?.accessToken

// 部分更新：先读再改再写
await ctx.store.set({ ...stored, w3: { accessToken: 'new' } })
```

## 改动清单

### 1. `apps/core/src/plugins/types.ts`

- `PluginStore` 接口从 `get(key: string) → string | undefined` + `set(key: string, value: string) → void` 改为 `get() → Record<string, unknown>` + `set(data: Record<string, unknown>) → void`
- 更新 JSDoc
- 移除 `AuthPluginStore` 废弃别名（v0，无外部消费者）

### 2. `apps/core/src/plugins/store-adapter.ts`

- `createPluginStore(authFilePath, pluginName)` 新增 `pluginName` 参数
- `get()`: 读取 `_plugins.{pluginName}` 子树，返回浅拷贝或 `{}`
- `set(data)`: 替换 `_plugins.{pluginName}` 子树，保留其他插件的子树
- 更新 JSDoc 示例

### 3. `apps/core/src/plugins/registry.ts`

- `initAll()`: 每个插件创建 `createPluginStore(authFilePath, rp.plugin.name)`
- `createAuthFetch()`: 创建 `createPluginStore(authFilePath, rp.plugin.name)`
- `discoverModels()`: 创建 `createPluginStore(authFilePath, rp.plugin.name)`
- `noopStore` 改为 `get() → {}` + `set() → {}`

### 4. `plugins/auth-demo/index.ts`

- 适配新接口：`ctx.store.get('accessToken')` → `(await ctx.store.get()).accessToken`
- `ctx.store.set('accessToken', value)` → `ctx.store.set({ accessToken: value, expiresAt: ... })`

### 5. `apps/core/test/auth-store-adapter.test.ts`

- 重写全部测试用例，验证嵌套结构和对象读写
- 测试场景：空子树读取、完整替换、多插件隔离、OAuth 数据共存

### 6. 不需改动

- `apps/core/src/oauth/token-store.ts` — `PLUGINS_KEY` 保持 `'_plugins'`，`extractTokenStore`/`mergeTokenStore` 逻辑不变
- `apps/core/src/index.ts` — 仅 re-export，接口名不变

## 验证

1. `pnpm --filter @llm-proxy/core test test/auth-store-adapter.test.ts` — 全部通过
2. `pnpm --filter @llm-proxy/core typecheck` — 无类型错误
3. `pnpm test` — 全量测试通过
