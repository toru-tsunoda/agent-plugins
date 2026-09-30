#!/usr/bin/env node
/**
 * 作業ダッシュボード: .dev/glass-cockpit/dashboard.json (タスクと質問) とセッションログの指標から、ダッシュボードの HTML を作る。
 *
 *   node dashboard.ts init     # カレントディレクトリに .dev/glass-cockpit/dashboard.json を作る
 *   node dashboard.ts build    # .dev/glass-cockpit/dashboard.html を書き出す
 *   node dashboard.ts serve    # http://127.0.0.1:8765 で開く。開くたびに集計し直し、30秒ごとに再読み込み
 *
 * dashboard.json は AI が作業しながら書き換える前提 (タスクの状態、質問の追加、回答の記入)。
 * 料金表は dashboard.json の隣の prices.json (init が同梱のものをコピーする。無ければ同梱のものを使う)。
 * 指標は dashboard.json の project のプロジェクト (サブディレクトリと worktree を含む) だけを、
 * cleanupPeriodDays の日数 (既定30日) 以内で集計する。project の相対パスは dashboard.json の場所から解決する。
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { cleanupPeriodDays, collect, configDir, currentBranch, expandUser, loadPrices, sinceDaysAgo } from "./collect.ts";
import { initDashboard, pricesPathFor } from "./init.ts";
import { DASHBOARD_DIR } from "./paths.ts";
import { worktreeRows, type WorktreeRow } from "./worktrees.ts";

type Json = Record<string, any>;

const DEFAULT_DASHBOARD = path.join(DASHBOARD_DIR, "dashboard.json");
const STATUS_ORDER: Record<string, number> = { doing: 0, blocked: 1, todo: 2, done: 3, dropped: 4 };
const TODO_VISIBLE = 10; // todo はこの件数だけ表に出し、残りは折りたたむ
const URGENCY_CLASS: Record<string, string> = { 高: "crit", 中: "warn", 低: "", high: "crit", mid: "warn", low: "" };

const CSS = `
/* 一画面の運用盤: 上に8枚の指標タイル、下にタスクと質問の表。スマホでは2列→1列に畳む */
:root {
  --bg: #f3f4f6; --tile: #ffffff; --line: #dfe2e7; --ink: #1b1f24; --muted: #5f6873;
  --accent: #2f5bd3; --track: #e6e8ec; --ok: #2f7a4b; --warn: #a86a00; --crit: #b3261e;
  --sans: "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif;
  --mono: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121418; --tile: #1b1e24; --line: #2c313a; --ink: #e6e8eb; --muted: #9aa3ad;
    --accent: #7d9cff; --track: #2c313a; --ok: #6fcf97; --warn: #e0a94a; --crit: #ff7a6e;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.6 var(--sans); }
main { max-width: 1200px; margin: 0 auto; padding-inline: 16px; padding-block: 20px 40px; display: grid; gap: 28px; }
header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 16px; }
h1 { margin: 0; font-size: 20px; }
h2 { margin: 0 0 10px; font-size: 17px; }
.meta { color: var(--muted); font-size: 13px; }
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 900px) { .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 420px) { .tiles { grid-template-columns: minmax(0, 1fr); } }
.tile { background: var(--tile); border: 1px solid var(--line); border-radius: 10px; padding: 14px 18px 16px; display: grid; gap: 2px; align-content: start; }
.label { color: var(--muted); font-size: 13px; }
.value { font-size: 30px; font-weight: 700; line-height: 1.25; font-variant-numeric: tabular-nums; }
.sub { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.value.warn, .sub.warn { color: var(--warn); } .value.crit { color: var(--crit); }
.bar { height: 6px; background: var(--track); border-radius: 3px; overflow: hidden; margin-top: 8px; }
.bar > i { display: block; height: 100%; background: var(--accent); }
.bar > i.warn { background: var(--warn); } .bar > i.crit { background: var(--crit); }
.table { background: var(--tile); border: 1px solid var(--line); border-radius: 10px; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px 16px; border-top: 1px solid var(--line); vertical-align: top; }
thead th { border-top: 0; color: var(--muted); font-size: 13px; font-weight: 600; white-space: nowrap; }
td.id { font-family: var(--mono); font-size: 14px; white-space: nowrap; }
td.pill-cell { white-space: nowrap; }
td.empty { color: var(--muted); }
.pill { display: inline-block; padding: 0 8px; border: 1px solid var(--line); border-radius: 6px; font-size: 13px; line-height: 22px; }
.pill.doing { color: var(--accent); border-color: currentColor; }
.pill.done { color: var(--ok); }
.pill.blocked, .pill.crit { color: var(--crit); border-color: currentColor; }
.pill.warn { color: var(--warn); border-color: currentColor; }
tr.done td:not(.pill-cell) { color: var(--muted); }
details { margin-top: 10px; color: var(--muted); font-size: 14px; }
summary { cursor: pointer; }
details dl { margin: 8px 0 0; display: grid; gap: 8px; }
details dt { color: var(--ink); } details dd { margin: 0 0 0 1em; }
.task-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 16px; margin-bottom: 10px; }
.task-head h2 { margin: 0; }
input[type=search] { font: inherit; font-size: 14px; color: var(--ink); background: var(--tile); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; min-width: 200px; max-width: 100%; }
.table + details, details + details { margin-top: 10px; }
details > .table { margin-top: 8px; }
tr.dropped td:not(.pill-cell):not(.act) { color: var(--muted); text-decoration: line-through; }
.pill.dropped { color: var(--muted); }
td.act { white-space: nowrap; text-align: right; }
button { font: inherit; font-size: 13px; color: var(--ink); background: var(--tile); border: 1px solid var(--line); border-radius: 6px; padding: 0 10px; line-height: 22px; cursor: pointer; }
button:hover { border-color: var(--crit); color: var(--crit); }
button.restore:hover { border-color: var(--accent); color: var(--accent); }
details.fold-section { margin-top: 0; color: var(--ink); font-size: 15px; }
details.fold-section > summary { font-size: 13px; font-weight: 600; color: var(--muted); }
details.fold-section > summary .hint { font-weight: 400; margin-left: 8px; }
details.fold-section > summary .hint.warn { color: var(--warn); }
details.fold-section > summary .hint.crit { color: var(--crit); }
details.fold-section > .tiles { margin-top: 12px; }
.tile.wide { grid-column: span 3; }
@media (max-width: 900px) { .tile.wide { grid-column: 1 / -1; } }
.value.small { font-size: 22px; overflow-wrap: anywhere; }
.gates { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.gate { border: 1px solid var(--line); border-radius: 6px; padding: 2px 10px; font-size: 14px; color: var(--muted); }
.gate.ok { color: var(--ok); border-color: currentColor; }
.wt-cur { color: var(--accent); font-size: 13px; margin-left: 6px; }
.wt-sub { color: var(--muted); font-size: 13px; font-family: var(--mono); }
.wt-sub.stale { color: var(--warn); font-family: var(--sans); }
td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.status { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; background: var(--tile); border: 1px solid var(--line); border-left: 6px solid var(--muted); border-radius: 10px; padding: 12px 16px; }
.status strong { font-size: 20px; color: var(--muted); }
.status .since { color: var(--muted); font-variant-numeric: tabular-nums; }
.status .detail { flex-basis: 100%; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.status.ok { border-left-color: var(--ok); } .status.ok strong { color: var(--ok); }
.status.attn { border-left-color: var(--accent); } .status.attn strong { color: var(--accent); }
.status.warn { border-left-color: var(--warn); } .status.warn strong { color: var(--warn); }
.status.crit { border-left-color: var(--crit); } .status.crit strong { color: var(--crit); }
.status .others { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; margin-top: 4px; font-size: 13px; color: var(--muted); }
.pill.ok { color: var(--ok); border-color: currentColor; }
.pill.attn { color: var(--accent); border-color: currentColor; }
td.when { white-space: nowrap; font-variant-numeric: tabular-nums; }
.error { color: var(--crit); background: var(--tile); border: 1px solid var(--crit); border-radius: 10px; padding: 12px 16px; }
`;

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const usd = (x: number): string =>
  "$" + x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const pct = (x: number | null): string => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);

function localTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const level = (ratio: number): string => (ratio >= 1 ? "crit" : ratio >= 0.8 ? "warn" : "");

/** note は sub の下に足す1行 ([文言, 色のクラス]) */
function tile(label: string, value: string, sub = "", valueCls = "", bar: number | null = null, note: [string, string] | null = null): string {
  const barHtml =
    bar === null
      ? ""
      : `<div class="bar"><i class="${level(bar)}" style="width:${(Math.min(bar, 1) * 100).toFixed(1)}%"></i></div>`;
  return (
    `<section class="tile"><div class="label">${esc(label)}</div>` +
    `<div class="value ${valueCls}">${esc(value)}</div>` +
    `<div class="sub">${esc(sub)}</div>${note ? `<div class="sub ${note[1]}">${esc(note[0])}</div>` : ""}${barHtml}</section>`
  );
}

/** dashboard.json が最後の動きからこれ以上更新されていなければ、タスクが古いかもしれないと知らせる */
const STALE_SEC = 3600;

/** dashboard.json の更新時刻が、最後の動き (ログ) からどれだけ遅れているか。lagSec は、動きの後に更新していれば 0 */
function staleness(updatedAt: string | null, lastActivity: string | null): { lagSec: number; cls: string } | null {
  if (!updatedAt || !lastActivity) return null;
  const lagSec = Math.max(0, (Date.parse(lastActivity) - Date.parse(updatedAt)) / 1000);
  return { lagSec, cls: lagSec >= STALE_SEC ? "warn" : "" };
}

function mtimeIso(file: string): string | null {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

/** 秒を「45秒」「12分」「3時間5分」の形にする */
function dur(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s}秒`;
  // 分に丸めてから時間に分ける (3599秒を「60分」、3時間の手前を「2時間60分」にしない)
  const total = Math.round(s / 60);
  if (total < 60) return `${total}分`;
  const h = Math.floor(total / 60);
  const min = total % 60;
  return min ? `${h}時間${min}分` : `${h}時間`;
}

/** 長く動いて普通のツール。それ以外 (Read・Edit など) は数十秒で終わるはずなので、早めに注意を出す */
const LONG_TOOLS = /^(Bash|Agent|Task|Skill|WebFetch|WebSearch|mcp__)/;

interface StatusView {
  label: string;
  cls: "ok" | "attn" | "warn" | "crit" | "";
  sinceSec: number | null;
  note: string;
}

/** 今の状態を、人が次にすべきことが分かる言葉と色にする */
function statusView(st: Json | undefined, now: number): StatusView {
  const kind: string = st?.kind ?? "none";
  const sinceSec = st?.since ? Math.max(0, (now - Date.parse(st.since)) / 1000) : null;
  const t = sinceSec ?? 0;
  const tool = st?.tool ? `${st.tool.name}${st.tool.detail ? ` — ${st.tool.detail}` : ""}` : "";
  const bg = st?.background ? `サブエージェント ${st.background} 件が実行中` : "";
  const estimated = st?.source === "estimate";
  const v = (label: string, cls: StatusView["cls"], note = ""): StatusView => ({ label, cls, sinceSec, note });
  switch (kind) {
    case "question":
      return v("質問に回答待ち", "warn", tool);
    case "permission":
      return v("権限の確認待ち", "warn", [tool, "承認済みなら実行中"].filter(Boolean).join(" · "));
    case "tool": {
      const [w, c] = LONG_TOOLS.test(st?.tool?.name ?? "") ? [900, 1800] : [60, 300];
      const note = [tool, estimated ? "フックの記録が無いため、ログから推定。権限の確認待ちかもしれない" : ""].filter(Boolean).join(" · ");
      if (t > c) return v("実行中のまま応答なし", "crit", note);
      if (t > w) return v(estimated ? "実行中?（長い）" : "実行中（長い）", "warn", note);
      return v(estimated ? "実行中?" : "実行中", "ok", note);
    }
    case "thinking": {
      const note = [bg, estimated ? "フックの記録が無いため、ログから推定" : ""].filter(Boolean).join(" · ");
      if (t > 900) return v("応答がなく、止まっている可能性", "crit", note);
      if (t > 300) return v("応答を待っている（長い）", "warn", note);
      return v("応答を生成中", "ok", note);
    }
    case "idle":
      return v("入力待ち（ターン終了）", "attn", bg);
    case "interrupted":
      return v("中断（入力待ち）", "attn", bg);
    case "api_error":
      return v("API エラーで停止", "crit");
    case "ended":
      return v("終了", "");
    default:
      return v("セッションなし", "");
  }
}

/** 人が次にすべきことの緊急度。一覧は、これの高い順に並べる */
const URGENCY: Record<string, number> = { crit: 4, warn: 3, attn: 2, ok: 1, "": 0 };

/** 一覧やヘッダーの件数に使う、状態の短い名前 */
function shortLabel(st: Json | undefined, v: StatusView): string {
  const kind = st?.kind ?? "none";
  if (kind === "question") return "回答待ち";
  if (kind === "permission") return "権限待ち";
  if (kind === "api_error") return "API エラー";
  if (kind === "idle" || kind === "interrupted") return "入力待ち";
  if (kind === "ended") return "終了";
  if (v.cls === "crit") return "止まっている可能性";
  if (v.cls === "warn") return "長く動いている";
  if (kind === "tool" || kind === "thinking") return "実行中";
  return "不明";
}

const sessionLabel = (x: Json): string => x.title || String(x.id ?? "").slice(0, 8) || "—";

/** ヘッダーの帯に添える、ほかのセッションの状態の件数。終わったセッションは数えない */
function othersChips(sessions: Json[], latestId: string | undefined, now: number): string {
  const groups = new Map<string, { n: number; cls: StatusView["cls"] }>();
  for (const x of sessions) {
    if (x.id === latestId || x.state?.kind === "ended" || x.state?.kind === "none") continue;
    const v = statusView(x.state, now);
    const k = shortLabel(x.state, v);
    const g = groups.get(k) ?? { n: 0, cls: v.cls };
    g.n++;
    groups.set(k, g);
  }
  if (!groups.size) return "";
  const chips = [...groups.entries()]
    .sort((a, b) => URGENCY[b[1].cls] - URGENCY[a[1].cls])
    .map(([k, g]) => `<span class="pill ${g.cls}">${esc(k)} ${g.n}</span>`)
    .join("");
  return `<span class="others">ほかのセッション ${chips}</span>`;
}

/** 直近 24 時間に動いたセッションの一覧。人の操作が要るものを先に、同じなら新しい順に並べる */
function sessionsSection(sessions: Json[], latestId: string | undefined, project: string | null, now: number): string {
  if (sessions.length < 2) return "";
  const rows = sessions
    .map((x) => ({ x, v: statusView(x.state, now) }))
    .sort((a, b) => URGENCY[b.v.cls] - URGENCY[a.v.cls] || String(b.x.last_at).localeCompare(String(a.x.last_at)));
  const counts = new Map<string, { n: number; cls: StatusView["cls"] }>();
  for (const { x, v } of rows) {
    const k = shortLabel(x.state, v);
    const g = counts.get(k) ?? { n: 0, cls: v.cls };
    g.n++;
    counts.set(k, g);
  }
  const hints = [...counts.entries()]
    .sort((a, b) => URGENCY[b[1].cls] - URGENCY[a[1].cls])
    .map(([k, g]) => `<span class="hint ${g.cls === "crit" || g.cls === "warn" ? g.cls : ""}">${esc(k)} ${g.n}</span>`)
    .join("");
  const where = (cwd?: string | null) => {
    if (!cwd) return "";
    if (project && cwd === project) return ".";
    if (project && cwd.startsWith(project + path.sep)) return cwd.slice(project.length + 1);
    return cwd.replace(os.homedir(), "~");
  };
  const body = rows
    .map(({ x, v }) => {
      const st = x.state ?? {};
      const tool = st.tool ? `${st.tool.name}${st.tool.detail ? ` — ${st.tool.detail}` : ""}` : "";
      const bg = st.background ? `サブエージェント ${st.background} 件` : "";
      return (
        `<tr><td class="pill-cell"><span class="pill ${v.cls}">${esc(shortLabel(st, v))}</span>${st.source === "estimate" && (st.kind === "tool" || st.kind === "thinking") ? " ?" : ""}</td>` +
        `<td>${esc(sessionLabel(x))}${x.id === latestId ? '<span class="wt-cur">◀ ヘッダー</span>' : ""}` +
        `<div class="wt-sub">${x.title ? esc(String(x.id).slice(0, 8)) : ""}${x.branch && x.branch !== "HEAD" ? ` · ${esc(x.branch)}` : ""}${where(x.cwd) && where(x.cwd) !== "." ? ` · ${esc(where(x.cwd))}` : ""}</div></td>` +
        `<td class="when">${v.sinceSec === null ? "—" : `${dur(v.sinceSec)}前から`}</td>` +
        `<td>${esc([tool, bg].filter(Boolean).join(" · "))}</td>` +
        `<td class="num">${usd(x.cost_usd ?? 0)}</td></tr>`
      );
    })
    .join("");
  return (
    `<details class="fold-section" data-persist="sessions"><summary>セッション（直近 24 時間）<span class="hint">${sessions.length} 件</span>${hints}</summary>` +
    `<div class="table" style="margin-top:12px"><table><thead><tr><th>状態</th><th>セッション</th><th>いつから</th><th>ツール</th><th>費用</th></tr></thead>` +
    `<tbody>${body}</tbody></table></div></details>`
  );
}

/** レビューゲート: 作業が進む前に通したい手順。dashboard.json の gates で差し替えられる。 */
const DEFAULT_GATES = [
  { label: "Codex/subagent に相談", skills: ["codex-consultation", "subagent-consultation"] },
  { label: "対話コンテキスト export", skills: ["conversation-context-export"] },
  { label: "sanity-review", skills: ["sanity-review"] },
];

/** dashboard.json の created_at を、ログの timestamp と比べられる形 (UTC の ISO 8601) にする。無い・不正なら null */
function createdAt(dashboard: Json): string | null {
  const d = new Date(dashboard.created_at ?? NaN);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function gatesTile(gates: Json[], skills: Record<string, { count: number; last_at: string }>, scope: Json): string {
  const chips = gates
    .map((g) => {
      const hits = (g.skills || []).map((k: string) => skills[k]).filter(Boolean);
      const count = hits.reduce((a: number, h: { count: number }) => a + h.count, 0);
      const last = hits.map((h: { last_at: string }) => h.last_at).sort().pop();
      return count
        ? `<span class="gate ok">✓ ${esc(g.label)} ${count} 回（最後 ${esc(localTime(last))}）</span>`
        : `<span class="gate">– ${esc(g.label)} 未実施</span>`;
    })
    .join("");
  const range = [scope?.branch ? `ブランチ ${scope.branch}` : "", scope?.since ? `${localTime(scope.since)} 以降` : ""].filter(Boolean);
  const label = `レビューゲート（スキル実行: ${range.length ? range.join(" · ") : "この期間"}）`;
  return `<section class="tile wide"><div class="label">${esc(label)}</div><div class="gates">${chips}</div></section>`;
}

function worktreeSection(rows: WorktreeRow[]): string {
  if (!rows.length) return "";
  const total = rows.reduce((a, w) => a + w.cost_usd, 0);
  const doing = rows.reduce((a, w) => a + (w.tasks?.doing ?? 0), 0);
  const openQs = rows.reduce((a, w) => a + (w.tasks?.openQuestions ?? 0), 0);
  const hints = [`${rows.length} 件`, `合計 ${usd(total)}`, `進行中 ${doing}`];
  const hintHtml =
    hints.map((t) => `<span class="hint">${esc(t)}</span>`).join("") +
    (openQs ? `<span class="hint warn">未回答の質問 ${openQs}</span>` : "");
  const body = rows
    .map((w) => {
      const name = w.branch ?? "(detached)";
      const tasks = w.tasks
        ? `${w.tasks.done} / ${w.tasks.total}${w.tasks.doing ? ` · doing ${w.tasks.doing}` : ""}`
        : w.prunable
          ? "ディレクトリなし"
          : "ダッシュボードなし";
      const qs = w.tasks ? (w.tasks.openQuestions ? `<span class="pill warn">${w.tasks.openQuestions}</span>` : "0") : "—";
      const fresh = staleness(w.tasks?.updatedAt ?? null, w.last_activity_at);
      const staleHtml = fresh?.cls ? `<div class="wt-sub stale">最後の動きより${esc(dur(fresh.lagSec))}古い</div>` : "";
      return (
        `<tr><td>${esc(name)}${w.isMain ? " (main)" : ""}${w.isCurrent ? '<span class="wt-cur">◀ この画面</span>' : ""}` +
        `<div class="wt-sub">${esc(w.where)}</div></td>` +
        `<td class="pill-cell">${w.state && w.state.kind !== "none" ? (() => { const v = statusView(w.state, Date.now()); return `<span class="pill ${v.cls}">${esc(shortLabel(w.state, v))}</span>`; })() : "—"}</td>` +
        `<td class="num">${usd(w.cost_usd)}</td><td class="num">${w.sessions}</td>` +
        `<td class="num">${w.last_at ? `${esc(localTime(w.last_at))}（${dur((Date.now() - Date.parse(w.last_at)) / 1000)}前）` : "—"}</td>` +
        `<td>${esc(tasks)}${staleHtml}</td><td>${qs}</td></tr>`
      );
    })
    .join("");
  return (
    `<details class="fold-section" data-persist="worktrees"><summary>worktree${hintHtml}</summary>` +
    `<div class="table" style="margin-top:12px"><table><thead><tr><th>ブランチ</th><th>状態</th><th>費用</th><th>セッション</th><th>最後の動き</th><th>タスク</th><th>質問</th></tr></thead>` +
    `<tbody>${body}</tbody></table></div></details>`
  );
}

function taskRow(t: Json, interactive: boolean): string {
  const status = String(t.status ?? "");
  const act = !interactive
    ? ""
    : status === "dropped"
      ? `<td class="act"><button class="restore" data-id="${esc(t.id)}" data-to="todo">戻す</button></td>`
      : status === "done"
        ? '<td class="act"></td>'
        : `<td class="act"><button data-id="${esc(t.id)}" data-to="dropped">やめる</button></td>`;
  const hay = esc(`${t.id} ${status} ${t.title ?? ""} ${t.blocker ?? ""}`.toLowerCase());
  return (
    `<tr class="${esc(status)}" data-task="${hay}"><td class="id">${esc(t.id)}</td>` +
    `<td class="pill-cell"><span class="pill ${esc(status)}">${esc(status)}</span></td>` +
    `<td>${esc(t.title)}</td><td>${esc(t.blocker)}</td>${act}</tr>`
  );
}

function taskTable(rows: Json[], interactive: boolean): string {
  const head = `<th>ID</th><th>状態</th><th>題</th><th>blocker</th>${interactive ? "<th></th>" : ""}`;
  const body = rows.map((t) => taskRow(t, interactive)).join("");
  return `<div class="table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const folded = (key: string, label: string, rows: Json[], interactive: boolean): string =>
  rows.length ? `<details data-key="${key}"><summary>${label} ${rows.length} 件</summary>${taskTable(rows, interactive)}</details>` : "";

// 絞り込み・折りたたみの状態保持・自動更新・タスクの消し込みボタン
const SCRIPT = `
const q = document.getElementById("q");
const store = { get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
                set(k, v) { try { sessionStorage.setItem(k, v); } catch {} } };
const details = [...document.querySelectorAll("details[data-key]")];
function apply() {
  const v = q.value.trim().toLowerCase();
  document.querySelectorAll("tr[data-task]").forEach((tr) => { tr.hidden = Boolean(v) && !tr.dataset.task.includes(v); });
  for (const d of details) {
    if (v) { d.hidden = !d.querySelector("tr[data-task]:not([hidden])"); d.open = !d.hidden; }
    else { d.hidden = false; d.open = store.get("open:" + d.dataset.key) === "1"; }
  }
}
for (const d of document.querySelectorAll("details[data-persist]")) {
  if (store.get("open:" + d.dataset.persist) === "1") d.open = true;
  d.addEventListener("toggle", () => store.set("open:" + d.dataset.persist, d.open ? "1" : "0"));
}
for (const d of details) d.addEventListener("toggle", () => { if (!q.value.trim()) store.set("open:" + d.dataset.key, d.open ? "1" : "0"); });
q.addEventListener("input", apply);
apply();
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-id]");
  if (!b) return;
  const drop = b.dataset.to === "dropped";
  if (drop && !confirm(b.dataset.id + " をやらないことにしますか？（あとで戻せます）")) return;
  const res = await fetch("/api/task", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: b.dataset.id, status: b.dataset.to }) });
  if (res.ok) location.reload(); else alert("更新できませんでした: " + (await res.text()));
});
const REFRESH = __REFRESH__;
if (REFRESH) setInterval(() => { if (!q.value.trim() && document.activeElement !== q) location.reload(); }, REFRESH * 1000);
`;

function render(dashboardPath: string, refresh?: number, interactive = false): string {
  const errors: string[] = [];
  let dashboard: Json = {};
  try {
    dashboard = JSON.parse(fs.readFileSync(dashboardPath, "utf-8"));
  } catch (e) {
    errors.push(`${dashboardPath} を読めません: ${(e as Error).message}`);
  }

  let project: string | null = dashboard.project || null;
  if (project) {
    project = path.normalize(path.join(path.dirname(path.resolve(dashboardPath)), expandUser(project)));
  }
  const [days, daysSource] = cleanupPeriodDays(project);
  const prices = loadPrices(pricesPathFor(dashboardPath));
  const excludeWorktrees = dashboard.exclude_worktrees !== false;
  // レビューゲートは今の作業の分だけ数える: 今のブランチで、ダッシュボードを作った後に実行したスキル
  const gates = { branch: project ? currentBranch(project) : null, since: createdAt(dashboard) };
  const m = collect(path.join(configDir(), "projects"), project, sinceDaysAgo(days), prices, { excludeWorktrees, gates });

  const worktrees = worktreeRows({
    project,
    root: path.join(configDir(), "projects"),
    since: sinceDaysAgo(days),
    prices,
    current: m,
    currentExcludesWorktrees: excludeWorktrees,
  });

  const costCap: number = dashboard.cost_cap_usd || 0;
  const sessionCap: number = dashboard.session_cap_usd || 0;
  const latest: Json = m.latest_session || {};
  const tasks: Json[] = dashboard.tasks || [];
  const questions: Json[] = dashboard.questions || [];
  const openQs = questions.filter((q) => !q.answer);
  const answered = questions.filter((q) => q.answer);
  const counts: Record<string, number> = {};
  for (const s of Object.keys(STATUS_ORDER)) counts[s] = tasks.filter((t) => t.status === s).length;
  const taskSub = ["done", "doing", "blocked", "todo", "dropped"]
    .filter((s) => (s !== "blocked" && s !== "dropped") || counts[s])
    .map((s) => `${s === "dropped" ? "やらない" : s} ${counts[s]}`)
    .join(" · ");
  const errRate = m.tool_calls ? m.tool_errors / m.tool_calls : null;
  const expected: Json = m.context_misses_expected ?? {};
  const latestMisses: number = m.latest_session?.context_misses ?? 0;
  const retention = `cleanupPeriodDays ${days}` + (daysSource === null ? "（既定値）" : "");
  const costSub = (costCap ? `上限 ${usd(costCap)} · ` : "") + retention;
  const n = (x: number) => x.toLocaleString("en-US");
  const latestId: string = (latest.id || "—").slice(0, 8);
  // タスクの鮮度: AI が動いた後に dashboard.json を更新していなければ、表のタスクは古いかもしれない
  const updatedAt = mtimeIso(dashboardPath);
  const fresh = staleness(updatedAt, m.last_activity_at);
  const freshNote: [string, string] | null = updatedAt
    ? [
        `dashboard.json 更新 ${localTime(updatedAt)}` +
          (fresh === null ? "" : fresh.lagSec < 60 ? "（最新）" : ` · 最後の動きより${dur(fresh.lagSec)}古い`),
        fresh?.cls ?? "",
      ]
    : null;

  const tiles = [
    tile(`費用（API 換算、${days}日以内）`, usd(m.cost_total_usd), costSub, "", costCap ? m.cost_total_usd / costCap : null),
    tile(
      "直近のセッション",
      usd(latest.cost_usd ?? 0),
      sessionCap ? `${latestId} 上限 ${usd(sessionCap)}` : latestId,
      "",
      sessionCap ? (latest.cost_usd ?? 0) / sessionCap : null,
    ),
    tile("キャッシュ読み込み率", pct(m.cache_read_rate), `${n(m.api_calls)} 回の呼び出し（トークン加重）`),
    tile("ツールのエラー率", pct(errRate), `${n(m.tool_errors)} / ${n(m.tool_calls)} 件`, "", null, [
      `Bash の終了コード 0 以外 ${n(m.bash_nonzero_exits ?? 0)} 件は除く`,
      "",
    ]),
    // 想定外の読み落としだけを数え、色は直近のセッションで起きた時だけ付ける (30日の累計で常に赤くしない)
    tile(
      "文脈の読み落とし",
      n(m.context_misses),
      `キャッシュ切れ ${n(expected.cache_expired ?? 0)} · モデル変更 ${n(expected.model_changed ?? 0)} · 縮小 ${n(expected.context_shrunk ?? 0)} は除く`,
      latestMisses ? "warn" : "",
      null,
      latestMisses ? [`直近のセッションで ${n(latestMisses)} 回`, "warn"] : null,
    ),
    tile("自動続行", n(m.auto_continues), `拒否 ${n(m.denials)} · API エラー ${n(m.api_errors)}`),
    tile("タスク", `${counts.done} / ${tasks.length - counts.dropped}`, taskSub, "", null, freshNote),
    tile("未回答の質問", String(openQs.length), `回答済み ${answered.length}`, openQs.length ? "warn" : ""),
  ];

  const act: Json = m.activity ?? {};
  const waits: Json = m.user_waits ?? {};
  const codex: Json = m.codex ?? {};
  const sub: Json = m.subagents ?? {};
  const models: Json[] = m.models ?? [];
  const lastTool = act.last_tool ? `${act.last_tool.name}${act.last_tool.detail ? ` — ${act.last_tool.detail}` : ""}` : "—";
  const status = statusView(latest.state, Date.now());
  const lastToolTile = tile("最後のツール", act.last_tool?.name ?? "—", act.last_tool ? `${localTime(act.last_tool.at)} · ${act.last_tool.detail || "—"}` : "", "small");
  const subTypes = Object.entries(sub.by_type ?? {}).map(([k, v]) => `${k} ${v}`).join(" · ");
  const subShare = m.cost_total_usd ? Math.round((m.subagent_cost_usd / m.cost_total_usd) * 100) : 0;
  // Opus 未満は、メインのエージェントとサブエージェントに分ける。Explore などのサブエージェントが Haiku を使うのは普通なので、
  // 警告は直近のセッションのメインのエージェントが今 Opus 未満で動いている時だけにする
  const low = models.filter((x) => x.tier === "low");
  const lowSub = low.reduce((a, x) => a + (x.sub_calls ?? 0), 0);
  const lowMain = low.reduce((a, x) => a + x.calls, 0) - lowSub;
  const latestLow = latest.model_tier === "low";
  // 閉じていても見える要約。異常（直近のセッションが Opus 未満・Codex 失敗）だけ色を付ける。今の状態はヘッダーに出す
  const hints: [string, string][] = [
    [`サブエージェント ${n(sub.calls ?? 0)}`, ""],
    [`Codex ${n(codex.runs ?? 0)}${codex.failures ? `（失敗 ${n(codex.failures)}）` : ""}`, codex.failures ? "warn" : ""],
  ];
  if (latestLow) hints.push([`直近のセッションが Opus 未満（${latest.model}）`, "warn"]);
  const activitySummary = hints.map(([t, c]) => `<span class="hint ${c}">${esc(t)}</span>`).join("");
  const activityTiles = [
    lastToolTile,
    tile("人を待った時間", dur(waits.total_sec ?? 0), `質問 ${n(waits.asks ?? 0)} 回 · 最長 ${dur(waits.max_sec ?? 0)}`),
    tile("サブエージェント", `${n(sub.calls ?? 0)} 回`, `${subTypes || "なし"} · 費用 ${usd(m.subagent_cost_usd ?? 0)}（${subShare}%）`),
    tile(
      "Codex の実行",
      `${n(codex.runs ?? 0)} 回`,
      `失敗 ${n(codex.failures ?? 0)} · 最長 ${dur(codex.longest_sec ?? 0)}`,
      codex.failures ? "warn" : "",
    ),
    tile(
      "モデル（直近のセッション）",
      latest.model ?? "—",
      `Opus 未満: メイン ${n(lowMain)} 回 · サブエージェント ${n(lowSub)} 回`,
      latestLow ? "small warn" : "small",
    ),
    gatesTile(Array.isArray(dashboard.gates) ? dashboard.gates : DEFAULT_GATES, m.skills ?? {}, m.skills_scope),
  ];

  // 進行中 → todo（先頭だけ）→ 残りの todo・完了・やらない（折りたたみ）
  const byStatus = (f: (st: string) => boolean) => tasks.filter((t) => f(String(t.status ?? "")));
  const active = byStatus((st) => st === "doing").concat(byStatus((st) => st === "blocked"));
  const todo = byStatus((st) => !(st in STATUS_ORDER) || st === "todo");
  const done = byStatus((st) => st === "done");
  const dropped = byStatus((st) => st === "dropped");
  const shown = [...active, ...todo.slice(0, TODO_VISIBLE)];
  const taskHtml =
    (shown.length ? taskTable(shown, interactive) : '<div class="table"><table><tbody><tr><td class="empty">なし</td></tr></tbody></table></div>') +
    folded("todo-rest", "残りの todo", todo.slice(TODO_VISIBLE), interactive) +
    folded("done", "完了", done, interactive) +
    folded("dropped", "やらない", dropped, interactive);

  const qRows =
    openQs
      .map(
        (q) =>
          `<tr><td class="id">${esc(q.id)}</td>` +
          `<td class="pill-cell"><span class="pill ${URGENCY_CLASS[q.urgency] ?? ""}">${esc(q.urgency)}</span></td>` +
          `<td>${esc(q.question)}</td><td>${esc(q.default)}</td></tr>`,
      )
      .join("") || '<tr><td class="empty" colspan="4">なし</td></tr>';

  let answeredHtml = "";
  if (answered.length) {
    const items = answered.map((q) => `<dt>${esc(q.id)} ${esc(q.question)}</dt><dd>→ ${esc(q.answer)}</dd>`).join("");
    answeredHtml = `<details><summary>回答済み ${answered.length} 件</summary><dl>${items}</dl></details>`;
  }

  const home = os.homedir();
  const scope =
    m.scope === "all" ? "全プロジェクト" : String(m.scope).replace(home, "~");
  let meta = `集計 ${localTime(m.collected_at)} · ${esc(scope)} · ${days}日以内 · ${m.sessions} セッション · 料金表 ${prices.updatedAt ?? "日付不明"}`;
  if (m.excluded_worktree_sessions) meta += ` · worktree ${m.excluded_worktree_sessions} 件は除外`;
  if (refresh) meta += ` · ${refresh}秒ごとに更新`;
  const script = SCRIPT.replace("__REFRESH__", String(refresh ?? 0));
  const errorHtml = errors.map((e) => `<p class="error">${esc(e)}</p>`).join("");
  const title = esc(dashboard.title || "作業ダッシュボード");
  const sessionName = [latest.title, latest.branch && latest.branch !== "HEAD" ? latest.branch : null, latestId !== "—" ? latestId : null]
    .filter(Boolean)
    .join(" · ");
  const statusHtml =
    `<section class="status ${status.cls}" aria-live="polite"><strong>${esc(status.label)}</strong>` +
    (status.sinceSec === null ? "" : `<span class="since">${dur(status.sinceSec)}前から</span>`) +
    `<span class="detail">${esc([sessionName ? `直近のセッション: ${sessionName}` : "", status.note].filter(Boolean).join(" · "))}</span>` +
    othersChips(m.recent_sessions ?? [], latest.id, Date.now()) +
    `</section>`;

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>[${esc(status.label)}] ${title}</title><style>${CSS}</style></head>
<body><main>
<header><h1>${title}</h1><span class="meta">${meta}</span></header>
${statusHtml}
${errorHtml}
<div class="tiles">${tiles.join("")}</div>
<details class="fold-section" data-persist="operations"><summary>運用状況${activitySummary}</summary>
<div class="tiles">${activityTiles.join("")}</div></details>
${sessionsSection(m.recent_sessions ?? [], latest.id, project, Date.now())}
${worktreeSection(worktrees)}
<section><div class="task-head"><h2>タスク</h2><input id="q" type="search" placeholder="タスクを絞り込む" aria-label="タスクを絞り込む"></div>
${taskHtml}</section>
<section><h2>未回答の質問</h2>
<div class="table"><table><thead><tr><th>ID</th><th>緊急度</th><th>問い</th><th>既定の行動</th></tr></thead>
<tbody>${qRows}</tbody></table></div>${answeredHtml}</section>
</main><script>${script}</script></body></html>
`;
}

