#!/usr/bin/env node
/**
 * Claude Code のセッションログ (~/.claude/projects/**\/*.jsonl) から
 * ダッシュボードの指標を集計して JSON で出力する (dashboard.ts からも使う)。
 *
 *   node collect.ts                      # 全プロジェクト
 *   node collect.ts --project ~/src/foo  # 1プロジェクト (サブディレクトリと worktree を含む)
 *   node collect.ts --days 30 --out /tmp/metrics.json
 *   node collect.ts --prices .dev/prices.json   # 料金表を差し替える
 *
 * 費用は API 換算 (定額プランでも API 単価で出す)。トークン数 × 単価の概算と、Claude Code が
 * セッションに記録する cost-state のうち大きいほうを使う (概算はタイトル生成などの裏の呼び出しを含まず数%低い)。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { summarizeActivity, type ToolUse } from "./activity.ts";
import { readHookState } from "./hookstate.ts";
import { configDir, expandUser } from "./paths.ts";
import { sessionState, StateTracker } from "./state.ts";

type Json = Record<string, any>;

/** 料金表 (prices.json)。models は接頭辞で照合する。 */
export interface PriceTable {
  updatedAt: string | null;
  file: string;
  cacheWrite5m: number;
  cacheWrite1h: number;
  fastMode: number;
  models: { prefix: string; input: number; output: number; cacheRead: number; tier: Tier }[];
}

/** モデルの格。high は Opus 以上 (Opus・Fable・Mythos)、low は Sonnet・Haiku。 */
export type Tier = "high" | "low" | "unknown";

const inferTier = (prefix: string): Tier =>
  /opus|fable|mythos/.test(prefix) ? "high" : /sonnet|haiku/.test(prefix) ? "low" : "unknown";

/** 同梱の料金表。init が .dev/prices.json にコピーして、そちらを最新化する。 */
export const BUNDLED_PRICES = new URL("../prices.json", import.meta.url).pathname;

/** 料金表を読む。file が無い・壊れている時は同梱のものに戻す。 */
export function loadPrices(file?: string | null): PriceTable {
  for (const f of [file, BUNDLED_PRICES]) {
    if (!f) continue;
    const j = readJson(f);
    if (!j || !Array.isArray(j.models)) continue;
    return {
      updatedAt: j.updated_at ?? null,
      file: f,
      cacheWrite5m: j.cache_write_multiplier?.["5m"] ?? 1.25,
      cacheWrite1h: j.cache_write_multiplier?.["1h"] ?? 2.0,
      fastMode: j.fast_mode_multiplier ?? 2,
      // 長い接頭辞を先に照合する (並び順に依存しない)
      models: j.models
        .map((m: Json) => ({
          prefix: String(m.prefix),
          input: +m.input,
          output: +m.output,
          cacheRead: +m.cache_read,
          // tier が無ければ名前から推す (最新化で行が増えても壊れない)
          tier: (["high", "low", "unknown"].includes(m.tier) ? m.tier : inferTier(String(m.prefix))) as Tier,
        }))
        .sort((a: { prefix: string }, b: { prefix: string }) => b.prefix.length - a.prefix.length),
    };
  }
  throw new Error("料金表 (prices.json) を読めません");
}

const DENIAL_MARKERS = [
  "doesn't want to proceed", // 人が拒否した
  "Permission to use", // 権限ルールで拒否
  "denied by", // 自動モードの分類器・hook
  "<tool_use_error>Blocked", // ハーネスがブロック
];

const CONTEXT_MISS_RATIO = 0.5; // 直前の呼び出しの文脈のうち、これ未満しかキャッシュから読めなければ「読み落とし」
const DEFAULT_CLEANUP_DAYS = 30; // Claude Code の cleanupPeriodDays の既定値

export { configDir, expandUser };

function readJson(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return undefined;
  }
}

/** cleanupPeriodDays と、それを決めた設定ファイルを返す (どこにもなければ既定値と null)。 */
export function cleanupPeriodDays(project?: string | null): [number, string | null] {
  const paths: string[] = [];
  if (project) {
    paths.push(path.join(project, ".claude", "settings.local.json"), path.join(project, ".claude", "settings.json"));
  }
  paths.push(path.join(configDir(), "settings.json"));
  for (const p of paths) {
    const v = readJson(p)?.cleanupPeriodDays;
    if (typeof v === "number" && v > 0) return [Math.trunc(v), p];
  }
  return [DEFAULT_CLEANUP_DAYS, null];
}

