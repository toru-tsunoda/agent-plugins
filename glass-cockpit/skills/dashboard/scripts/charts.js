/*
 * 利用状況のグラフ (ブラウザで描く)。dashboard.ts がこのファイルをそのまま <script> に埋め込む。
 * 集計 (usage.ts の summary) は <script type="application/json" id="usage-data"> に入れておく。
 * 全部の組み合わせを SVG にして埋め込むと HTML が大きくなる (クラウドの書き出しも重くなる) ので、数字だけを渡してここで描く。
 *
 *   グラフ1: 日ごと (直近24時間なら1時間ごと) の積み上げ棒。モデル別かエフォート別
 *   グラフ2: モデル × エフォートの表。色の濃さで量を出す
 *   グラフ3: エフォートごとの、1回あたりの思考トークンと費用
 *
 * 外部のライブラリは使わない (オフラインでも、クラウドの sandbox の iframe でも動くように)。
 * 文字列を返す関数だけで組み、最後に DOM へ入れる。
 */
(() => {
  const MAX_MODELS = 5; // これを超えるモデルは「その他」にまとめる (色を作り足さない)
  const OTHER = "その他";
  const UNKNOWN = "unknown";
  const METRICS = {
    cost: { label: "費用", key: "cost_usd", fmt: (v) => "$" + (v >= 100 ? v.toFixed(0) : v >= 0.1 ? v.toFixed(2) : v.toFixed(3)) },
    output: { label: "出力トークン", key: "output_tokens", fmt: (v) => tokens(v) },
    calls: { label: "呼び出し回数", key: "calls", fmt: (v) => Math.round(v).toLocaleString("ja-JP") + " 回" },
  };
  const RANGES = { "24h": "直近24時間", "7d": "7日", "30d": "30日" };
  const BYS = { model: "モデル別", effort: "エフォート別" };

  function tokens(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + "k";
    return String(Math.round(v));
  }
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[c]);
  const shortModel = (m) => String(m).replace(/^claude-/, "");
  const pad = (n) => String(n).padStart(2, "0");
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hourKey = (d) => `${dayKey(d)}T${pad(d.getHours())}`;

  /**
   * 色の割り当て。モデルは集計の全期間の費用の多い順に一度だけ決める (指標や期間を切り替えても色が変わらない)。
   * エフォートは低い順に濃くする
   */
  function colorMaps(data) {
    const totals = new Map();
    for (const r of data.daily) totals.set(r.model, (totals.get(r.model) ?? 0) + r.cost_usd + r.calls * 1e-9);
    const top = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, totals.size > MAX_MODELS ? MAX_MODELS - 1 : MAX_MODELS)
      .map(([m]) => m);
    const model = new Map(top.map((m, i) => [m, `var(--series-${i + 1})`]));
    const effort = new Map();
    let i = 0;
    for (const e of data.efforts) effort.set(e, e === UNKNOWN ? "var(--series-none)" : `var(--effort-${Math.min(++i, 5)})`);
    return { model, effort, modelOrder: top };
  }

  /** 期間の行と、棒の並び (時刻のキー) を返す */
  function slots(data, range, now) {
    const keys = [];
    if (range === "24h") {
      for (let h = 23; h >= 0; h--) keys.push(hourKey(new Date(now - h * 3600e3)));
      return { keys, rows: data.hourly, at: "hour" };
    }
    const n = Math.min(range === "7d" ? 7 : 30, data.days || 30);
    for (let d = n - 1; d >= 0; d--) keys.push(dayKey(new Date(now - d * 86400e3)));
    return { keys, rows: data.daily.filter((r) => r.day >= keys[0]), at: "day" };
  }

  const seriesOf = (r, by, colors) => (by === "effort" ? r.effort : colors.model.has(r.model) ? r.model : OTHER);
  const colorOf = (s, by, colors) =>
    by === "effort" ? colors.effort.get(s) : s === OTHER ? "var(--series-none)" : colors.model.get(s);
  const seriesLabel = (s, by) => (by === "effort" ? (s === UNKNOWN ? "不明" : s) : s === OTHER ? OTHER : shortModel(s));

  function seriesList(by, colors, data, present) {
    const all = by === "effort" ? data.efforts : [...colors.modelOrder, OTHER];
    return all.filter((s) => present.has(s));
  }

  /** きりのよい目盛り */
  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= v) return k * p;
    return 10 * p;
  }

  /** 上の角だけ丸めた棒 (積み上げの一番上の段) */
  function topRounded(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  function stackedBars(data, st, colors, now, width) {
    const metric = METRICS[st.metric];
    const { keys, rows, at } = slots(data, st.range, now);
    const index = new Map(keys.map((k, i) => [k, i]));
    const stacks = keys.map(() => new Map());
    const present = new Set();
    for (const r of rows) {
      const i = index.get(r[at]);
      if (i === undefined) continue;
      const s = seriesOf(r, st.by, colors);
      present.add(s);
      stacks[i].set(s, (stacks[i].get(s) ?? 0) + r[metric.key]);
    }
    const series = seriesList(st.by, colors, data, present);
    const totals = stacks.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
    // 回数は目盛りが整数になるようにする (4等分するので4の倍数)
    const top = Math.max(0, ...totals);
    const max = st.metric === "calls" ? Math.max(4, Math.ceil(niceMax(top) / 4) * 4) : niceMax(top);
    // 文字の大きさが画面の幅で変わらないよう、実際の幅で描く
    const W = Math.max(320, Math.round(width)), H = 220, L = 56, R = 8, T = 10, B = 26;
    const pw = W - L - R, ph = H - T - B;
    const step = pw / keys.length;
    const bw = Math.max(3, Math.min(28, step * 0.7));
    const y = (v) => T + ph - (v / max) * ph;
    let g = "";
    for (let t = 0; t <= 4; t++) {
      const v = (max * t) / 4;
      g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`;
      g += `<text class="tick" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${esc(v ? metric.fmt(v) : "0")}</text>`;
    }
    const every = Math.max(at === "hour" ? 3 : 1, Math.ceil(keys.length / Math.max(2, Math.floor(pw / 56))));
    keys.forEach((k, i) => {
      const x = L + step * i + (step - bw) / 2;
      const label = at === "hour" ? `${Number(k.slice(11))}時` : `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`;
      // 最後の目盛りは、1つ前の目盛りと重ならない時だけ出す
      if (i % every === 0 || (i === keys.length - 1 && i % every >= every / 2))
        g += `<text class="tick" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${label}</text>`;
      const parts = series.filter((s) => (stacks[i].get(s) ?? 0) > 0);
      let base = 0;
      const tip = [`${label}　計 ${metric.fmt(totals[i])}`, ...parts.map((s) => `${seriesLabel(s, st.by)}: ${metric.fmt(stacks[i].get(s))}`)].join("\n");
      parts.forEach((s, j) => {
        const v = stacks[i].get(s);
        const y0 = y(base), y1 = y(base + v);
        const h = Math.max(1, y0 - y1 - (j > 0 ? 2 : 0)); // 段のあいだに2pxのすき間
        const fill = colorOf(s, st.by, colors);
        g +=
          j === parts.length - 1
            ? `<path d="${topRounded(x, y0 - h - (j > 0 ? 2 : 0), bw, h, 4)}" fill="${fill}"/>`
            : `<rect x="${x}" y="${y0 - h - (j > 0 ? 2 : 0)}" width="${bw}" height="${h}" fill="${fill}"/>`;
        base += v;
      });
      // 当たり判定は棒より広く、列全体にする
      g += `<rect class="hit" x="${L + step * i}" y="${T}" width="${step}" height="${ph}" data-tip="${esc(tip)}"/>`;
    });
    g += `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>`;
    const total = totals.reduce((a, b) => a + b, 0);
    const caption = `${RANGES[st.range]}の${metric.label}（${BYS[st.by]}）　計 ${metric.fmt(total)}`;
    const legend = series.length >= 2 ? legendHtml(series.map((s) => [seriesLabel(s, st.by), colorOf(s, st.by, colors)])) : "";
    const table =
      `<details class="viz-table"><summary>表で見る</summary><div class="table"><table><thead><tr><th>${at === "hour" ? "時" : "日"}</th>` +
      series.map((s) => `<th class="num">${esc(seriesLabel(s, st.by))}</th>`).join("") +
      `<th class="num">計</th></tr></thead><tbody>` +
      keys
        .map((k, i) =>
          totals[i] ? `<tr><td>${esc(at === "hour" ? k.replace("T", " ") + "時" : k)}</td>` +
            series.map((s) => `<td class="num">${stacks[i].get(s) ? esc(metric.fmt(stacks[i].get(s))) : "—"}</td>`).join("") +
            `<td class="num">${esc(metric.fmt(totals[i]))}</td></tr>` : "",
        )
        .join("") +
      `</tbody></table></div></details>`;
    return (
      `<figure class="viz"><figcaption>${esc(caption)}</figcaption>${legend}` +
      (total
        ? `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(caption)}">${g}</svg>`
        : `<p class="viz-empty">この期間の記録はありません</p>`) +
      `${total ? table : ""}</figure>`
    );
  }

  function legendHtml(items) {
    return `<div class="viz-legend">${items.map(([l, c]) => `<span><i style="background:${c}"></i>${esc(l)}</span>`).join("")}</div>`;
  }

  /** モデル × エフォート。セルの濃さは量に比べる (1色の濃淡)。セルに値と回数を書く */
  function matrix(data, st, colors, now) {
    const metric = METRICS[st.metric];
    const { rows } = slots(data, st.range, now);
    const cells = new Map();
    const models = new Set();
    const efforts = new Set();
    for (const r of rows) {
      const m = colors.model.has(r.model) ? r.model : OTHER;
      models.add(m);
      efforts.add(r.effort);
      const k = m + "\t" + r.effort;
      const c = cells.get(k) ?? { v: 0, calls: 0 };
      c.v += r[metric.key];
      c.calls += r.calls;
      cells.set(k, c);
    }
    if (!cells.size) return "";
    const ms = [...colors.modelOrder, OTHER].filter((m) => models.has(m));
    const es = data.efforts.filter((e) => efforts.has(e));
    const max = Math.max(...[...cells.values()].map((c) => c.v));
    const head = `<tr><th>モデル＼エフォート</th>${es.map((e) => `<th class="num">${esc(seriesLabel(e, "effort"))}</th>`).join("")}</tr>`;
    const body = ms
      .map(
        (m) =>
          `<tr><th><i class="swatch" style="background:${colorOf(m, "model", colors)}"></i>${esc(seriesLabel(m, "model"))}</th>` +
          es
            .map((e) => {
              const c = cells.get(m + "\t" + e);
              if (!c) return `<td class="num cell">—</td>`;
              const level = max ? Math.min(5, Math.max(1, Math.ceil((c.v / max) * 5))) : 1;
              return `<td class="num cell heat-${level}" title="${esc(`${seriesLabel(m, "model")} × ${seriesLabel(e, "effort")}: ${metric.fmt(c.v)}（${c.calls} 回）`)}">${esc(metric.fmt(c.v))}${st.metric === "calls" ? "" : `<small>${c.calls} 回</small>`}</td>`;
            })
            .join("") +
          `</tr>`,
      )
      .join("");
    return `<figure class="viz"><figcaption>モデル × エフォートの${esc(metric.label)}（${esc(RANGES[st.range])}）</figcaption><div class="table"><table class="heat">${head}${body}</table></div></figure>`;
  }

  /** エフォートごとの1回あたり。思考トークンと費用は桁が違うので、横に並べた2つの棒にする (軸を共有しない) */
  function effortEffect(data, st, colors, now) {
    const { rows } = slots(data, st.range, now);
    const by = new Map();
    for (const r of rows) {
      if (r.sub) continue; // サブエージェントは頼む仕事が違うので比べない
      const b = by.get(r.effort) ?? { calls: 0, thinking: 0, cost: 0 };
      b.calls += r.calls;
      b.thinking += r.thinking_tokens;
      b.cost += r.cost_usd;
      by.set(r.effort, b);
    }
    const es = data.efforts.filter((e) => by.get(e)?.calls);
    if (!es.length) return "";
    const panel = (title, get, fmt) => {
      const max = Math.max(...es.map((e) => get(by.get(e))));
      const rowsHtml = es
        .map((e) => {
          const v = get(by.get(e));
          const w = max ? (v / max) * 100 : 0;
          return `<div class="hrow" title="${esc(`${seriesLabel(e, "effort")}: ${fmt(v)}（${by.get(e).calls} 回）`)}"><span class="hlabel">${esc(seriesLabel(e, "effort"))}</span><span class="htrack"><i style="width:${w}%;background:${colorOf(e, "effort", colors)}"></i></span><span class="hval">${esc(fmt(v))}</span></div>`;
        })
        .join("");
      return `<div class="hpanel"><div class="hhead">${esc(title)}</div>${rowsHtml}</div>`;
    };
    return (
      `<figure class="viz"><figcaption>エフォートごとの1回あたり（${esc(RANGES[st.range])}、メインのエージェントだけ）</figcaption><div class="hpanels">` +
      panel("思考トークン", (b) => b.thinking / b.calls, tokens) +
      panel("費用", (b) => b.cost / b.calls, METRICS.cost.fmt) +
      `</div></figure>`
    );
  }

  function controls(st) {
    const group = (name, opts) =>
      `<div class="seg" role="group">${Object.entries(opts)
        .map(([k, l]) => `<button type="button" data-usage="${name}" data-value="${k}" aria-pressed="${st[name] === k}">${esc(l)}</button>`)
        .join("")}</div>`;
    return `<div class="viz-controls">${group("range", RANGES)}${group("metric", Object.fromEntries(Object.entries(METRICS).map(([k, m]) => [k, m.label])))}${group("by", BYS)}</div>`;
  }

  function renderUsage(data, st, now, width = 720) {
    const colors = colorMaps(data);
    return controls(st) + stackedBars(data, st, colors, now, width) + `<div class="viz-pair">${matrix(data, st, colors, now)}${effortEffect(data, st, colors, now)}</div>`;
  }

  const api = { renderUsage, METRICS, RANGES, BYS };
  globalThis.glassCockpitCharts = api; // node で確かめる時に使う
  if (typeof document === "undefined") return;

  const root = document.getElementById("usage-charts");
  const src = document.getElementById("usage-data");
  if (!root || !src) return;
  const data = JSON.parse(src.textContent);
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
  };
  const st = {
    range: RANGES[store.get("usage:range")] ? store.get("usage:range") : "7d",
    metric: METRICS[store.get("usage:metric")] ? store.get("usage:metric") : "cost",
    by: BYS[store.get("usage:by")] ? store.get("usage:by") : "model",
  };
  // 図の枠の内側の幅 (枠の左右の余白 18px ずつを引く)
  const draw = () => { root.innerHTML = renderUsage(data, st, Date.now(), root.clientWidth - 38); };
  let lastWidth = root.clientWidth;
  const redrawIfResized = () => {
    if (root.clientWidth && root.clientWidth !== lastWidth) { lastWidth = root.clientWidth; draw(); }
  };
  window.addEventListener("resize", redrawIfResized);
  // 折りたたみの中にあると、開くまで幅が 0 なので、開いた時に描き直す
  root.closest("details")?.addEventListener("toggle", redrawIfResized);
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-usage]");
    if (!b) return;
    st[b.dataset.usage] = b.dataset.value;
    store.set("usage:" + b.dataset.usage, b.dataset.value);
    draw();
  });
  // 棒にマウスを乗せた時の吹き出し
  const tip = document.createElement("div");
  tip.className = "viz-tip";
  tip.hidden = true;
  document.body.appendChild(tip);
  root.addEventListener("mousemove", (e) => {
    const t = e.target.closest("[data-tip]");
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.dataset.tip;
    tip.hidden = false;
    const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = x + "px";
    tip.style.top = e.clientY + 14 + "px";
  });
  root.addEventListener("mouseleave", () => { tip.hidden = true; });
  draw();
})();
