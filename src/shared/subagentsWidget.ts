/** pi-subagents publishes its async jobs in RPC mode as this widget: one line, prefix plus a versioned JSON snapshot. */
export const SUBAGENTS_WIDGET_KEY = "subagent-async";
const SUBAGENTS_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
const SUBAGENTS_KIND = "pi-subagents.async-status-snapshot";

type JsonRecord = Record<string, unknown>;

export interface SubagentSnapshot {
  runs: JsonRecord[];
  omittedRuns: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function subagentSnapshot(lines: readonly string[]): SubagentSnapshot | undefined {
  const line = lines[0];
  if (line?.startsWith(SUBAGENTS_PREFIX) !== true) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(SUBAGENTS_PREFIX.length));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed["kind"] !== SUBAGENTS_KIND || parsed["version"] !== 1 || !Array.isArray(parsed["runs"])) return undefined;
  const runs = parsed["runs"].filter(isRecord);
  if (runs.length === 0) return undefined;
  const omitted = parsed["omitted"];
  const omittedRuns = isRecord(omitted) ? omitted["runs"] : undefined;
  return { runs, omittedRuns: typeof omittedRuns === "number" && Number.isFinite(omittedRuns) ? omittedRuns : 0 };
}

/**
 * Whether a top-level run is running now. Queued, paused and finished runs do
 * not count. pi-subagents sorts running runs first, so its run-count cap keeps
 * them; only a snapshot whose byte cap drops every run reads as not running.
 */
export function hasRunningSubagent(snapshot: SubagentSnapshot | undefined): boolean {
  return snapshot?.runs.some((run) => run["state"] === "running") === true;
}
