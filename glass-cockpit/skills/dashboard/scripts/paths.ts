/** Claude Code の設定ディレクトリと、ダッシュボードのファイルの場所 (フックとダッシュボードの両方が同じ計算で決める)。 */
import os from "node:os";
import path from "node:path";

export function expandUser(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

export function configDir(): string {
  return expandUser(process.env.CLAUDE_CONFIG_DIR || "~/.claude");
}

/** ダッシュボードのファイル (dashboard.json・prices.json・dashboard.html) を置く、プロジェクトのルートからの場所。ほかのツールと重ならないようプラグイン名のフォルダにする */
export const DASHBOARD_DIR = path.join(".dev", "glass-cockpit");

/** プロジェクト (または worktree) のルートにある dashboard.json */
export const dashboardFile = (root: string): string => path.join(root, DASHBOARD_DIR, "dashboard.json");
