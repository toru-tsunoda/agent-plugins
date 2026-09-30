/** リポジトリの git worktree ごとの費用・動き・タスクを並べる (dashboard.ts の「worktree 一覧」)。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collect, gitWorktreeInfo, type PriceTable } from "./collect.ts";

type Json = Record<string, any>;

export interface WorktreeRow {
  path: string;
  /** メインの worktree からの相対パス (メイン自身は "."、外にあれば ~ 付きの絶対パス) */
  where: string;
  branch: string | null;
  isMain: boolean;
  isCurrent: boolean;
  prunable: boolean;
  cost_usd: number;
  sessions: number;
  last_at: string | null;
  /** 最後にログに書かれた動き (タスクの鮮度に使う) */
  last_activity_at: string | null;
  /** その worktree の直近のセッションの今の状態 */
  state: Json | null;
  /** その worktree の .dev/dashboard.json。無ければ null */
  tasks: { done: number; total: number; doing: number; openQuestions: number; updatedAt: string } | null;
}

const realpath = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

function taskSummary(worktree: string): WorktreeRow["tasks"] {
  try {
    const file = path.join(worktree, ".dev", "dashboard.json");
    const d: Json = JSON.parse(fs.readFileSync(file, "utf-8"));
    const tasks: Json[] = d.tasks || [];
    const live = tasks.filter((t) => t.status !== "dropped");
    return {
      done: live.filter((t) => t.status === "done").length,
      total: live.length,
      doing: live.filter((t) => t.status === "doing").length,
      openQuestions: (d.questions || []).filter((q: Json) => !q.answer).length,
      updatedAt: fs.statSync(file).mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

function where(w: string, main: string): string {
  if (w === main) return ".";
  const rel = path.relative(main, w);
  if (!rel.startsWith("..")) return rel;
  const home = os.homedir();
  return w.startsWith(home + path.sep) ? "~" + w.slice(home.length) : w;
}

/**
 * project と同じリポジトリの worktree を全部集計する。worktree が1つだけ (または git でない) なら空。
 * 各 worktree の中にある別の worktree のセッションは、二重に数えないよう除く。
 * current は、今のダッシュボードの集計 (worktree を除外している時だけ、そのまま使い回す)。
 */
export function worktreeRows(opts: {
  project: string | null;
  root: string;
  since: string;
  prices: PriceTable;
  current: Json;
  currentExcludesWorktrees: boolean;
}): WorktreeRow[] {
  if (!opts.project) return [];
  const list = gitWorktreeInfo(opts.project);
  if (list.length < 2) return [];
  const here = realpath(opts.project);
  const main = list[0].path;

  const rows = list.map((w, i): WorktreeRow => {
    const isCurrent = w.path === here;
    const m =
      isCurrent && opts.currentExcludesWorktrees
        ? opts.current
        : collect(opts.root, w.path, opts.since, opts.prices, { excludeWorktrees: true });
    return {
      path: w.path,
      where: where(w.path, main),
      branch: w.branch,
      isMain: i === 0,
      isCurrent,
      prunable: w.prunable,
      cost_usd: m.cost_total_usd,
      sessions: m.sessions,
      last_at: m.latest_session?.last_at ?? null,
      last_activity_at: m.last_activity_at ?? null,
      state: m.latest_session?.state ?? null,
      tasks: w.prunable ? null : taskSummary(w.path),
    };
  });
  // メインを先頭に、あとは最近動いた順
  return [rows[0], ...rows.slice(1).sort((a, b) => (b.last_at ?? "").localeCompare(a.last_at ?? ""))];
}
