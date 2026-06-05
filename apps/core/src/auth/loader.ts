import type { AuthPlugin, ResolvedAuthPlugin } from './types.js';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 从文件路径或模块标识符加载 auth 插件。
 *
 * 解析顺序：
 * 1. 绝对路径 → 直接加载
 * 2. 以 '.' 开头 → 相对于 baseDir 解析
 * 3. 其他 → 视为 npm 包名（需已安装）
 *
 * 模块必须有 default export 且符合 AuthPlugin 接口。
 */
export async function loadAuthPlugin(
  modulePath: string,
  baseDir: string,
): Promise<ResolvedAuthPlugin> {
  let resolvedPath: string;
  if (isAbsolute(modulePath)) {
    resolvedPath = modulePath;
  } else if (modulePath.startsWith('.')) {
    resolvedPath = resolve(baseDir, modulePath);
  } else {
    // npm 包名 — 直接 import
    resolvedPath = modulePath;
  }

  const url = isAbsolute(resolvedPath)
    ? pathToFileURL(resolvedPath).href
    : resolvedPath;

  const mod = await import(url);
  const plugin: AuthPlugin = mod.default ?? mod;

  validatePluginShape(plugin, modulePath);

  return { plugin, modulePath };
}

function validatePluginShape(plugin: unknown, modulePath: string): asserts plugin is AuthPlugin {
  if (!plugin || typeof plugin !== 'object') {
    throw new Error(
      `Auth plugin at '${modulePath}' must export a default object`,
    );
  }

  const p = plugin as Record<string, unknown>;

  if (typeof p.name !== 'string' || !p.name) {
    throw new Error(
      `Auth plugin at '${modulePath}' must have a non-empty string 'name' property`,
    );
  }

  if (typeof p.createFetch !== 'function') {
    throw new Error(
      `Auth plugin at '${modulePath}' must have a 'createFetch' method`,
    );
  }

  if (p.validateConfig !== undefined && typeof p.validateConfig !== 'function') {
    throw new Error(
      `Auth plugin at '${modulePath}' 'validateConfig' must be a function if provided`,
    );
  }
}
