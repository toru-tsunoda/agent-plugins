/** ダッシュボードの初期化 (dashboard.ts の init と、worktree 用の SessionStart hook が使う)。 */
import fs from "node:fs";
import path from "node:path";
import { BUNDLED_PRICES } from "./collect.ts";

type Json = Record<string, any>;

/** dashboard.json の隣の prices.json (init が同梱の料金表をコピーして、Claude が最新化する)。 */
export const pricesPathFor = (dashboardPath: string): string =>
  path.join(path.dirname(path.resolve(dashboardPath)), "prices.json");

export interface InitOptions {
  /** dashboard.json のパス */
  dashboardPath: string;
  /** 集計対象にするフォルダ (既定はカレントディレクトリ) */
  cwd?: string;
  /** 別のダッシュボード (親リポジトリのもの) から引き継ぐ dashboard.json と prices.json のパス */
  from?: { dashboardPath: string };
}

/** 作ったファイルのパスを返す。既にあるファイルは上書きしない。 */
export function initDashboard(opts: InitOptions): string[] {
  const cwd = opts.cwd ?? process.cwd();
  const dir = path.dirname(path.resolve(opts.dashboardPath));
  fs.mkdirSync(dir, { recursive: true });
  const created: string[] = [];

  if (!fs.existsSync(opts.dashboardPath)) {
    let parent: Json | null = null;
    if (opts.from) {
      try {
        parent = JSON.parse(fs.readFileSync(opts.from.dashboardPath, "utf-8"));
      } catch {
        parent = null;
      }
    }
    const dashboard = {
      title: `${path.basename(cwd)} 作業ダッシュボード`,
      project: path.relative(dir, cwd) || ".",
      // 上限は親から引き継ぐ。タスクはその worktree の作業で決めるので引き継がない
      cost_cap_usd: parent ? (parent.cost_cap_usd ?? 300) : 300,
      session_cap_usd: parent ? (parent.session_cap_usd ?? 25) : 25,
      // project の中にある worktree のセッションは、その worktree のダッシュボードで見る
      exclude_worktrees: true,
      tasks: [],
      questions: [],
    };
    fs.writeFileSync(opts.dashboardPath, JSON.stringify(dashboard, null, 2) + "\n", "utf-8");
    created.push(opts.dashboardPath);
  }

  // 料金表は親のものか同梱のものをコピーする。最新化はこのコピーに対して行う (プラグイン本体は更新で上書きされるため)。
  // dashboard.json が既にあっても、prices.json が無ければ作る。
  const prices = pricesPathFor(opts.dashboardPath);
  if (!fs.existsSync(prices)) {
    const parentPrices = opts.from ? pricesPathFor(opts.from.dashboardPath) : null;
    fs.copyFileSync(parentPrices && fs.existsSync(parentPrices) ? parentPrices : BUNDLED_PRICES, prices);
    created.push(prices);
  }
  return created;
}