function priceFor(prices: PriceTable, model?: string) {
  const base = (model || "").split("[")[0];
  return prices.models.find((m) => base.startsWith(m.prefix)) ?? null;
}

function callCost(prices: PriceTable, model: string | undefined, usage: Json): number | null {
  const p = priceFor(prices, model);
  if (p === null) return null;
  const { input: inp, output: out, cacheRead: read } = p;
  const cc = usage.cache_creation || {};
  let w5 = cc.ephemeral_5m_input_tokens;
  let w1 = cc.ephemeral_1h_input_tokens;
  if (w5 == null && w1 == null) {
    w5 = usage.cache_creation_input_tokens ?? 0;
    w1 = 0;
  }
  let cost =
    ((usage.input_tokens ?? 0) * inp +
      (w5 || 0) * inp * prices.cacheWrite5m +
      (w1 || 0) * inp * prices.cacheWrite1h +
      (usage.cache_read_input_tokens ?? 0) * read +
      (usage.output_tokens ?? 0) * out) /
    1e6;
  if (usage.speed === "fast") cost *= prices.fastMode;
  return cost;
}

function encodeProject(p: string): string {
  // Claude Code はパスの英数字以外 (/ . 空白 _ など) を - にしたディレクトリ名でログを置く
  return path.resolve(expandUser(p)).replace(/[^A-Za-z0-9]/gu, "-");
}

export interface WorktreeInfo {
  path: string;
  /** ブランチ名 (detached HEAD なら null) */
  branch: string | null;
  /** ディレクトリが無くなっていて `git worktree prune` の対象 */
  prunable: boolean;
}

/** git の worktree の一覧 (`git worktree list`、先頭がメイン)。git が無い・リポジトリでない時は空。 */
export function gitWorktreeInfo(dir: string): WorktreeInfo[] {
  try {
    const out = execFileSync("git", ["-C", dir, "worktree", "list", "--porcelain"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return out
      .split(/\n\n+/)
      .map((block) => block.split("\n"))
      .filter((lines) => lines[0]?.startsWith("worktree "))
      .map((lines) => ({
        path: lines[0].slice("worktree ".length),
        branch: lines.find((l) => l.startsWith("branch "))?.slice("branch ".length).replace(/^refs\/heads\//, "") ?? null,
        prunable: lines.some((l) => l.startsWith("prunable")),
      }));
  } catch {
    return [];
  }
}

/** git の worktree のパス一覧 */
export const gitWorktrees = (dir: string): string[] => gitWorktreeInfo(dir).map((w) => w.path);

const isUnder = (p: string, base: string): boolean => p === base || p.startsWith(base.replace(/\/+$/, "") + path.sep);

/**
 * project の中に作られた worktree (project 自身は含まない) のパス一覧。
 * git に載っているものに加えて、Claude Code が作る .claude/worktrees/ 以下は消された後でも含める。
 */
export function nestedWorktrees(project: string): string[] {
  let real = project;
  try {
    real = fs.realpathSync(project);
  } catch {
    // project がもう無ければそのまま
  }
  const found = new Set<string>([path.join(project, ".claude", "worktrees")]);
  for (const w of gitWorktrees(project)) {
    // git は symlink を解決したパスを返すので、project の綴りに合わせる
    const p = isUnder(w, real) ? project + w.slice(real.length) : w;
    if (p !== project && isUnder(p, project)) found.add(p);
  }
  return [...found];
}

function* iterRecords(file: string): Generator<Json> {
  const text = fs.readFileSync(file, "utf-8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === "object" && !Array.isArray(o)) yield o;
    } catch {
      continue;
    }
  }
}

function fileCwd(file: string): string | null {
  for (const o of iterRecords(file)) {
    if (o.cwd) return o.cwd;
  }
  return null;
}

function isDenial(text: string): boolean {
  return DENIAL_MARKERS.some((m) => text.includes(m));
}

function toolResultText(block: Json): string {
  const c = block.content;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x === "object" ? (x.text ?? "") : "")).join(" ");
  return String(c || "");
}

