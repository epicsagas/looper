import { dirname, join } from "node:path";

export function buildBackupPath(
  backupDir: string,
  now: Date = new Date(),
): string {
  const stamp = now.toISOString().replaceAll(":", "-");
  return join(backupDir, `looper-${stamp}.sqlite`);
}

export function getDbParentDir(dbPath: string): string {
  return dirname(dbPath);
}
