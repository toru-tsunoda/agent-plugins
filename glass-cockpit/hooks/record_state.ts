#!/usr/bin/env node
/**
 * 状態記録フック: ツールの開始・終了、権限の確認、ターンの終了などを、セッションごとの JSONL に1行ずつ足す。
 * ダッシュボードはこれを畳み込んで「今の状態」を出す (skills/dashboard/scripts/hookstate.ts)。
 * dashboard.json で "cloud_view": true にしたプロジェクトでは、共有フォルダへのダッシュボードの書き出しも起こす (cloudview.ts)。
 * 何があっても exit 0 で終わり、何も出力しない (Claude の動作を変えない)。
 */
import fs from "node:fs";
import path from "node:path";
import { scheduleCloudView } from "../skills/dashboard/scripts/cloudview.ts";
import { hookStateFile, pruneHookStates, type HookLine } from "../skills/dashboard/scripts/hookstate.ts";
import { dashboardFile } from "../skills/dashboard/scripts/paths.ts";
import { toolDetail } from "../skills/dashboard/scripts/state.ts";

try {
  const e = JSON.parse(fs.readFileSync(0, "utf-8"));
  const ev = String(e.hook_event_name || "");
  if (e.session_id && ev) {
    const line: HookLine = { at: new Date().toISOString(), ev };
    if (e.tool_name) {
      line.tool = String(e.tool_name);
      line.detail = toolDetail(line.tool, e.tool_input || {});
    }
    if (e.tool_use_id) line.id = String(e.tool_use_id);
    if (Array.isArray(e.tool_calls)) line.ids = e.tool_calls.map((c: any) => c?.tool_use_id).filter(Boolean);
    if (e.notification_type) line.type = String(e.notification_type);
    if (e.agent_id) line.agent = String(e.agent_id);
    if (e.reason) line.reason = String(e.reason);

    const file = hookStateFile(String(e.session_id));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 1行を1回の write で追記する。O_APPEND なので、並列のツール呼び出しで同時に書いても行が混ざらない
    const fd = fs.openSync(file, "a");
    try {
      fs.writeSync(fd, JSON.stringify(line) + "\n");
    } finally {
      fs.closeSync(fd);
    }
    // 今の状態が変わったので、クラウドで見ている人のために書き出し直す (裏で動き、フックは待たない)
    const root = [e.cwd, process.env.CLAUDE_PROJECT_DIR].find((d) => d && fs.existsSync(dashboardFile(d)));
    if (root) scheduleCloudView(dashboardFile(root));
    if (ev === "SessionEnd") {
      // 集計のモジュールは重いので、掃除する時だけ読む
      const { cleanupPeriodDays } = await import("../skills/dashboard/scripts/collect.ts");
      pruneHookStates(cleanupPeriodDays(e.cwd)[0]);
    }
  }
} catch {
  // 記録できなくても Claude は止めない
}