function cmdInit(dashboardPath: string): number {
  if (fs.existsSync(dashboardPath)) console.error(`${dashboardPath} はもうあります`);
  const created = initDashboard({ dashboardPath });
  for (const f of created) console.log(f);
  return created.length ? 0 : 1;
}

function cmdBuild(dashboardPath: string, out?: string): number {
  const dest = out || path.join(path.dirname(path.resolve(dashboardPath)), "dashboard.html");
  fs.writeFileSync(dest, render(dashboardPath), "utf-8");
  console.log(dest);
  return 0;
}

function listen(server: http.Server, host: string, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) => (e.code === "EADDRINUSE" ? resolve(false) : reject(e)));
    server.listen(port, host, () => resolve(true));
  });
}

/** タスクの状態を人が変える (やらない ⇄ todo)。AI が同時に書いても壊れないよう、読み直して一時ファイル経由で置き換える。 */
function updateTaskStatus(dashboardPath: string, id: string, status: string): { code: number; message: string } {
  if (status !== "dropped" && status !== "todo") return { code: 400, message: "status は dropped か todo" };
  let dashboard: Json;
  try {
    dashboard = JSON.parse(fs.readFileSync(dashboardPath, "utf-8"));
  } catch (e) {
    return { code: 500, message: `${dashboardPath} を読めません: ${(e as Error).message}` };
  }
  const task = (dashboard.tasks || []).find((t: Json) => t.id === id);
  if (!task) return { code: 404, message: `タスク ${id} がありません` };
  // やめられるのは終わっていないタスク。戻せるのはやめたタスクだけ
  if (status === "dropped" && task.status === "done") return { code: 409, message: "完了したタスクはやめられません" };
  if (status === "todo" && task.status !== "dropped") return { code: 409, message: "やめたタスクだけ戻せます" };
  task.status = status;
  const tmp = `${dashboardPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(dashboard, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, dashboardPath);
  return { code: 200, message: "ok" };
}

async function cmdServe(dashboardPath: string, host: string, port: number, refresh: number): Promise<number> {
  let bound = port;
  // 書き込みの API があるので、別のサイトのページからの要求 (CSRF) と DNS rebinding を弾く:
  // Host が自分のアドレスであること、Origin があれば同じ Host であること、JSON の Content-Type であること。
  const hostOk = (h?: string) => [`${host}:${bound}`, `127.0.0.1:${bound}`, `localhost:${bound}`, `[::1]:${bound}`].includes(h ?? "");
  const server = http.createServer((req, res) => {
    const reply = (code: number, text = "") => res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" }).end(text);
    if (req.method === "POST" && req.url === "/api/task") {
      const origin = req.headers.origin;
      if (!hostOk(req.headers.host) || (origin && origin !== `http://${req.headers.host}`)) return reply(403, "forbidden");
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return reply(415, "json only");
      let raw = "";
      req.on("data", (c) => {
        raw += c;
        if (raw.length > 4096) req.destroy();
      });
      req.on("end", () => {
        try {
          const { id, status } = JSON.parse(raw);
          const r = updateTaskStatus(dashboardPath, String(id), String(status));
          reply(r.code, r.message);
        } catch {
          reply(400, "bad request");
        }
      });
      return;
    }
    if (req.method !== "GET" || (req.url !== "/" && req.url !== "/index.html")) return reply(404);
    if (!hostOk(req.headers.host)) return reply(403, "forbidden");
    const body = Buffer.from(render(dashboardPath, refresh, true), "utf-8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length });
    res.end(body);
  });
  // 別のプロジェクトのダッシュボードが同じポートで動いていたら、次の空いているポートを使う
  for (let p = port; p < port + 20; p++) {
    bound = p;
    if (await listen(server, host, p)) {
      console.log(`http://${host}:${p}/`);
      return -1; // サーバーが動き続ける
    }
  }
  console.error(`ポート ${port}〜${port + 19} がすべて使われています`);
  return 1;
}

