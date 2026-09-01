import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

const DEFAULT_API_PROXY_TARGET = "http://127.0.0.1:3000";
const REPOSITORY_ENV_DIR = fileURLToPath(new URL("../../", import.meta.url));

export function resolveLocalApiProxyTarget(rawTarget?: string): string {
  const target = rawTarget?.trim() || DEFAULT_API_PROXY_TARGET;
  let parsed: URL;

  try {
    parsed = new URL(target);
  } catch {
    throw new Error(
      "LOCAL_API_PROXY_TARGET must be an absolute loopback HTTP origin with an explicit port.",
    );
  }

  const isLoopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]";
  const isOriginOnly =
    parsed.pathname === "/" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    parsed.username === "" &&
    parsed.password === "";

  if (
    parsed.protocol !== "http:" ||
    !isLoopback ||
    parsed.port === "" ||
    !isOriginOnly
  ) {
    throw new Error(
      "LOCAL_API_PROXY_TARGET must be an absolute loopback HTTP origin with an explicit port.",
    );
  }

  return parsed.origin;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, REPOSITORY_ENV_DIR, "");
  const apiProxyTarget = resolveLocalApiProxyTarget(
    env.LOCAL_API_PROXY_TARGET,
  );

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": apiProxyTarget,
      },
    },
  };
});
