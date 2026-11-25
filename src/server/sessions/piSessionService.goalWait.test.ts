import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../piSdk.js";
import { WorkspaceActivityService } from "../activity/workspaceActivityService.js";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

type GoalSessionManager = ReturnType<typeof SessionManager.inMemory>;

const id = "goal-wait-session";
const activeGoal = { id: "goal-1", text: "Ship the release", status: "active", startedAt: 1, updatedAt: 1, iteration: 0, tokensUsed: 0, timeUsedSeconds: 0, baselineTokens: 0 };
const waitingGoal = { ...activeGoal, waiting: { reason: "Waiting for CI" } };
const pausedGoal = { ...activeGoal, status: "paused" };
const waitingSessions = [{ sessionId: id, cwd: "/workspace" }];

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A transcript whose branch ends with these pi-goal `goal-state` entries. */
function goalSession(...goals: unknown[]): GoalSessionManager {
  const manager = SessionManager.inMemory("/workspace", { id });
  manager.appendMessage({ role: "user", content: "Work on this", timestamp: Date.now() });
  for (const goal of goals) manager.appendCustomEntry("goal-state", { goal });
  return manager;
}

async function goalWaitService(options: { listed?: { goalWaiting?: boolean }; manager?: GoalSessionManager; reopened?: GoalSessionManager } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-goal-wait-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, `${id}.jsonl`);
  await writeFile(sessionFile, "persisted session\n");
  const manager = options.manager ?? goalSession(waitingGoal);
  const host = fakeRuntime(id, { sessionFile, sessionManager: manager });
  const runtimes = [host.runtime];
  if (options.reopened !== undefined) runtimes.push(fakeRuntime(id, { sessionFile, sessionManager: options.reopened }).runtime);
  let created = 0;
  const events = new CapturingSessionEventHub();
  const workspaceActivity = new WorkspaceActivityService();
  const record = { ...sessionRecord(id), path: sessionFile, ...options.listed };
  const service = new PiSessionService(events, {
    agentDir: dir, modelRuntime: testModelRuntime,
    sessionManager: sessionGateway([record]), archiveStore: emptyArchiveStore(),
    createAgentRuntime: () => {
      const runtime = runtimes[created++];
      return runtime === undefined ? Promise.reject(new Error("unexpected runtime creation")) : Promise.resolve(runtime);
    },
    workspaceActivity, heartbeatIntervalMs: 60_000,
  });
  cleanups.push(() => service.dispose());
  // pi-goal persists through `pi.appendEntry`, which the SDK reports as entry_appended.
  const appendGoalState = (goal: unknown): void => {
    manager.appendCustomEntry("goal-state", { goal });
    host.emit({ type: "entry_appended", entry: manager.getEntries().at(-1) });
  };
  const lastStatusUpdate = () => events.globalEvents.filter((event) => event.type === "status.update").at(-1);
  return { service, workspaceActivity, host, manager, appendGoalState, lastStatusUpdate };
}

describe("Goal waiting projection", () => {
  it("binds from the current branch and follows hosted Goal state replacements", async () => {
    const manager = SessionManager.inMemory("/workspace", { id });
    const root = manager.appendMessage({ role: "user", content: "Work on this", timestamp: Date.now() });
    manager.appendCustomEntry("goal-state", { goal: waitingGoal });
    // Tree navigation left that wait on another branch, so pi-goal does not restore it.
    manager.branch(root);
    const { service, workspaceActivity, appendGoalState, lastStatusUpdate } = await goalWaitService({ manager });
    const initial = await service.status(sessionRef(id));
    expect(initial.goalWaiting).toBe(false);
    expect(initial).not.toHaveProperty("hasBackgroundWork");

    appendGoalState(waitingGoal);
    expect(lastStatusUpdate()).toMatchObject({ status: { sessionId: id, goalWaiting: true, hasBackgroundWork: true } });
    expect(workspaceActivity.snapshot().goalWaitingSessions).toEqual(waitingSessions);
    expect((await service.list("/workspace"))[0]?.goalWaiting).toBe(true);

    // An active Goal continues on its own even when it is not waiting.
    appendGoalState(activeGoal);
    expect(lastStatusUpdate()).toMatchObject({ status: { sessionId: id, goalWaiting: false, hasBackgroundWork: true } });
    expect(workspaceActivity.snapshot().goalWaitingSessions).toEqual([]);
    expect((await service.list("/workspace"))[0]?.goalWaiting).toBe(false);

    appendGoalState(pausedGoal);
    expect(lastStatusUpdate()).toMatchObject({ status: { sessionId: id, goalWaiting: false } });
    expect(lastStatusUpdate()).not.toHaveProperty("status.hasBackgroundWork");
  });

  it("keeps a stopped session waiting only when shutdown persisted a wait, and clears it meanwhile", async () => {
    for (const { shutdownGoal, expected } of [{ shutdownGoal: pausedGoal, expected: [] }, { shutdownGoal: waitingGoal, expected: waitingSessions }]) {
      const { service, workspaceActivity, host, manager } = await goalWaitService();
      await service.status(sessionRef(id));
      expect(workspaceActivity.snapshot().goalWaitingSessions).toEqual(waitingSessions);
      let duringShutdown: unknown;
      host.runtime.dispose = () => {
        duringShutdown = workspaceActivity.snapshot().goalWaitingSessions;
        // pi-goal persists its final state from session_shutdown, after the abort.
        manager.appendCustomEntry("goal-state", { goal: shutdownGoal });
        return Promise.resolve();
      };

      await service.stop(sessionRef(id));

      expect(service.activeCount()).toBe(0);
      expect(duringShutdown).toEqual([]);
      expect(workspaceActivity.snapshot().goalWaitingSessions).toEqual(expected);
    }
  });

  it("does not restore a wait over a runtime that reopened the session during shutdown", async () => {
    const { service, workspaceActivity, host, manager } = await goalWaitService({ reopened: goalSession(activeGoal) });
    await service.status(sessionRef(id));
    host.runtime.dispose = async () => {
      manager.appendCustomEntry("goal-state", { goal: waitingGoal });
      await service.status(sessionRef(id));
    };

    await service.stop(sessionRef(id));

    expect(service.activeCount()).toBe(1);
    expect((await service.status(sessionRef(id))).goalWaiting).toBe(false);
    expect(workspaceActivity.snapshot().goalWaitingSessions).toEqual([]);
  });

  it("seeds a cold wait from its workspace listing, not from the machine-wide startup restore", async () => {
    const { service, workspaceActivity } = await goalWaitService({ listed: { goalWaiting: true } });
    await service.restoreInterventionState();
    expect(workspaceActivity.snapshot().goalWaitingSessions).toEqual([]);

    expect((await service.list("/workspace"))[0]?.goalWaiting).toBe(true);
    expect(workspaceActivity.snapshot().goalWaitingSessions).toEqual(waitingSessions);
    expect(service.activeCount()).toBe(0);
  });
});
