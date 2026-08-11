import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "./runtime/agent.js";
import { getAgentDir } from "./config.js";

export async function authStatus(): Promise<string> {
  const runtime = await ModelRuntime.create({
    authPath: join(getAgentDir(), "auth.json"),
    modelsPath: join(getAgentDir(), "models.json"),
    allowModelNetwork: false,
  });
  const credentials = await runtime.listCredentials();
  if (credentials.length === 0) return "No stored credentials";
  return credentials.map((credential) => `${credential.providerId}: logged in (${credential.type})`).join("\n");
}

function sanitizeModelsFile(importedProviders: Set<string>): string[] {
  const path = join(getAgentDir(), "models.json");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as { providers?: Record<string, Record<string, unknown>> };
  const changed: string[] = [];
  for (const provider of importedProviders) {
    const config = parsed.providers?.[provider];
    if (config && typeof config.apiKey === "string") {
      delete config.apiKey;
      changed.push(provider);
    }
  }
  if (changed.length === 0) return changed;
  const backup = `${path}.before-hengflow-auth-import`;
  if (!existsSync(backup)) copyFileSync(path, backup);
  const temp = `${path}.hengflow-tmp`;
  writeFileSync(temp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
  return changed;
}

export async function importApiKeys(path: string): Promise<string> {
  chmodSync(path, 0o600);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const runtime = await ModelRuntime.create({
    authPath: join(getAgentDir(), "auth.json"),
    modelsPath: join(getAgentDir(), "models.json"),
    allowModelNetwork: false,
  });
  const knownProviders = new Set(runtime.getProviders().map((provider) => provider.id));
  const imported = new Set<string>();
  for (const [provider, key] of Object.entries(parsed)) {
    if (!knownProviders.has(provider) || typeof key !== "string" || !key.trim()) continue;
    await runtime.login(provider, "api_key", { prompt: async () => key.trim(), notify: () => {} });
    imported.add(provider);
  }
  if (imported.size === 0) throw new Error("文件中没有可识别的 Provider API Key");
  const sanitized = sanitizeModelsFile(imported);
  return [
    `已导入 HengFlow 凭证：${[...imported].join(", ")}`,
    sanitized.length ? `已从 models.json 移除明文 apiKey：${sanitized.join(", ")}` : "models.json 中没有需要清理的明文 Key",
    "HengFlow 运行时不会读取该导入文件；验证成功后请安全删除或归档。",
  ].join("\n");
}
