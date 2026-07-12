---
name: codex-profile-e2e
description: 通过 Codex CLI profile 验证本地 LLM proxy。用于确认 `codex exec --profile` 能经由本地 `/codex/v1` 调用模型，尤其是 OpenAI Responses wire compatibility；不使用 `codex install`。
---

# Codex Profile E2E

用 `$CODEX_HOME/<profile>.config.toml` 临时覆盖 provider，继承全局 `config.toml` 的其他配置，然后运行真实 `codex exec --profile` 链路。

## 步骤

1. 启动 proxy。

   ```bash
   bun dev serve
   ```

   端口冲突时不要默认 kill 进程；确认 cwd 后，优先用 repo `temp/` 下的临时 settings 换端口：

   ```bash
   LLM_PROXY_SETTINGS_FILE=temp/e2e-settings.jsonc bun dev serve
   ```

2. 写 profile 文件。
   - `--profile <name>` 接收的是名称，不是文件路径。
   - 文件必须在 `$CODEX_HOME/<name>.config.toml`；`CODEX_HOME` 未设置时等价于 `~/.codex/<name>.config.toml`。
   - 如需自定义目录，用 `CODEX_HOME=/path/to/codex-home`，不要写 `--profile /path/file.toml`。

   ```bash
   profile="llm-proxy-e2e-$(python3 -c 'import uuid; print(uuid.uuid4().hex[:6])')"
   profile_file="${CODEX_HOME:-$HOME/.codex}/${profile}.config.toml"
   mkdir -p "$(dirname "$profile_file")"
   printf '%s\n' \
     "model_provider = \"$profile\"" \
     "" \
     "[model_providers.$profile]" \
     "name = \"LLM Proxy E2E\"" \
     "base_url = \"http://127.0.0.1:<port>/codex/v1\"" \
     "wire_api = \"responses\"" \
     "requires_openai_auth = false" \
     > "$profile_file"
   printf 'profile=%s\nprofile_file=%s\n' "$profile" "$profile_file"
   ```

3. 确认 model。
   - 默认继承 `$CODEX_HOME/config.toml` 里的 `model = "..."`；如果该 id/alias 在 proxy 中可用，不需要查模型列表。
   - 继承模型不可用时，用 `/v1/models` 选一个 provider-qualified id，再在执行命令里加 `-m "<model-id>"`。
   - `/codex/v1/models` 只用于诊断 Codex 专用 catalog，不是常规 E2E 前置步骤。

4. 运行 E2E。

   ```bash
   codex exec --profile "$profile" \
     --dangerously-bypass-approvals-and-sandbox \
     "Reply with exactly: llm-proxy-e2e-ok"
   ```

5. 验收并记录证据。
   - exit code 为 0，最终输出包含 `llm-proxy-e2e-ok`。
   - proxy 日志出现 `POST /codex/v1/responses`。
   - 记录 profile 名、profile 路径、`base_url`、proxy 端口、model 来源、完整命令和相关日志。
   - 测试后停止本次启动的 proxy；删除本次创建的 profile 文件。
