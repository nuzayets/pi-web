import type { SubagentSnapshot } from "../../../shared/subagentsWidget";

export const SUBAGENT_SUMMARY_STATES = ["running", "queued", "complete", "failed", "paused", "partial", "stopped", "rejected"] as const;
export type SubagentSummaryState = typeof SUBAGENT_SUMMARY_STATES[number];

type JsonRecord = Record<string, unknown>;

export interface SubagentRow {
  depth: number;
  state: string;
  label: string;
  agent?: string;
  model?: string;
  /** The running subagent's current tool. */
  tool?: string;
  turns?: number;
  elapsedMs?: number;
  /** The running subagent's latest progress report and its age. */
  progress?: string;
  progressAgeMs?: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function countOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// pi-subagents orders runs by state and latest activity, so parallel runs swap places on every update; keep launch order.
function orderedRuns(runs: readonly JsonRecord[]): JsonRecord[] {
  const started = (run: JsonRecord) => countOf(run["startedAt"]) ?? Number.POSITIVE_INFINITY;
  return [...runs].sort((left, right) =>
    started(left) - started(right) || (textOf(left["id"]) ?? "").localeCompare(textOf(right["id"]) ?? ""));
}

// A group holding one subagent shows as that subagent's row, with the group's state and timing.
function onlyChildMerged(group: JsonRecord): JsonRecord {
  const children = group["children"];
  const child: unknown = Array.isArray(children) && children.length === 1 ? children[0] : undefined;
  if (!isRecord(child)) return group;
  const groupLabel = textOf(group["label"]);
  const childLabel = textOf(child["label"]);
  const label = groupLabel === undefined || childLabel === undefined || childLabel === groupLabel || textOf(child["agent"]) === groupLabel
    ? childLabel ?? groupLabel
    : `${groupLabel} › ${childLabel}`;
  return onlyChildMerged({
    ...child,
    label,
    state: group["state"] ?? child["state"],
    startedAt: group["startedAt"] ?? child["startedAt"],
    endedAt: group["endedAt"] ?? child["endedAt"],
    updatedAt: group["updatedAt"] ?? child["updatedAt"],
  });
}

/** Flattens the snapshot into indented rows with elapsed times as of `now`. */
export function subagentRows(snapshot: SubagentSnapshot, now = Date.now()): SubagentRow[] {
  const rows: SubagentRow[] = [];
  const visit = (group: JsonRecord, depth: number) => {
    const node = onlyChildMerged(group);
    const state = textOf(node["state"]) ?? "partial";
    const label = textOf(node["label"]) ?? "subagent";
    const activity = isRecord(node["activity"]) ? node["activity"] : {};
    const row: SubagentRow = { depth, state, label };
    const agent = textOf(node["agent"]);
    if (agent !== undefined && agent !== label) row.agent = agent;
    const model = textOf(node["model"]);
    if (model !== undefined) row.model = model.split("/").at(-1) ?? model;
    const tool = textOf(activity["currentTool"]);
    const turns = countOf(activity["turnCount"]);
    if (state === "running" && tool !== undefined) row.tool = tool;
    else if (turns !== undefined) row.turns = turns;
    const started = countOf(node["startedAt"]);
    const ended = countOf(node["endedAt"]) ?? (state === "running" || state === "queued" ? now : countOf(node["updatedAt"]));
    if (started !== undefined && ended !== undefined) row.elapsedMs = Math.max(0, ended - started);
    // The child's latest progress report; stale once it stops running.
    const progressText = node["progressText"];
    const progress = state === "running" && typeof progressText === "string" ? textOf(progressText.trim()) : undefined;
    if (progress !== undefined) {
      row.progress = progress;
      const updated = countOf(node["progressUpdatedAt"]);
      if (updated !== undefined) row.progressAgeMs = Math.max(0, now - updated);
    }
    rows.push(row);
    const children = node["children"];
    if (Array.isArray(children)) for (const child of children) if (isRecord(child)) visit(child, depth + 1);
  };
  for (const run of orderedRuns(snapshot.runs)) visit(run, 0);
  return rows;
}

/** Top-level run counts per state, in display order. */
export function subagentCounts(snapshot: SubagentSnapshot): { state: SubagentSummaryState; count: number }[] {
  const counts = new Map<string, number>();
  for (const run of snapshot.runs) {
    const state = textOf(run["state"]) ?? "partial";
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return SUBAGENT_SUMMARY_STATES.flatMap((state) => {
    const count = counts.get(state);
    return count === undefined ? [] : [{ state, count }];
  });
}

/** Elapsed times tick only while something runs. */
export function hasLiveSubagents(rows: readonly SubagentRow[]): boolean {
  return rows.some((row) => row.state === "running" || row.state === "queued");
}
