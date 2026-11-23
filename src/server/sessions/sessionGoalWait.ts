import { isRecord } from "./sessionFileFormat.js";

/**
 * Custom entry that the `@narumitw/pi-goal` extension appends with its whole
 * current Goal state. Each entry replaces every earlier one.
 */
const GOAL_STATE_CUSTOM_TYPE = "goal-state";

/**
 * Whether a `goal-state` entry records an active Goal that is waiting to
 * resume, or undefined for any other entry.
 *
 * This mirrors how pi-goal 0.55.4 restores the entry: entries with the removed
 * queue fields hold no Goal, and a wait counts only on an active Goal and only
 * with a non-empty reason. Every other Goal state, including a cleared Goal,
 * means not waiting.
 */
export function goalWaitingFromEntry(entry: unknown): boolean | undefined {
  if (!isRecord(entry) || entry["type"] !== "custom" || entry["customType"] !== GOAL_STATE_CUSTOM_TYPE) return undefined;
  const data = entry["data"];
  if (!isRecord(data) || Object.hasOwn(data, "queue") || Object.hasOwn(data, "pendingAction")) return false;
  const goal = data["goal"];
  const waiting = isRecord(goal) && goal["status"] === "active" ? goal["waiting"] : undefined;
  const reason = isRecord(waiting) ? waiting["reason"] : undefined;
  return typeof reason === "string" && reason.trim() !== "";
}

/** Latest Goal state on a session branch, the entries pi-goal restores from. */
export function sessionGoalWaiting(branch: readonly unknown[]): boolean {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const waiting = goalWaitingFromEntry(branch[index]);
    if (waiting !== undefined) return waiting;
  }
  return false;
}