class Session {
  id: string;
  projectDir: string;
  cost = 0;
  recordedCost = 0; // Claude Code の cost-state (セッション開始からの累計)
  truncated = false; // 集計期間より前の記録を読み飛ばした
  subCost = 0; // subagents/*.jsonl の分 (cost の内数)
  unpricedCalls = 0;
  firstTs: string | null = null;
  lastTs: string | null = null;
  cwd: string | null = null;
  title: string | null = null; // custom-title (人が付けた名前) を ai-title より優先する
  titleIsCustom = false;
  branch: string | null = null;
  main: StateTracker | null = null;
  subs: StateTracker[] = [];

  constructor(id: string, projectDir: string) {
    this.id = id;
    this.projectDir = projectDir;
  }

  touch(ts?: string) {
    if (!ts) return;
    if (this.firstTs === null || ts < this.firstTs) this.firstTs = ts;
    if (this.lastTs === null || ts > this.lastTs) this.lastTs = ts;
  }
}

function listDir(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => !n.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** セッション一覧に出す範囲 (最後に動いてからの時間) と件数 */
const RECENT_HOURS = 24;
const RECENT_MAX = 30;

/** since はログの timestamp と同じ形式 (UTC の ISO 8601、末尾 Z) で渡す。 */
export function collect(
  root: string,
  project: string | null | undefined,
  since: string | null | undefined,
  prices: PriceTable = loadPrices(),
  opts: { excludeWorktrees?: boolean } = {},
): Json {
  let dirs = listDir(root)
    .map((n) => path.join(root, n))
    .filter(isDir);
  if (project) {
    project = path.resolve(expandUser(project));
    // サブディレクトリや worktree のログも同じ接頭辞のディレクトリに入る。
    // foo と foo-bar のような別プロジェクトも拾うので、最後は各ファイルの cwd で判定する。
    const enc = encodeProject(project);
    dirs = dirs.filter((d) => path.basename(d).startsWith(enc));
  }

  // project の中にある worktree は、それ自身を project にしたダッシュボードで見る。二重に数えないよう除外できる。
  const nested = project && opts.excludeWorktrees ? nestedWorktrees(project) : [];
  const excludedSessions = new Set<string>();

  const inProject = (file: string, dirname: string, sid: string): boolean => {
    if (!project) return true;
    const cwd = fileCwd(file);
    if (cwd === null) return dirname === encodeProject(project);
    if (!isUnder(cwd, project)) return false;
    if (nested.some((w) => isUnder(cwd, w))) {
      excludedSessions.add(sid);
      return false;
    }
    return true;
  };

  const sessions = new Map<string, Session>();
  let calls = 0;
  let tokRead = 0;
  let tokAll = 0;
  const toolIds = new Set<string>();
  const results = new Map<string, [boolean, boolean, string | undefined]>(); // tool_use_id -> [is_error, is_denial, 結果の時刻]
  const toolUses = new Map<string, ToolUse>(); // tool_use_id -> 呼び出し (最初の1件)
  const slashCommands: { name: string; ts: string }[] = []; // ユーザーが打ったスラッシュコマンド (/skill-name)
  const modelStats = new Map<string, { calls: number; cost: number; tier: Tier }>();
  let contextMisses = 0;
  let autoContinues = 0;
  let apiErrors = 0;

  for (const d of dirs) {
    // メインのセッションと、その下の subagents/*.jsonl
    const files: [string, string, boolean][] = listDir(d)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => [path.join(d, n), n.replace(/\.jsonl$/, ""), false]);
    for (const sub of listDir(d)) {
      const subagents = path.join(d, sub, "subagents");
      for (const n of listDir(subagents).filter((n) => n.endsWith(".jsonl"))) {
        files.push([path.join(subagents, n), sub, true]);
      }
    }

    for (const [file, sid, isSub] of files) {
      if (!inProject(file, path.basename(d), sid)) continue;
      let sess = sessions.get(sid);
      if (!sess) {
        sess = new Session(sid, path.basename(d));
        sessions.set(sid, sess);
      }
      const seenMsgs = new Map<string, [string, string | undefined, Json]>();
      const tracker = new StateTracker();
      if (isSub) sess.subs.push(tracker);
      else sess.main = tracker;
      for (const o of iterRecords(file)) {
        const ts: string | undefined = o.timestamp;
        if (since && ts && ts < since) {
          sess.truncated = true;
          continue;
        }
        const t = o.type;
        tracker.feed(o);
        if (!isSub) {
          if (t === "custom-title" && o.customTitle) {
            sess.title = String(o.customTitle);
            sess.titleIsCustom = true;
          } else if (t === "ai-title" && o.aiTitle && !sess.titleIsCustom) {
            sess.title = String(o.aiTitle);
          }
          if (o.gitBranch) sess.branch = String(o.gitBranch);
        }
        if (o.cwd && !sess.cwd) sess.cwd = o.cwd;
        if (t === "cost-state") {
          sess.recordedCost = Math.max(sess.recordedCost, o.totalCostUSD || 0);
          continue;
        }
        if (o.isApiErrorMessage) {
          apiErrors++;
          continue;
        }
        if (t === "assistant") {
          sess.touch(ts);
          const m = o.message || {};
          for (const b of m.content || []) {
            if (b && typeof b === "object" && b.type === "tool_use" && b.id) {
              toolIds.add(b.id);
              if (!toolUses.has(b.id)) toolUses.set(b.id, { name: String(b.name), ts: ts || "", sid, sub: isSub, input: b.input || {} });
            }
          }
          const mid = m.id || o.requestId;
          const u = m.usage;
          if (!mid || !u || m.model === "<synthetic>" || seenMsgs.has(mid)) continue;
          seenMsgs.set(mid, [ts || "", m.model, u]);
        } else if (t === "user") {
          sess.touch(ts);
          const m = o.message || {};
          const content = m.content;
          if (Array.isArray(content)) {
            for (const b of content) {
              if (b && typeof b === "object" && b.type === "tool_result" && b.tool_use_id) {
                const err = Boolean(b.is_error);
                results.set(b.tool_use_id, [err, err && isDenial(toolResultText(b)), ts]);
              }
            }
          }
          // /skill-name で起動されたスキル (Skill ツールを通らない)
          const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => b?.text ?? "").join("") : "";
          const cmd = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(text);
          if (cmd && ts) slashCommands.push({ name: cmd[1], ts });
          const origin = o.origin || {};
          const hasToolResult =
            Array.isArray(content) && content.some((b) => b && typeof b === "object" && b.type === "tool_result");
          if (origin.kind && origin.kind !== "human" && !hasToolResult) autoContinues++;
        }
      }

      let prevPrompt: number | null = null;
      const ordered = [...seenMsgs.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      for (const [, model, u] of ordered) {
        calls++;
        const read = u.cache_read_input_tokens ?? 0;
        const prompt = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + read;
        tokRead += read;
        tokAll += prompt;
        if (prevPrompt && read < prevPrompt * CONTEXT_MISS_RATIO) contextMisses++;
        prevPrompt = prompt;
        const c = callCost(prices, model, u);
        if (c === null) sess.unpricedCalls++;
        else {
          sess.cost += c;
          if (isSub) sess.subCost += c;
        }
        const name = (model || "unknown").split("[")[0];
        const ms = modelStats.get(name) ?? { calls: 0, cost: 0, tier: priceFor(prices, model)?.tier ?? "unknown" };
        ms.calls++;
        ms.cost += c ?? 0;
        modelStats.set(name, ms);
      }
    }
  }

  const live = [...sessions.values()].filter((s) => s.lastTs);
  for (const s of live) {
    // cost-state はセッション開始からの累計なので、期間の途中から始まるセッションには使わない
    if (!s.truncated) s.cost = Math.max(s.cost, s.recordedCost);
  }
  // 直近のセッションは、ログとフックの記録の新しいほうで選ぶ (ログは遅れて書かれるので、動いているセッションを見落とさない)
  const hooks = new Map(live.map((s) => [s.id, readHookState(s.id)]));
  const lastOf = (s: Session) => {
    const h = hooks.get(s.id)?.lastAt;
    return h && h > (s.lastTs as string) ? h : (s.lastTs as string);
  };
  let latest: Session | null = null;
  for (const s of live) {
    if (latest === null || lastOf(s) > lastOf(latest)) latest = s;
  }
  let errors = 0;
  let denials = 0;
  for (const tid of toolIds) {
    const r = results.get(tid);
    if (r?.[0] && !r[1]) errors++;
    if (r?.[1]) denials++;
  }

  return {
    scope: project || "all",
    since,
    sessions: live.length,
    cost_total_usd: round4(live.reduce((a, s) => a + s.cost, 0)),
    unpriced_calls: live.reduce((a, s) => a + s.unpricedCalls, 0),
    latest_session:
      latest === null
        ? null
        : {
            id: latest.id,
            cost_usd: round4(latest.cost),
            started_at: latest.firstTs,
            last_at: lastOf(latest),
            cwd: latest.cwd,
            title: latest.title,
            branch: latest.branch,
            state: sessionState(latest.main, latest.subs, hooks.get(latest.id) ?? null),
          },
    models: [...modelStats.entries()]
      .map(([model, v]) => ({ model, calls: v.calls, cost_usd: round4(v.cost), tier: v.tier }))
      .sort((a, b) => b.cost_usd - a.cost_usd || b.calls - a.calls),
    subagent_cost_usd: round4(live.reduce((a, s) => a + s.subCost, 0)),
    ...summarizeActivity({
      toolUses,
      results,
      slashCommands,
      latestSessionId: latest?.id ?? null,
      latestLastTs: latest?.lastTs ?? null,
      now: Date.now(),
    }),
    // 並行して動くセッション。ヘッダーの直近の1つだけでは、それより前から止まっているセッションが隠れる
    recent_sessions: live
      .filter((s) => Date.now() - Date.parse(lastOf(s)) < RECENT_HOURS * 3600 * 1000)
      .sort((a, b) => lastOf(b).localeCompare(lastOf(a)))
      .slice(0, RECENT_MAX)
      .map((s) => ({
        id: s.id,
        title: s.title,
        branch: s.branch,
        cwd: s.cwd,
        last_at: lastOf(s),
        cost_usd: round4(s.cost),
        state: sessionState(s.main, s.subs, hooks.get(s.id) ?? null),
      })),
    api_calls: calls,
    cache_read_rate: tokAll ? round4(tokRead / tokAll) : null,
    tool_calls: toolIds.size,
    tool_errors: errors,
    context_misses: contextMisses,
    auto_continues: autoContinues,
    denials,
    api_errors: apiErrors,
    prices_updated_at: prices.updatedAt,
    exclude_worktrees: Boolean(opts.excludeWorktrees),
    excluded_worktree_sessions: excludedSessions.size,
    collected_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  };
}

