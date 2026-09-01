import {createHash} from "node:crypto";

export type NativeToolPolicy = "default" | "reduced-native";

// Capability minimization, not an exact tool allowlist or an OS sandbox.
// Pin these in host argv so trusted project configuration cannot re-enable them.
const disabledFeatures = Object.freeze([
  "shell_tool", "unified_exec", "multi_agent", "goals", "apps", "plugins",
  "remote_plugin", "hooks", "skill_mcp_dependency_install", "browser_use",
  "browser_use_external", "computer_use", "image_generation", "in_app_browser",
  "code_mode_host", "workspace_dependencies", "tool_suggest",
]);

export function nativeToolPolicyArgs(policy: NativeToolPolicy): string[] {
  if (policy === "default") return [];
  if (policy !== "reduced-native") throw new Error("NATIVE_TOOL_POLICY_UNKNOWN");
  return ["--strict-config", ...disabledFeatures.flatMap(name => ["-c", `features.${name}=false`]),
    "-c", 'web_search="disabled"'];
}

export function nativeToolPolicyReceipt(policy: NativeToolPolicy) {
  const overrides = nativeToolPolicyArgs(policy);
  return {
    version: 1, name: policy,
    overridesSha256: createHash("sha256").update(JSON.stringify(overrides)).digest("hex"),
    boundary: "Host-selected CLI overrides; not a runtime tool allowlist or OS isolation",
  };
}
