#!/usr/bin/env node
/**
 * SessionStart / CwdChanged hook:
 *  - プロジェクトに .dev/glass-cockpit/dashboard.json があれば、更新を忘れないよう Claude に伝える。
 *  - git worktree の中で、親リポジトリにだけ dashboard.json がある時は、その worktree 用のダッシュボードを作る。
 */
import fs from "node:fs";
import path from "node:path";
import { gitWorktrees } from "../skills/dashboard/scripts/collect.ts";
import { initDashboard } from "../skills/dashboard/scripts/init.ts";
import { DASHBOARD_DIR, dashboardFile } from "../skills/dashboard/scripts/paths.ts";

type Json = Record<string, any>;

/** Claude に伝えるパス (プロジェクトのルートから) */
const REL = path.join(DASHBOARD_DIR, "dashboard.json");

const realpath = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

/** cwd が親と別の git worktree の中なら、その worktree のルートと親 (メイン worktree) のルートを返す。 */
function linkedWorktree(cwd: string): { root: string; main: string } | null {
  const list = gitWorktrees(cwd);
  if (list.length < 2) return null;
  const here = realpath(cwd);
  const root = list
    .filter((w) => here === w || here.startsWith(w + path.sep))
    .sort((a, b) => b.length - a.length)[0];
  const main = list[0];
  return root && root !== main ? { root, main } : null;
}

let event: Json = {};
try {
  event = JSON.parse(fs.readFileSync(0, "utf-8"));
} catch {
  // 標準入力が空・不正なら cwd から探す
}
const cwd: string = event.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
let file = dashboardFile(cwd);
let context = "";

if (!fs.existsSync(file)) {
  const wt = linkedWorktree(cwd);
  const parentFile = wt && dashboardFile(wt.main);
  if (wt && parentFile && fs.existsSync(parentFile)) {
    file = dashboardFile(wt.root);
    if (!fs.existsSync(file)) {
      try {
        initDashboard({ dashboardPath: file, cwd: wt.root, from: { dashboardPath: parentFile } });
        context =
          `この worktree（${wt.root}）用の作業ダッシュボード（${REL}）を、親リポジトリのものを元に自動で作りました。` +
          "上限は親から引き継ぎ、タスクと質問は空です。この worktree の作業内容に合わせて、タスクを追加してください。";
      } catch (e) {
        context = `worktree 用のダッシュボードを作れませんでした: ${(e as Error).message}`;
      }
    }
  }
}

if (fs.existsSync(file)) {
  try {
    const dashboard: Json = JSON.parse(fs.readFileSync(file, "utf-8"));
    const doing = (dashboard.tasks || []).filter((t: Json) => t.status === "doing").map((t: Json) => t.id);
    const openQs = (dashboard.questions || []).filter((q: Json) => !q.answer).map((q: Json) => q.id);
    context +=
      `このプロジェクトには作業ダッシュボード（${REL}）があります。` +
      "タスクに着手した時・終えた時・進めなくなった時、人に判断を仰ぎたい時、質問の回答を受け取った時は、" +
      "glass-cockpit:dashboard スキルの手順で dashboard.json を更新してください。" +
      `doing: ${doing.join(", ") || "なし"}、` +
      `未回答の質問: ${openQs.join(", ") || "なし"}。`;
  } catch (e) {
    context += `このプロジェクトの作業ダッシュボード（${REL}）が JSON として読めません: ${(e as Error).message}。glass-cockpit:dashboard スキルの形式に直してください。`;
  }
}

// CwdChanged では追加のコンテキストを返せるとは限らないので、SessionStart の時だけ出力する
if (context && (event.hook_event_name ?? "SessionStart") === "SessionStart") {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
}
