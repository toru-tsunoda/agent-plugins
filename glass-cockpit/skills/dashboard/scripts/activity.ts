/**
 * ツール呼び出しの記録から、運用状況の指標を作る (collect.ts が集めた生データを集計する)。
 *   スキルの利用 (レビューゲート) / Codex の相談 / サブエージェント / 人を待った時間 / 最後のツール
 * 今の状態 (待っているのか動いているのか) は state.ts が判定する。
 */
import { toolDetail } from "./state.ts";

type Json = Record<string, any>;

export interface ToolUse {
  name: string;
  ts: string;
  /** セッション ID (サブエージェントのログは親のセッション ID に入る) */
  sid: string;
  /** サブエージェントのログ (subagents/*.jsonl) の中の呼び出しか */
  sub: boolean;
  input: Json;
}

export interface ActivityInput {
  toolUses: Map<string, ToolUse>;
  /** tool_use_id -> [is_error, is_denial, 結果の時刻] */
  results: Map<string, [boolean, boolean, string | undefined]>;
  slashCommands: { name: string; ts: string }[];
  latestSessionId: string | null;
  latestLastTs: string | null;
  now: number;
}

const CODEX_EXEC = /(^|[\s;&|(])codex\s+exec\b/;
const seconds = (fromIso: string, toIso: string): number => Math.max(0, (Date.parse(toIso) - Date.parse(fromIso)) / 1000);
const round1 = (x: number) => Math.round(x * 10) / 10;
/** `plugin:skill` の `skill` だけにする。プラグイン名が違っても同じスキルとして数える */
const shortName = (n: string) => n.replace(/^\//, "").split(":").pop() as string;

export function summarizeActivity(a: ActivityInput): Json {
  const skills: Record<string, { count: number; last_at: string }> = {};
  const noteSkill = (name: string, ts: string) => {
    const k = shortName(name);
    const cur = skills[k] ?? { count: 0, last_at: "" };
    cur.count++;
    if (ts > cur.last_at) cur.last_at = ts;
    skills[k] = cur;
  };

  const codex = { runs: 0, failures: 0, total_sec: 0, longest_sec: 0, last_at: null as string | null };
  const subagents = { calls: 0, background: 0, by_type: {} as Record<string, number> };
  const waits = { asks: 0, answered: 0, total_sec: 0, max_sec: 0 };
  let lastTool: ToolUse | null = null;

  for (const [id, u] of a.toolUses) {
    const res = a.results.get(id);

    if (u.name === "Skill" && u.input.skill) noteSkill(String(u.input.skill), u.ts);

    if (u.name === "Bash" && CODEX_EXEC.test(String(u.input.command ?? ""))) {
      codex.runs++;
      if (res?.[0]) codex.failures++;
      if (res?.[2]) {
        const sec = seconds(u.ts, res[2]);
        codex.total_sec += sec;
        codex.longest_sec = Math.max(codex.longest_sec, sec);
      }
      if (!codex.last_at || u.ts > codex.last_at) codex.last_at = u.ts;
    }

    if (u.name === "Agent" || u.name === "Task") {
      subagents.calls++;
      if (u.input.run_in_background) subagents.background++;
      const type = String(u.input.subagent_type || "(指定なし)");
      subagents.by_type[type] = (subagents.by_type[type] ?? 0) + 1;
    }

    if (u.name === "AskUserQuestion") {
      waits.asks++;
      if (res?.[2]) {
        const sec = seconds(u.ts, res[2]);
        waits.answered++;
        waits.total_sec += sec;
        waits.max_sec = Math.max(waits.max_sec, sec);
      }
    }

    if (u.sid === a.latestSessionId && (lastTool === null || u.ts > lastTool.ts)) lastTool = u;
  }
  for (const c of a.slashCommands) noteSkill(c.name, c.ts);

  return {
    skills,
    codex: {
      runs: codex.runs,
      failures: codex.failures,
      total_sec: round1(codex.total_sec),
      longest_sec: round1(codex.longest_sec),
      last_at: codex.last_at,
    },
    subagents,
    user_waits: {
      asks: waits.asks,
      answered: waits.answered,
      total_sec: round1(waits.total_sec),
      max_sec: round1(waits.max_sec),
    },
    activity: {
      last_at: a.latestLastTs,
      idle_sec: a.latestLastTs ? Math.max(0, Math.round((a.now - Date.parse(a.latestLastTs)) / 1000)) : null,
      last_tool: lastTool ? { name: lastTool.name, detail: toolDetail(lastTool.name, lastTool.input), at: lastTool.ts } : null,
    },
  };
}