export function sinceDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400 * 1000).toISOString();
}

function main(): number {
  const { values: a } = parseArgs({
    options: {
      root: { type: "string", default: path.join(configDir(), "projects") },
      project: { type: "string" },
      days: { type: "string" },
      out: { type: "string" },
      prices: { type: "string" },
      "exclude-worktrees": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (a.help) {
    console.log(
      "usage: node collect.ts [--root DIR] [--project PATH] [--days N] [--out FILE] [--prices FILE] [--exclude-worktrees]\n" +
        "  --project  このパスのプロジェクト (サブディレクトリと worktree を含む) だけを集計する\n" +
        "  --days     直近この日数だけを集計する (省略時は cleanupPeriodDays)\n" +
        "  --exclude-worktrees  --project の中にある worktree のセッションを除く\n" +
        "  --prices   料金表 (省略時は同梱の prices.json)\n" +
        "  --out      書き出し先 (省略時は標準出力)",
    );
    return 0;
  }
  const project = a.project ? expandUser(a.project) : null;
  const [days, source]: [number, string | null] = a.days
    ? [Number.parseInt(a.days, 10), "--days"]
    : cleanupPeriodDays(project);
  const m = collect(expandUser(a.root as string), a.project ?? null, sinceDaysAgo(days), loadPrices(a.prices), {
    excludeWorktrees: a["exclude-worktrees"],
  });
  m.days = days;
  m.days_source = source;
  const text = JSON.stringify(m, null, 2);
  if (a.out) fs.writeFileSync(a.out, text + "\n", "utf-8");
  else console.log(text);
  return 0;
}

// dashboard.ts から import された時は動かさない
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  process.exitCode = main();
}
