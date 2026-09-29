/** Claude Code の設定ディレクトリの場所 (フックとダッシュボードの両方が同じ計算で決める)。 */
import os from "node:os";
import path from "node:path";

export function expandUser(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

export function configDir(): string {
  return expandUser(process.env.CLAUDE_CONFIG_DIR || "~/.claude");
}
