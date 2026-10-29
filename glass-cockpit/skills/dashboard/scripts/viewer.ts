/**
 * Artifact 用のページ: プロジェクトの共有フォルダに書き出したダッシュボード (cloudview.ts) を読んで表示する。
 *
 * - claude.ai の Artifact の files 機能で、開いた人自身の権限で読む。プロジェクトのファイルを開けない人には何も見えない。
 *   ページの中にはダッシュボードの中身を持たないので、リンクが漏れても殻しか見えない。
 * - 読んだ HTML は、sandbox (allow-scripts だけ) の iframe に入れる。iframe は別の origin になるので、
 *   中の HTML から Artifact の機能 (window.claude) には届かない。表示するだけで、dashboard.json は書き換えられない。
 * - 一定の間隔で読み直し、中身が変わった時だけ差し替える。差し替えでスクロール位置・開閉・絞り込みが戻らないよう、
 *   iframe の中から postMessage で状態を受け取り、次の HTML に渡す。
 */

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** 読み直す間隔 (秒) */
export const VIEWER_POLL_SEC = 20;

/** Artifact で公開するページ (claude.ai が doctype と head を付けるので、title と style から書く) */
export function viewerHtml(relPath: string, title: string): string {
  return `<title>${esc(title)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
/* 上に細い帯 (書き出しの時刻と読み込みの状態)、残りはすべてダッシュボードの iframe */
:root {
  --bg: #f3f4f6; --bar: #ffffff; --line: #dfe2e7; --ink: #1b1f24; --muted: #5f6873;
  --accent: #2f5bd3; --warn: #a86a00; --crit: #b3261e;
  --sans: "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #121418; --bar: #1b1e24; --line: #2c313a; --ink: #e6e8eb; --muted: #9aa3ad;
    --accent: #7d9cff; --warn: #e0a94a; --crit: #ff7a6e; color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #121418; --bar: #1b1e24; --line: #2c313a; --ink: #e6e8eb; --muted: #9aa3ad;
  --accent: #7d9cff; --warn: #e0a94a; --crit: #ff7a6e; color-scheme: dark;
}
html, body { height: 100%; }
body { margin: 0; display: flex; flex-direction: column; background: var(--bg); color: var(--ink); font: 13px/1.5 var(--sans); }
.bar {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px;
  padding-block: 6px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px));
  background: var(--bar); border-bottom: 1px solid var(--line); color: var(--muted);
}
.bar strong { color: var(--ink); font-weight: 600; }
.bar .when { font-variant-numeric: tabular-nums; }
.bar .msg { flex-basis: 100%; min-width: 0; overflow-wrap: anywhere; }
.bar .msg.warn { color: var(--warn); } .bar .msg.crit { color: var(--crit); }
.bar button { font: inherit; color: var(--accent); background: none; border: 1px solid currentColor; border-radius: 6px; padding: 0 8px; cursor: pointer; }
.bar button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
iframe { flex: 1; width: 100%; min-height: 0; border: 0; background: var(--bg); }
</style>
<div class="bar" role="status" aria-live="polite">
  <strong>glass-cockpit</strong>
  <span class="when" id="when">読み込み中…</span>
  <button id="reload" type="button">今すぐ読み直す</button>
  <span class="msg" id="msg" hidden></span>
</div>
<iframe id="view" title="${esc(title)}" sandbox="allow-scripts"></iframe>
<script>
const PATH = ${JSON.stringify(relPath)};
const POLL_MS = ${VIEWER_POLL_SEC * 1000};
const view = document.getElementById("view");
const whenEl = document.getElementById("when");
const msgEl = document.getElementById("msg");
let files = null, revision = null, collectedAt = null, timer = null, stopped = false;
let state = { y: 0, open: {}, q: "" };

function message(text, cls = "") {
  msgEl.hidden = !text;
  msgEl.className = "msg " + cls;
  msgEl.textContent = text || "";
}

function ago(iso) {
  const sec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (sec < 60) return sec + "秒前";
  if (sec < 3600) return Math.floor(sec / 60) + "分前";
  return Math.floor(sec / 3600) + "時間" + Math.floor((sec % 3600) / 60) + "分前";
}

function showWhen() {
  if (!collectedAt || Number.isNaN(Date.parse(collectedAt))) return;
  const t = new Date(collectedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  whenEl.textContent = "集計 " + t + "（" + ago(collectedAt) + "）· " + POLL_MS / 1000 + "秒ごとに確認";
}

// iframe の中で動かす小さなスクリプト: 前の表示の状態を戻し、変わるたびに親へ知らせる
function bridge(s) {
  const json = JSON.stringify(s).replace(/</g, "\\\\u003c");
  return "<script>(() => {" +
    "const S = " + json + "; const q = document.getElementById('q');" +
    "const key = (d) => d.dataset.key ? 'k:' + d.dataset.key : d.dataset.persist ? 'p:' + d.dataset.persist : null;" +
    "for (const d of document.querySelectorAll('details')) { const k = key(d); if (k && k in S.open) d.open = S.open[k]; }" +
    "if (q && S.q) { q.value = S.q; q.dispatchEvent(new Event('input')); }" +
    "scrollTo(0, S.y || 0);" +
    "const send = () => { const open = {}; for (const d of document.querySelectorAll('details')) { const k = key(d); if (k) open[k] = d.open; }" +
    "  parent.postMessage({ glassCockpit: { y: scrollY, open, q: q ? q.value : '' } }, '*'); };" +
    "addEventListener('scroll', send, { passive: true }); document.addEventListener('toggle', send, true); if (q) q.addEventListener('input', send);" +
    "})();<\\/script>";
}

addEventListener("message", (e) => {
  if (e.source !== view.contentWindow || !e.data || typeof e.data.glassCockpit !== "object") return;
  const s = e.data.glassCockpit;
  state = { y: Number(s.y) || 0, open: s.open && typeof s.open === "object" ? s.open : {}, q: String(s.q || "") };
});

function show(html) {
  const m = html.match(/<meta name="glass-cockpit-collected-at" content="([^"]*)"/);
  collectedAt = m ? m[1] : null;
  const t = html.match(/<title>([^<]*)<\\/title>/);
  if (t) document.title = new DOMParser().parseFromString(t[1], "text/html").documentElement.textContent;
  const i = html.lastIndexOf("</body>");
  view.srcdoc = i >= 0 ? html.slice(0, i) + bridge(state) + html.slice(i) : html + bridge(state);
}

function schedule(ms) {
  clearTimeout(timer);
  if (!stopped) timer = setTimeout(check, ms);
}

async function check() {
  showWhen();
  try {
    const r = await files.read(PATH);
    message("");
    if (r.revision !== revision) {
      revision = r.revision;
      show(new TextDecoder().decode(r.bytes));
    }
    showWhen();
    schedule(POLL_MS);
  } catch (e) {
    const code = e && e.code;
    if (code === "not_found") {
      message("まだ書き出されていません（" + PATH + "）。dashboard.json に \\"cloud_view\\": true を書いて、クラウドのセッションで作業すると現れます。", "warn");
      schedule(POLL_MS);
    } else if (code === "not_granted") {
      stopped = true;
      message("プロジェクトのファイルの読み取りが許可されていないので、表示できません。このページの権限の設定で許可してください。", "crit");
    } else if (code === "rate_limited") {
      schedule(Math.max(e.retryAfterMs || 0, POLL_MS));
    } else if (code === "changed") {
      schedule(2000);
    } else {
      message("読み込めませんでした（" + (code || "unknown") + "）。自動で読み直します。", "warn");
      schedule(POLL_MS);
    }
  }
}

document.getElementById("reload").addEventListener("click", () => {
  if (!files) return;
  stopped = false;
  check();
});
document.addEventListener("visibilitychange", () => {
  if (files && !stopped && document.visibilityState === "visible") schedule(0);
});
setInterval(showWhen, 15000);

(async () => {
  files = window.claude && window.claude.use ? await window.claude.use("files") : null;
  if (!files) {
    whenEl.textContent = "";
    message("このページでは、プロジェクトのファイルを読めません。プロジェクトのメンバーとして claude.ai で開いてください。", "crit");
    return;
  }
  check();
})();
</script>
`;
}
