import { SettingsManager } from "./runtime/agent.js";
import { EnvHttpProxyAgent, install, setGlobalDispatcher } from "undici";
import { getAgentDir } from "./config.js";

export function resolveHttpProxy(
  env: NodeJS.ProcessEnv,
  configuredProxy?: string,
): string | undefined {
  return env.HTTPS_PROXY
    || env.https_proxy
    || env.HTTP_PROXY
    || env.http_proxy
    || configuredProxy
    || undefined;
}

export async function configureNetworkProxy(): Promise<string | undefined> {
  const settings = SettingsManager.create(process.cwd(), getAgentDir()).getGlobalSettings();
  const proxy = resolveHttpProxy(process.env, settings.httpProxy);
  if (proxy) {
    process.env.HTTP_PROXY ??= proxy;
    process.env.HTTPS_PROXY ??= proxy;
    process.env.http_proxy ??= proxy;
    process.env.https_proxy ??= proxy;
  }
  setGlobalDispatcher(new EnvHttpProxyAgent());
  install?.();
  return proxy;
}
