/**
 * API の呼び出しごとの記録から、利用状況 (いつ・どのモデル・どのエフォートで・どれだけ使ったか) を集計する。
 * collect.ts が呼び出し1回ごとに add し、summary でグラフ用の集計を返す。
 *
 * - モデルは実際に動いたもの (message.model) で数え、`[1m]` などの印は外す
 * - エフォートは perTurnEffort (そのターンに効いたもの) を、無ければ effort を使う。どちらも無いログは "unknown"
 * - 日付・時刻は集計した PC の時刻で区切る (serve は手元の PC で動くので、その PC の時刻になる)
 * - 期間の枠 (直近24時間の1時間ごとの24枠、30日分の日) もここで決めて summary に入れる。
 *   グラフはどれもこの枠に入った行だけを使う。見る時刻やブラウザのタイムゾーンで対象が変わらないように、
 *   基準は集計した時刻 (now) で、タイムゾーンも集計した PC のもの
 * - 集計した時刻より後の記録 (時計のずれ) は数えない
 */

type Json = Record<string, any>;

/** エフォートの並び (低い順)。ここに無い値は後ろに足す */
export const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
export const UNKNOWN = "unknown";

const HOUR_SLOTS = 24;
const DAY_SLOTS = 30;

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
  /** 思考トークンの数がログにあった回数 (1回あたりの平均の分母) */
  thinkingCalls: number;
}

const baseModel = (m?: string) => (m || UNKNOWN).split("[")[0];
/** 比べる時は、末尾の日付 (-20251001 など) も外す。日付付きの ID と日付なしの ID は同じモデル */
const sameModelKey = (m: string) => baseModel(m).replace(/-\d{8}$/, "");
const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localHour = (d: Date) => `${localDay(d)}T${pad(d.getHours())}`;
const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** 頼んだモデルと比べられるか。"opus" のような別名で頼んだ時や、どちらかが無い時は比べられない */
const comparable = (requested: string | undefined, model: string | undefined): boolean =>
  !!requested && !!model && baseModel(requested).startsWith("claude-");
/** 頼んだモデルと違うモデルで動いたか (比べられる時だけ) */
const isFallback = (requested: string, model: string): boolean => sameModelKey(requested) !== sameModelKey(model);

/** UTC からのずれ ("UTC+9"、"UTC-3:30" など) */
function tzLabel(d: Date): string {
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `UTC${off < 0 ? "-" : "+"}${Math.floor(a / 60)}${a % 60 ? ":" + pad(a % 60) : ""}`;
}

export class UsageTally {
  private daily = new Map<string, Bucket>();
  private hourly = new Map<string, Bucket>();
  private fallbacks = new Map<string, number>(); // "頼んだ\t実際" -> 回数
  private efforts = new Set<string>();
  private comparableCalls = 0; // 頼んだモデルと比べられた回数
  private future = 0; // 集計した時刻より後の記録 (数えない)
  private now: number;
  /** 直近24時間の枠 (今の時を含めて24個、古い順) と、30日分の日の枠 (今日を含めて、古い順) */
  private hourKeys: string[] = [];
  private dayKeys: string[] = [];
  private hourSet: Set<string>;
  private daySet: Set<string>;

  constructor(now = Date.now()) {
    this.now = now;
    for (let h = HOUR_SLOTS - 1; h >= 0; h--) this.hourKeys.push(localHour(new Date(now - h * 3600e3)));
    const today = new Date(now);
    for (let d = DAY_SLOTS - 1; d >= 0; d--) {
      // 夏時間でも日がずれないよう、24時間を引くのではなく日付を戻す
      this.dayKeys.push(localDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - d, 12)));
    }
    this.hourSet = new Set(this.hourKeys);
    this.daySet = new Set(this.dayKeys);
  }

  add(c: UsageCall) {
    const t = Date.parse(c.ts);
    if (Number.isNaN(t)) return;
    if (t > this.now) {
      this.future++;
      return;
    }
    const d = new Date(t);
    const model = baseModel(c.model);
    const effort = c.effort || UNKNOWN;
    const tail = `\t${model}\t${effort}\t${c.sub ? 1 : 0}`;
    const day = localDay(d);
    const hour = localHour(d);
    if (this.daySet.has(day)) {
      this.efforts.add(effort);
      bump(this.daily, day + tail, c);
    }
    if (this.hourSet.has(hour)) bump(this.hourly, hour + tail, c);
    if (comparable(c.requested, c.model)) {
      this.comparableCalls++;
      if (isFallback(c.requested!, c.model!)) {
        const k = `${baseModel(c.requested)}\t${model}`;
        this.fallbacks.set(k, (this.fallbacks.get(k) ?? 0) + 1);
      }
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
            thinking_calls: b.thinkingCalls,
          };
        })
        .sort((a, b) => String(a[key]).localeCompare(String(b[key])) || a.model.localeCompare(b.model));
    const known = EFFORT_ORDER.filter((e) => this.efforts.has(e));
    const others = [...this.efforts].filter((e) => !EFFORT_ORDER.includes(e) && e !== UNKNOWN).sort();
    return {
      // グラフの基準。どのグラフも、この枠に入った行だけを使う
      now: new Date(this.now).toISOString(),
      tz: tzLabel(new Date(this.now)),
      slots: { hour: this.hourKeys, day: this.dayKeys },
      efforts: [...known, ...others, ...(this.efforts.has(UNKNOWN) ? [UNKNOWN] : [])],
      daily: rows(this.daily, "day"),
      hourly: rows(this.hourly, "hour"),
      fallbacks: [...this.fallbacks.entries()]
        .map(([k, calls]) => {
          const [requested, model] = k.split("\t");
          return { requested, model, calls };
        })
        .sort((a, b) => b.calls - a.calls),
      // 頼んだモデルと比べられた回数 (別名で頼んだ時や、頼んだモデルが残っていない時は比べられない)
      comparable_calls: this.comparableCalls,
      future_calls: this.future,
    };
  }
}

function bump(m: Map<string, Bucket>, k: string, c: UsageCall) {
  const b = m.get(k) ?? { calls: 0, cost: 0, output: 0, thinking: 0, unpriced: 0, thinkingCalls: 0 };
  b.calls++;
  if (c.cost === null) b.unpriced++;
  else b.cost += c.cost;
  b.output += c.usage.output_tokens ?? 0;
  const thinking = c.usage.output_tokens_details?.thinking_tokens;
  if (typeof thinking === "number") {
    b.thinking += thinking;
    b.thinkingCalls++;
  }
  m.set(k, b);
}
