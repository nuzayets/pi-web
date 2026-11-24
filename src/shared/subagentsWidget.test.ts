import { describe, expect, it } from "vitest";
import { hasRunningSubagent, subagentSnapshot } from "./subagentsWidget";

const kind = "pi-subagents.async-status-snapshot";
const run = (id: string, state: string) => ({ id, kind: "subagent", label: "worker", state, startedAt: 1_000, updatedAt: 2_000 });
const runs = [run("a1", "running"), run("a2", "failed")];
const wire = (value: unknown) => [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(value)}`];
// The widget line pi-subagents 0.90.0 renders for one running job.
const published = wire({
  kind, version: 1, generatedAt: 3_000,
  caps: { maxRuns: 20, maxChildrenPerNode: 8, maxDepth: 3, maxStringLength: 160, maxSerializedBytes: 32_768 },
  omitted: { runs: 0, children: 0, byteLimitExceeded: false },
  runs: [run("a1", "running")],
});

describe("pi-subagents async snapshot", () => {
  it("reads version 1 snapshots and ignores others", () => {
    expect(subagentSnapshot(wire({ kind, version: 1, omitted: { runs: 3 }, runs }))).toEqual({ runs, omittedRuns: 3 });
    expect(subagentSnapshot(wire({ kind, version: 2, runs }))).toBeUndefined();
    expect(subagentSnapshot(wire({ kind, version: 1, runs: [] }))).toBeUndefined();
    expect(subagentSnapshot(["PI_SUBAGENT_ASYNC_JSON:{"])).toBeUndefined();
    expect(subagentSnapshot(["plain line"])).toBeUndefined();
  });

  it("counts only top-level runs in the running state", () => {
    expect(hasRunningSubagent(subagentSnapshot(published))).toBe(true);
    expect(hasRunningSubagent(subagentSnapshot(wire({ kind, version: 1, runs })))).toBe(true);
    for (const state of ["queued", "paused", "complete", "failed", "partial", "stopped", "rejected", "blocked"]) {
      expect(hasRunningSubagent(subagentSnapshot(wire({ kind, version: 1, runs: [{ ...run("a1", state), children: [run("s1", "running")] }] })))).toBe(false);
    }
    expect(hasRunningSubagent(subagentSnapshot(wire({ kind, version: 2, runs })))).toBe(false);
    expect(hasRunningSubagent(undefined)).toBe(false);
  });
});
