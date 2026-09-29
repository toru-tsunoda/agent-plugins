/**
 * セッションが今どうなっているかを、ログの末尾から判定する。
 *   人の操作を待っている (質問・権限・ターン終了) のか、動いている (ツール実行・応答生成) のか、止まっているのか。
 */
import path from "node:path";
import type { HookState } from "./hookstate.ts";

type Json = Record<string, any>;

export type StateKind =
  | "question" // AskUserQuestion の回答待ち
  | "permission" // 権限の確認待ち (ログに残らないので、フックの記録で判定する。承認してからツールが終わるまでも、この状態に見える)
  | "tool" // ツールを実行中
  | "thinking" // 応答を生成中 (ツールの結果や人の入力を受けて、次の応答がまだ無い)
  | "idle" // ターンを終えて、人の入力待ち
  | "interrupted" // 人が中断した
  | "api_error" // API エラーで止まった
  | "ended" // セッションを閉じた (フックの記録で判定する)
  | "none"; // 記録なし

export interface SessionState {
  kind: StateKind;
  /** この状態になった時刻 */
  since: string | null;
  /** 実行中・回答待ちのツール */
  tool: { name: string; detail: string } | null;
  /** 親がターンを終えた後も動いているサブエージェントの数 */
  background: number;
  /** hook: フックの記録 / log: フックより新しいログ / estimate: フックの記録が無く、ログから推定 / none: 記録なし */
  source: "hook" | "log" | "estimate" | "none";
}

const clip = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function toolDetail(name: string, i: Json): string {
  switch (name) {
    case "Bash":
      return clip(String(i.description || String(i.command || "").split("\n")[0]));
    case "Skill":
      return String(i.skill ?? "");
    case "Agent":
    case "Task":
      return clip(String(i.description ?? ""));
    case "Read":
    case "Edit":
    case "Write":
      return path.basename(String(i.file_path ?? ""));
    case "WebFetch":
      return clip(String(i.url ?? ""));
    case "WebSearch":
      return clip(String(i.query ?? ""));
    default:
      return "";
  }
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((b) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : "")).join("")
      : "";

/** 1つのログファイル (メインのセッションか、1つのサブエージェント) の状態を、記録を順に読んで追う。 */
export class StateTracker {
  kind: StateKind = "none";
  since: string | null = null;
  lastTs: string | null = null;
  /** cli・claude-desktop・claude-vscode は対話、sdk-cli などは `claude -p` や SDK からの実行 */
  entrypoint: string | null = null;
  private pending = new Map<string, { name: string; detail: string; ts: string }>();

  private set(kind: StateKind, ts: string) {
    if (kind !== this.kind) this.since = ts;
    this.kind = kind;
  }

  feed(o: Json) {
    const ts: string | undefined = o.timestamp;
    if (!ts) return;
    if (o.entrypoint) this.entrypoint = String(o.entrypoint);
    if (o.type === "assistant") {
      this.lastTs = ts;
      if (o.isApiErrorMessage) {
        this.pending.clear();
        this.set("api_error", ts);
        return;
      }
      const m = o.message || {};
      for (const b of m.content || []) {
        if (b && typeof b === "object" && b.type === "tool_use" && b.id) {
          this.pending.set(b.id, { name: String(b.name), detail: toolDetail(String(b.name), b.input || {}), ts });
        }
      }
      if (m.stop_reason === "end_turn") {
        this.pending.clear();
        this.set("idle", ts);
      } else if (this.pending.size) {
        this.set(this.hasQuestion() ? "question" : "tool", ts);
      } else {
        this.set("thinking", ts);
      }
    } else if (o.type === "user") {
      const content = (o.message || {}).content;
      const results = Array.isArray(content)
        ? content.filter((b) => b && typeof b === "object" && b.type === "tool_result" && b.tool_use_id)
        : [];
      const text = textOf(content);
      // /model などのローカルコマンドは、応答を生まない
      if (text.includes("<local-command-caveat>")) return;
      this.lastTs = ts;
      if (text.includes("<local-command-stdout>")) {
        this.set("idle", ts);
      } else if (text.includes("[Request interrupted by user")) {
        this.pending.clear();
        this.set("interrupted", ts);
      } else if (results.length) {
        for (const b of results) this.pending.delete(b.tool_use_id);
        if (this.pending.size) this.set(this.hasQuestion() ? "question" : "tool", ts);
        else this.set("thinking", ts);
      } else if (!o.isMeta) {
        // 人の入力、またはタスクの完了通知などで、新しいターンが始まった
        this.pending.clear();
        this.set("thinking", ts);
      }
    }
  }

  private hasQuestion(): boolean {
    return [...this.pending.values()].some((p) => p.name === "AskUserQuestion");
  }

  /** 実行中・回答待ちのツール (質問を優先し、その中で新しいもの) */
  currentTool(): { name: string; detail: string } | null {
    const list = [...this.pending.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1));
    const p = list.find((x) => x.name === "AskUserQuestion") ?? list[0];
    return p ? { name: p.name, detail: p.detail } : null;
  }
}

const WORKING: StateKind[] = ["tool", "thinking"];

/**
 * フックの記録 (今の状態) とログ (遅れて書かれる、最後に観測できた状態) を合わせる。
 * フックの最後の記録がログの最後の記録より新しければフックを採る。ログのほうが新しければ、
 * フックが取れなかった出来事 (人の中断など) があったとみなしてログを採る。
 */
export function sessionState(main: StateTracker | null, subs: StateTracker[], hook: HookState | null): SessionState {
  if (hook && hook.kind !== "none" && (!main?.lastTs || hook.lastAt >= main.lastTs)) {
    return { kind: hook.kind, since: hook.since, tool: hook.tool, background: hook.agents, source: "hook" };
  }
  if (!main || main.kind === "none") return { kind: "none", since: null, tool: null, background: 0, source: "none" };
  const background =
    main.kind === "idle" || main.kind === "interrupted"
      ? subs.filter((s) => WORKING.includes(s.kind) && s.lastTs && main.since && s.lastTs > main.since).length
      : 0;
  // `claude -p` や SDK からの実行は、ターンを終えるとプロセスも終わる
  if (main.kind === "idle" && main.entrypoint?.startsWith("sdk")) {
    return { kind: "ended", since: main.since, tool: null, background: 0, source: hook ? "log" : "estimate" };
  }
  // フックの記録が無いセッションでは、ログから推定するしかない
  return { kind: main.kind, since: main.since, tool: main.currentTool(), background, source: hook ? "log" : "estimate" };
}
