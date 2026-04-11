import type { ToolPathsConfig } from "./types";

export interface ToolDetectionResult {
  paths: ToolPathsConfig;
  detection: Record<
    keyof ToolPathsConfig,
    "configured" | "detected" | "missing"
  >;
}

export function detectToolPaths(
  configured: ToolPathsConfig,
): ToolDetectionResult {
  const paths: ToolPathsConfig = {
    bunPath: configured.bunPath,
    gitPath: configured.gitPath,
    ghPath: configured.ghPath,
    osascriptPath: configured.osascriptPath,
  };

  const detection: ToolDetectionResult["detection"] = {
    bunPath: configured.bunPath ? "configured" : "missing",
    gitPath: configured.gitPath ? "configured" : "missing",
    ghPath: configured.ghPath ? "configured" : "missing",
    osascriptPath: configured.osascriptPath ? "configured" : "missing",
  };

  const candidates: Array<[keyof ToolPathsConfig, string]> = [
    ["bunPath", "bun"],
    ["gitPath", "git"],
    ["ghPath", "gh"],
    ["osascriptPath", "osascript"],
  ];

  for (const [key, executable] of candidates) {
    if (paths[key]) {
      continue;
    }

    const resolvedPath = Bun.which(executable);
    if (resolvedPath) {
      paths[key] = resolvedPath;
      detection[key] = "detected";
    }
  }

  return { paths, detection };
}
