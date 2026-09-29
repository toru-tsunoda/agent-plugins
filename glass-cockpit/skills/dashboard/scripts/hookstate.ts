/**
 * 状態記録フック (hooks/record_state.ts) が書いた JSONL を読み、セッションの今の状態に畳み込む。
 * セッションログ (トランスクリプト) は非同期に書かれて遅れるので、今の状態はこちらを主にする。
 */
import fs from "node:fs";
import path from "node:path";
import { configDir } from "./paths.ts";
import type { StateKind } from "./state.ts";

type Json = Record<string, any>;

/** 1イベント1行。フックの入力のうち、状態の判定に要るものだけを残す (1行を小さく保ち、追記を1回の write にする) */
export interface HookLine {
  at: string;
  ev: string;
  tool?: string;
  detail?: string;
  id?: string;
  ids?: string[];
  type?: string;
  agent?: string;
  reason?: string;
}

export interface HookState {
  kind: StateKind;
  since: string;
  /** 最後にフックが記録した時刻 */
  lastAt: string;
  tool: { name: string; detail: string } | null;
  /** 開始して、まだ終わっていないサブエージェントの数 */
  agents: number;
}

export const hookStateDir = (): string => path.join(configDir(), "glass-cockpit", "sessions");

export const hookStateFile = (sessionId: string): string =>
  path.join(hookStateDir(), sessionId.replace(/[^A-Za-z0-9_-]/g, "_") + ".jsonl");

/** 読むのは末尾だけ (長いセッションでも重くしない)。ターンの区切りより前は状態に効かない */
const TAIL_BYTES = 256 * 1024;

function readTail(file: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString("utf-8");
    // 途中から読んだ時は、最初の不完全な行を捨てる
    return len < size ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

export function foldHookLines(lines: HookLine[]): HookState | null {
  if (!lines.length) return null;
  // tool_use_id -> ツール。permission はその呼び出しで権限の確認を出したか。agent はサブエージェントの中の呼び出し
  const pending = new Map<string, { name: string; detail: string; permission: boolean; agent?: string }>();
  const agents = new Set<string>();
  // 親 (メインのエージェント) 自身の状態。サブエージェントの呼び出しでは変えない
  let base: StateKind = "none";
  let kind: StateKind = "none";
  let since = lines[0].at;
  let lastAt = lines[0].at;
  let synthetic = 0;

  // 人の操作が要る待ち (権限・質問) を優先し、次に親の実行中のツール、どちらも無ければ親自身の状態
  const derive = (): StateKind => {
    const list = [...pending.values()];
    if (list.some((p) => p.permission)) return "permission";
    if (list.some((p) => p.name === "AskUserQuestion" && !p.agent)) return "question";
    if (list.some((p) => !p.agent)) return "tool";
    return base;
  };
  const mainPending = () => [...pending.values()].some((p) => !p.agent);

  for (const l of lines) {
    if (l.at > lastAt) lastAt = l.at;
    switch (l.ev) {
      case "UserPromptSubmit":
        pending.clear();
        base = "thinking";
        break;
      case "PreToolUse":
        pending.set(l.id ?? `pre:${synthetic++}`, { name: l.tool ?? "", detail: l.detail ?? "", permission: false, agent: l.agent });
        if (!l.agent) base = "thinking";
        break;
      case "PermissionRequest": {
        // PermissionRequest の入力に tool_use_id があるとは限らないので、無ければ同じツール・同じ内容の未完了の呼び出しと照合する
        const hit =
          (l.id && pending.get(l.id)) ||
          [...pending.values()].find((p) => !p.permission && p.name === l.tool && p.detail === (l.detail ?? ""));
        if (hit) hit.permission = true;
        else pending.set(`perm:${synthetic++}`, { name: l.tool ?? "", detail: l.detail ?? "", permission: true, agent: l.agent });
        break;
      }
      case "Notification":
        if (l.type === "permission_prompt" && ![...pending.values()].some((p) => p.permission)) {
          pending.set(`perm:${synthetic++}`, { name: "", detail: "", permission: true });
        } else if (l.type === "elicitation_dialog" || l.type === "elicitation_url_dialog") {
          pending.set(`elicit:${synthetic++}`, { name: "AskUserQuestion", detail: "MCP の入力フォーム", permission: false });
        } else if (l.type === "idle_prompt") {
          pending.clear();
          base = "idle";
        }
        break;
      case "PostToolUse":
      case "PostToolUseFailure": {
        if (l.id && pending.has(l.id)) pending.delete(l.id);
        else {
          // ID で対応が取れない時は、同じツールの権限待ちを消す (許可・拒否のどちらかが済んでいる)
          const k = [...pending.entries()].find(([, p]) => p.name === l.tool && p.permission)?.[0];
          if (k) pending.delete(k);
        }
        // 権限の確認で足した仮の記録は、ツールが終われば用済み
        for (const [k, p] of pending) if (k.startsWith("perm:") && !p.name) pending.delete(k);
        if (!l.agent && !mainPending()) base = "thinking";
        break;
      }
      case "PostToolBatch":
        for (const id of l.ids ?? []) pending.delete(id);
        if (!mainPending()) base = "thinking";
        break;
      case "Stop":
        for (const [k, p] of pending) if (!p.agent) pending.delete(k);
        base = "idle";
        break;
      case "StopFailure":
        pending.clear();
        base = "api_error";
        break;
      case "SessionEnd":
        pending.clear();
        agents.clear();
        base = "ended";
        break;
      case "SubagentStart":
        if (l.agent) agents.add(l.agent);
        break;
      case "SubagentStop":
        if (l.agent) {
          agents.delete(l.agent);
          // そのサブエージェントの中の呼び出しで残ったもの (権限待ちなど) を消す
          for (const [k, p] of pending) if (p.agent === l.agent) pending.delete(k);
        }
        break;
    }
    const next = derive();
    if (next !== kind) since = l.at;
    kind = next;
  }
  const list = [...pending.values()];
  // 権限の確認が Notification だけで分かった時は、どのツールか分からないので、親の実行中のツールを出す
  const cur =
    list.find((p) => p.permission && p.name) ??
    list.find((p) => p.name === "AskUserQuestion") ??
    list.filter((p) => !p.agent && p.name).pop();
  return {
    kind,
    since,
    lastAt,
    tool: cur && (kind === "permission" || kind === "question" || kind === "tool") ? { name: cur.name, detail: cur.detail } : null,
    agents: agents.size,
  };
}

/** そのセッションのフックの記録が無ければ null (プラグインを読み込んでいないセッションなど) */
export function readHookState(sessionId: string): HookState | null {
  const text = readTail(hookStateFile(sessionId));
  if (text === null) return null;
  const lines: HookLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const o: Json = JSON.parse(raw);
      if (typeof o.at === "string" && typeof o.ev === "string") lines.push(o as HookLine);
    } catch {
      continue;
    }
  }
  return foldHookLines(lines);
}

/** 古い記録を消す (セッションログと同じく cleanupPeriodDays より古いもの) */
export function pruneHookStates(days: number): void {
  const dir = hookStateDir();
  const limit = Date.now() - days * 86400 * 1000;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const f = path.join(dir, n);
    try {
      if (fs.statSync(f).mtimeMs < limit) fs.unlinkSync(f);
    } catch {
      // 並行して消された時など
    }
  }
}
