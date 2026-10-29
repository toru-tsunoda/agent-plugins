/**
 * クラウドのセッションで、ダッシュボードを手元のブラウザから見るための書き出し。
 *
 * クラウドのコンテナの serve (127.0.0.1) には手元から届かない。ポートを外に開ける (トンネルなど) と、
 * 認証なしでタスクや費用が見え、POST /api/task で dashboard.json を書き換えられてしまうのでやらない。
 * 代わりに、build と同じ HTML を Claude Code のプロジェクトの共有フォルダ (/mnt/project-files) に書き出し、
 * それを読むだけの Artifact (viewer.html) で表示する。読めるのは、そのプロジェクトのファイルを開ける人だけ。
 *
 * dashboard.json に "cloud_view": true がある時だけ書き出す (オプトイン)。
 * フック (record_state.ts) から呼ぶので、重いモジュール (collect.ts) は読まない。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type Json = Record<string, any>;

/** プロジェクトの共有フォルダ。Claude Code のプロジェクトのセッションだけにある */
export const projectFilesRoot = (): string => process.env.GLASS_COCKPIT_PROJECT_FILES || "/mnt/project-files";

/** 書き出し先の、共有フォルダからの相対パス (Artifact の files.read に渡すパス) */
export const cloudViewRelPath = (dashboardPath: string): string => {
  // dashboard.json は <ルート>/.dev/glass-cockpit/ にある。worktree ごとにルートのフォルダ名で分ける
  const root = path.resolve(path.dirname(path.resolve(dashboardPath)), "..", "..");
  return path.posix.join("glass-cockpit", path.basename(root) || "project", "dashboard.html");
};

/** 書き出し先の絶対パス。オプトインしていない時と、共有フォルダが無い時は null */
export function cloudViewTarget(dashboardPath: string): string | null {
  let dashboard: Json;
  try {
    dashboard = JSON.parse(fs.readFileSync(dashboardPath, "utf-8"));
  } catch {
    return null;
  }
  if (dashboard.cloud_view !== true) return null;
  const root = projectFilesRoot();
  // 共有フォルダそのものは作らない (無い環境では何もしない)
  if (!fs.existsSync(root)) return null;
  return path.join(root, cloudViewRelPath(dashboardPath));
}

/** 書き出し待ちの印。あれば、待っているプロセスがいるので新しく起こさない */
const pendingMarker = (dashboardPath: string): string =>
  path.join(path.dirname(path.resolve(dashboardPath)), ".cloud-view.pending");

/** 書き出しをまとめる待ち時間 (ミリ秒)。並列のツール呼び出しなどで続けて来るフックを1回の集計にする */
export const EXPORT_DELAY_MS = 2000;
/** これより古い印は、待っていたプロセスが落ちたものとして消す */
const STALE_MARKER_MS = 60_000;

/**
 * 少し待ってから書き出すプロセスを、裏で起こす (フックは待たない)。
 * 待っている間に来たフックは何もしない。待ち終わってから集計するので、最後の状態が書き出される。
 */
export function scheduleCloudView(dashboardPath: string): void {
  if (!cloudViewTarget(dashboardPath)) return;
  const marker = pendingMarker(dashboardPath);
  try {
    fs.writeFileSync(marker, String(process.pid), { flag: "wx" });
  } catch {
    try {
      if (Date.now() - fs.statSync(marker).mtimeMs < STALE_MARKER_MS) return;
      fs.writeFileSync(marker, String(process.pid));
    } catch {
      return;
    }
  }
  const script = path.join(import.meta.dirname, "dashboard.ts");
  const child = spawn(process.execPath, [script, "export", "--dashboard", path.resolve(dashboardPath), "--delay", String(EXPORT_DELAY_MS)], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => fs.rmSync(marker, { force: true }));
  child.unref();
}

/** 待ちの印を消す (書き出すプロセスが、集計を始める前に呼ぶ。集計中に来たフックは次の書き出しを起こせる) */
export const clearPending = (dashboardPath: string): void => fs.rmSync(pendingMarker(dashboardPath), { force: true });

/** HTML を書き出す。共有フォルダはネットワークのマウントなので、一時ファイルに書いてから置き換える */
export function writeCloudView(target: string, html: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, html, "utf-8");
  try {
    fs.renameSync(tmp, target);
  } catch {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(target, html, "utf-8");
  }
}
