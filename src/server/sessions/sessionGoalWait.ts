import { isRecord } from "./sessionFileFormat.js";

/**
 * Custom entry that the `@narumitw/pi-goal` extension appends with its whole
 * current Goal state. Each entry replaces every earlier one.
 */
const GOAL_STATE_CUSTOM_TYPE = "goal-state";

/** What a `goal-state` entry says about the session's Goal. */
export type SessionGoalState = "none" | "active" | "waiting";

/**
 * The Goal state a `goal-state` entry records, or undefined for any other entry.
 *
 * This mirrors how pi-goal 0.55.4 restores the entry: entries with the removed
 * queue fields hold no Goal, only an `active` Goal continues on its own, and a
 * wait counts only on an active Goal and only with a non-empty reason. Every
 * other Goal state, including a paused or cleared Goal, is no active Goal.
 */
export function goalStateFromEntry(entry: unknown): SessionGoalState | undefined {
  if (!isRecord(entry) || entry["type"] !== "custom" || entry["customType"] !== GOAL_STATE_CUSTOM_TYPE) return undefined;
  const data = entry["data"];
  if (!isRecord(data) || Object.hasOwn(data, "queue") || Object.hasOwn(data, "pendingAction")) return "none";
  const goal = data["goal"];
  if (!isRecord(goal) || goal["status"] !== "active") return "none";
  const waiting = goal["waiting"];
  const reason = isRecord(waiting) ? waiting["reason"] : undefined;
  return typeof reason === "string" && reason.trim() !== "" ? "waiting" : "active";
}

/** Whether a `goal-state` entry records an active Goal that is waiting to resume, or undefined for any other entry. */
export function goalWaitingFromEntry(entry: unknown): boolean | undefined {
  const state = goalStateFromEntry(entry);
  return state === undefined ? undefined : state === "waiting";
}

/** Latest Goal state on a session branch, the entries pi-goal restores from. */
export function sessionGoalState(branch: readonly unknown[]): SessionGoalState {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const state = goalStateFromEntry(branch[index]);
    if (state !== undefined) return state;
  }
  return "none";
}

export function sessionGoalWaiting(branch: readonly unknown[]): boolean {
  return sessionGoalState(branch) === "waiting";
}
