/**
 * 今動いている Claude Code のセッション。
 * Claude Code は動いている間、`<設定ディレクトリ>/sessions/<pid>.json` にプロセスとセッション ID の対応を書き、
 * 終わる時に消す (/clear などでセッションが変わると sessionId を書き換える)。
 * 公式に説明されていない内部のファイルなので、読めない時は null を返し、呼び出し側はログとフックの記録だけで判定する。
 */
import fs from "node:fs";
import path from "node:path";
import { configDir } from "./paths.ts";

export const runningDir = (): string => path.join(configDir(), "sessions");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM は、プロセスはあるがシグナルを送る権限が無い
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 動いているプロセスのセッション ID。分からない時は null。
 * 異常終了で消えずに残ったファイルは、プロセスが無いので数えない (pid が別のプロセスに使い回されていれば数えてしまうが、
 * その時は動いているとみなすだけで、これまでの判定と変わらない)。
 */
export function runningSessions(): Set<string> | null {
  const dir = runningDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const ids = new Set<string>();
  for (const n of names) {
    const m = /^(\d+)\.json$/.exec(n);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!alive(pid)) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(fs.readFileSync(path.join(dir, n), "utf-8"));
    } catch {
      // 動いているプロセスのファイルが書きかけなどで読めない時は、どのセッションか分からないので、全体を分からないにする
      return null;
    }
    if (typeof o.sessionId === "string") ids.add(o.sessionId);
  }
  return ids;
}
