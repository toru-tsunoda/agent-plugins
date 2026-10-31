/**
 * API の呼び出しごとの記録から、利用状況 (いつ・どのモデル・どのエフォートで・どれだけ使ったか) を集計する。
 * collect.ts が呼び出し1回ごとに add し、summary でグラフ用の集計を返す。
 *
 * - モデルは実際に動いたもの (message.model) で数え、`[1m]` などの印は外す
 * - エフォートは perTurnEffort (そのターンに効いたもの) を、無ければ effort を使う。どちらも無いログは "unknown"
 * - 日付は手元の時刻で区切る (serve は手元の PC で動くので、その PC の時刻になる)
 */

type Json = Record<string, any>;

/** エフォートの並び (低い順)。ここに無い値は後ろに足す */
export const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
export const UNKNOWN = "unknown";

const HOURLY_WINDOW_MS = 24 * 3600 * 1000;

export interface UsageCall {
  ts: string;
  /** 実際に動いたモデル (message.model) */
  model: string | undefined;
  /** 頼んだモデル (requestedModel) */
  requested: string | undefined;
  effort: string | undefined;
  sub: boolean;
  /** 料金表で換算した費用。単価の分からないモデルは null */
  cost: number | null;
  usage: Json;
}

interface Bucket {
  calls: number;
  cost: number;
  output: number;
  thinking: number;
  unpriced: number;
}

const baseModel = (m?: string) => (m || UNKNOWN).split("[")[0];
const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localHour = (d: Date) => `${localDay(d)}T${pad(d.getHours())}`;
const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** 頼んだモデルと違うモデルで動いたか。"opus" のような別名で頼んだ時は比べられないので数えない */
function isFallback(requested: string | undefined, model: string | undefined): boolean {
  if (!requested || !model) return false;
  const r = baseModel(requested);
  return r.startsWith("claude-") && r !== baseModel(model);
}

export class UsageTally {
  private daily = new Map<string, Bucket>();
  private hourly = new Map<string, Bucket>();
  private fallbacks = new Map<string, number>(); // "頼んだ\t実際" -> 回数
  private efforts = new Set<string>();
  private now: number;

  constructor(now = Date.now()) {
    this.now = now;
  }

  add(c: UsageCall) {
    const t = Date.parse(c.ts);
    if (Number.isNaN(t)) return;
    const d = new Date(t);
    const model = baseModel(c.model);
    const effort = c.effort || UNKNOWN;
    this.efforts.add(effort);
    const tail = `\t${model}\t${effort}\t${c.sub ? 1 : 0}`;
    bump(this.daily, localDay(d) + tail, c);
    if (this.now - t < HOURLY_WINDOW_MS) bump(this.hourly, localHour(d) + tail, c);
    if (isFallback(c.requested, c.model)) {
      const k = `${baseModel(c.requested)}\t${model}`;
      this.fallbacks.set(k, (this.fallbacks.get(k) ?? 0) + 1);
    }
  }

  /**
   * グラフ用の集計。daily・hourly の行は (日または時, モデル, エフォート, サブエージェントか) ごと。
   * 費用は呼び出しごとの概算の合計なので、cost-state を使う費用のタイルより数%低いことがある。
   */
  summary(): Json {
    const rows = (m: Map<string, Bucket>, key: string) =>
      [...m.entries()]
        .map(([k, b]) => {
          const [at, model, effort, sub] = k.split("\t");
          return {
            [key]: at,
            model,
            effort,
            sub: sub === "1",
            calls: b.calls,
            cost_usd: round4(b.cost),
            output_tokens: b.output,
            thinking_tokens: b.thinking,
            unpriced_calls: b.unpriced,
          };
        })
        .sort((a, b) => String(a[key]).localeCompare(String(b[key])) || a.model.localeCompare(b.model));
    const known = EFFORT_ORDER.filter((e) => this.efforts.has(e));
    const others = [...this.efforts].filter((e) => !EFFORT_ORDER.includes(e) && e !== UNKNOWN).sort();
    return {
      efforts: [...known, ...others, ...(this.efforts.has(UNKNOWN) ? [UNKNOWN] : [])],
      daily: rows(this.daily, "day"),
      hourly: rows(this.hourly, "hour"),
      fallbacks: [...this.fallbacks.entries()]
        .map(([k, calls]) => {
          const [requested, model] = k.split("\t");
          return { requested, model, calls };
        })
        .sort((a, b) => b.calls - a.calls),
    };
  }
}

function bump(m: Map<string, Bucket>, k: string, c: UsageCall) {
  const b = m.get(k) ?? { calls: 0, cost: 0, output: 0, thinking: 0, unpriced: 0 };
  b.calls++;
  if (c.cost === null) b.unpriced++;
  else b.cost += c.cost;
  b.output += c.usage.output_tokens ?? 0;
  b.thinking += c.usage.output_tokens_details?.thinking_tokens ?? 0;
  m.set(k, b);
}
