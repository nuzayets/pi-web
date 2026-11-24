import { describe, expect, it } from "vitest";
import type { SubagentSnapshot } from "../../../shared/subagentsWidget";
import { hasLiveSubagents, subagentCounts, subagentRows } from "./subagents";

const runs = [
  { id: "a1", kind: "workflow", label: "reviewer, scout", state: "running", startedAt: 1_000, children: [
    { id: "s1", kind: "step", label: "review", agent: "reviewer", model: "poros/openai/gpt-6", state: "running", startedAt: 1_000, activity: { currentTool: "bash", turnCount: 3 }, progressText: " checking tests ", progressUpdatedAt: 81_000 },
    { id: "s2", kind: "step", label: "scout", agent: "scout", state: "complete", startedAt: 1_000, endedAt: 31_000, activity: { turnCount: 2 }, progressText: "stale" },
  ] },
  { id: "a2", kind: "subagent", label: "oracle", state: "failed", startedAt: 0, endedAt: 5_000 },
];
const snapshot: SubagentSnapshot = { runs, omittedRuns: 0 };

describe("pi-subagents async snapshot", () => {
  it("lists runs as an indented tree with elapsed times and running progress", () => {
    expect(subagentRows(snapshot, 91_000)).toEqual([
      { depth: 0, state: "failed", label: "oracle", elapsedMs: 5_000 },
      { depth: 0, state: "running", label: "reviewer, scout", elapsedMs: 90_000 },
      { depth: 1, state: "running", label: "review", agent: "reviewer", model: "gpt-6", tool: "bash", elapsedMs: 90_000, progress: "checking tests", progressAgeMs: 10_000 },
      { depth: 1, state: "complete", label: "scout", turns: 2, elapsedMs: 30_000 },
    ]);
    expect(subagentCounts(snapshot)).toEqual([{ state: "running", count: 1 }, { state: "failed", count: 1 }]);
    expect(hasLiveSubagents(subagentRows(snapshot, 91_000))).toBe(true);
    expect(hasLiveSubagents(subagentRows({ runs: [runs[1] ?? {}], omittedRuns: 0 }))).toBe(false);
  });

  it("shows a group holding one subagent as a single row", () => {
    const step = { id: "s", kind: "step", label: "reviewer", agent: "reviewer", model: "poros/openai/gpt-6", state: "complete", startedAt: 1_000, endedAt: 20_000, activity: { turnCount: 4 } };
    const rows = (run: Record<string, unknown>) => subagentRows({ runs: [run], omittedRuns: 0 }, 91_000);
    expect(rows({ id: "r", kind: "subagent", label: "reviewer", state: "failed", startedAt: 0, endedAt: 30_000, children: [step] })).toEqual([
      { depth: 0, state: "failed", label: "reviewer", model: "gpt-6", turns: 4, elapsedMs: 30_000 },
    ]);
    const nested = rows({ id: "w", kind: "workflow", label: "audit", state: "running", startedAt: 0, children: [{ ...step, children: [{ ...step, label: "scout", agent: "scout" }] }] });
    expect(nested.map((row) => [row.depth, row.label])).toEqual([[0, "audit › reviewer › scout"]]);
  });

  it("keeps runs in launch order whatever pi-subagents sends", () => {
    const first = { id: "b", label: "first", state: "running", startedAt: 1_000 };
    const second = { id: "a", label: "second", state: "running", startedAt: 2_000 };
    const tied = { id: "c", label: "tied", state: "queued", startedAt: 2_000 };
    const unstarted = { id: "d", label: "unstarted", state: "queued" };
    const labels = (order: Record<string, unknown>[]) => subagentRows({ runs: order, omittedRuns: 0 }).map((row) => row.label);
    const expected = ["first", "second", "tied", "unstarted"];
    expect(labels([unstarted, tied, second, first])).toEqual(expected);
    expect(labels([second, first, unstarted, tied])).toEqual(expected);
  });
});