async function main(): Promise<number> {
  const { values: a, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      dashboard: { type: "string", default: DEFAULT_DASHBOARD },
      out: { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8765" },
      refresh: { type: "string", default: "30" },
      help: { type: "boolean", short: "h" },
    },
  });
  const cmd = positionals[0];
  if (a.help || !["init", "build", "serve"].includes(cmd)) {
    console.error(
      "usage: node dashboard.ts {init|build|serve} [--dashboard PATH] [--out FILE] [--host H] [--port N] [--refresh SEC]\n" +
        `  init   カレントディレクトリに ${DASHBOARD_DIR}/ を作り、dashboard.json と prices.json を置く\n` +
        `  build  dashboard.json の隣に dashboard.html を書き出す (--out で変更)\n` +
        `  serve  HTTP で配信し、開くたびに集計し直す (--host, --port, --refresh)\n` +
        `  --dashboard の既定: ${DEFAULT_DASHBOARD}`,
    );
    return a.help ? 0 : 2;
  }
  const dashboard = a.dashboard as string;
  if (cmd === "init") return cmdInit(dashboard);
  if (cmd === "build") return cmdBuild(dashboard, a.out);
  return cmdServe(dashboard, a.host as string, Number.parseInt(a.port as string, 10), Number.parseInt(a.refresh as string, 10));
}

const code = await main();
if (code >= 0) process.exitCode = code; // serve は -1 を返してプロセスを残す
