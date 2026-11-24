import { describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../../shared/apiTypes";
import { WorkspaceActivityService } from "./workspaceActivityService";

function status(patch: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionId: "s1",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    ...patch,
  };
}

/** The service under test plus the change notifications it reported. */
function activityRecord() {
  const onChanged = vi.fn();
  return { service: new WorkspaceActivityService(onChanged), onChanged };
}

describe("WorkspaceActivityService", () => {
  it("records session activity by cwd and reports every change", () => {
    const { service, onChanged } = activityRecord();

    service.applySessionStatus("/repo", status({ isStreaming: true }));

    expect(service.snapshot().workspaces).toMatchObject([{ cwd: "/repo", hasSessionActivity: true, hasTerminalActivity: false }]);
    expect(onChanged).toHaveBeenCalledTimes(1);

    service.applySessionStatus("/repo", status({ isStreaming: false }));

    expect(service.snapshot().workspaces).toEqual([]);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("exposes individual active sessions even when they share a cwd", () => {
    const { service } = activityRecord();
    service.applySessionStatus("/repo", status({ sessionId: "s1", isStreaming: true }));
    service.applySessionActivity("/repo", { sessionId: "s2", phase: "active", label: "tool", at: "now" });
    service.updateTerminal({ id: "t1", cwd: "/terminal", exited: false });

    expect(service.snapshot().sessions).toEqual([
      { sessionId: "s1", cwd: "/repo" },
      { sessionId: "s2", cwd: "/repo" },
    ]);

    service.applySessionStatus("/repo", status());
    expect(service.snapshot().sessions).toEqual([{ sessionId: "s2", cwd: "/repo" }]);
    expect(service.snapshot().workspaces).toContainEqual({ cwd: "/repo", hasSessionActivity: true, hasTerminalActivity: false });

    service.applySessionActivity("/moved", { sessionId: "s2", phase: "active", label: "tool", at: "now" });
    expect(service.snapshot().sessions).toEqual([{ sessionId: "s2", cwd: "/moved" }]);
    service.removeSession("s2");
    expect(service.snapshot().sessions).toEqual([]);
  });

  it("retains idle intervention state without reporting work and clears it from status updates", () => {
    const { service, onChanged } = activityRecord();
    service.applySessionStatus("/repo", status({ interventionRequired: true }));

    expect(service.snapshot()).toEqual({
      workspaces: [],
      sessions: [],
      interventionSessions: [{ sessionId: "s1", cwd: "/repo" }],
      goalWaitingSessions: [],
      subagentsRunningSessions: [],
    });

    service.applySessionActivity("/moved", { sessionId: "s1", phase: "idle", label: "Idle", at: "now" });
    expect(service.snapshot().interventionSessions).toEqual([{ sessionId: "s1", cwd: "/moved" }]);

    service.applySessionStatus("/moved", status());
    expect(service.snapshot().interventionSessions).toEqual([]);
    expect(onChanged).toHaveBeenCalled();
  });

  it("keeps running subagents of an idle session through status updates and reports only changes", () => {
    const { service, onChanged } = activityRecord();
    const running = [{ sessionId: "s1", cwd: "/repo" }];
    service.applySubagentsRunning("/repo", "s1", false);
    expect(onChanged).not.toHaveBeenCalled();

    service.applySubagentsRunning("/repo", "s1", true);
    service.applySubagentsRunning("/repo", "s1", true);
    expect(onChanged).toHaveBeenCalledTimes(1);
    service.applySessionStatus("/repo", status());
    service.applyPersistedSessionState("/repo", "s1", { interventionRequired: false });
    expect(service.snapshot()).toMatchObject({ workspaces: [], sessions: [], subagentsRunningSessions: running });

    service.applySubagentsRunning("/repo", "s1", false);
    expect(service.snapshot().subagentsRunningSessions).toEqual([]);
    service.applySubagentsRunning("/repo", "s1", true);
    service.removeSession("s1");
    expect(service.snapshot().subagentsRunningSessions).toEqual([]);
  });

  it("seeds and clears intervention without replacing live status or activity", () => {
    const { service } = activityRecord();
    service.applySessionStatus("/repo", status({ isStreaming: true }));
    service.applySessionActivity("/repo", { sessionId: "s2", phase: "active", label: "tool", at: "now" });
    for (const sessionId of ["s1", "s2"]) {
      service.applyPersistedSessionState("/repo", sessionId, { interventionRequired: true });
      service.applyPersistedSessionState("/repo", sessionId, { interventionRequired: false });
    }

    expect(service.snapshot().sessions).toEqual([
      { sessionId: "s1", cwd: "/repo" },
      { sessionId: "s2", cwd: "/repo" },
    ]);
    expect(service.snapshot().interventionSessions).toEqual([]);

    service.applyPersistedSessionState("/idle", "s3", { interventionRequired: true });
    expect(service.snapshot().interventionSessions).toEqual([{ sessionId: "s3", cwd: "/idle" }]);
    service.applyPersistedSessionState("/idle", "s3", { interventionRequired: false });
    expect(service.snapshot().interventionSessions).toEqual([]);
  });

  it("removes and reconciles intervention records without clearing other workspaces", () => {
    const { service } = activityRecord();
    service.applyPersistedSessionState("/repo", "s1", { interventionRequired: true });
    service.applyPersistedSessionState("/repo", "s2", { interventionRequired: true });
    service.applyPersistedSessionState("/other", "s3", { interventionRequired: true });

    service.reconcileSessionActivity("/repo", ["s2"]);
    expect(service.snapshot().interventionSessions).toEqual([
      { sessionId: "s2", cwd: "/repo" },
      { sessionId: "s3", cwd: "/other" },
    ]);

    service.removeSession("s2");
    service.reconcileSessionActivity("/other", []);
    expect(service.snapshot().interventionSessions).toEqual([]);
  });

  it("does not report a workspace active for a session that is only starting up", () => {
    const { service, onChanged } = activityRecord();

    // Startup progress names a phase the daemon is inside; it is not work, so the
    // workspace (and the project indicators and remote machines that read it)
    // must not be reported as busy because of it.
    service.applySessionActivity("/repo", { sessionId: "s1", phase: "active", label: "Opening session", detail: "Starting the Pi session", at: "now", startup: true });

    expect(service.snapshot().sessions).toEqual([]);
    expect(service.snapshot().workspaces).toEqual([]);
    expect(onChanged).toHaveBeenCalled();
  });

  it("clears stale active activity when an idle status arrives", () => {
    const { service } = activityRecord();

    service.applySessionActivity("/repo", { sessionId: "s1", phase: "active", label: "running tool", detail: "read", at: "now" });
    service.applySessionStatus("/repo", status({ isStreaming: false }));

    expect(service.snapshot().workspaces).toEqual([]);
  });

  it("reports a change when removing an already-pruned session with a cwd", () => {
    const { service, onChanged } = activityRecord();

    service.removeSession("missing-session", "/repo");

    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("reconciles stale session activity for a workspace", () => {
    const { service, onChanged } = activityRecord();

    service.applySessionActivity("/repo", { sessionId: "s1", phase: "active", label: "running tool", at: "now" });
    service.applySessionActivity("/repo", { sessionId: "s2", phase: "active", label: "running tool", at: "now" });
    service.applySessionActivity("/other", { sessionId: "s3", phase: "active", label: "running tool", at: "now" });
    onChanged.mockClear();

    service.reconcileSessionActivity("/repo", ["s2"]);

    expect(service.snapshot().sessions).toEqual([
      { sessionId: "s2", cwd: "/repo" },
      { sessionId: "s3", cwd: "/other" },
    ]);
    expect(service.snapshot().workspaces).toMatchObject([
      { cwd: "/other", hasSessionActivity: true, hasTerminalActivity: false },
      { cwd: "/repo", hasSessionActivity: true, hasTerminalActivity: false },
    ]);

    service.reconcileSessionActivity("/repo", []);

    expect(service.snapshot().workspaces).toMatchObject([{ cwd: "/other", hasSessionActivity: true, hasTerminalActivity: false }]);
    expect(onChanged).toHaveBeenCalled();
  });

  it("combines sessions and terminals and clears closed terminals", () => {
    const { service, onChanged } = activityRecord();

    service.applySessionActivity("/repo", { sessionId: "s1", phase: "active", label: "running tool", detail: "read", at: "now" });
    service.updateTerminal({ id: "t1", cwd: "/repo", exited: false });

    expect(service.snapshot().workspaces).toMatchObject([{ cwd: "/repo", hasSessionActivity: true, hasTerminalActivity: true }]);

    service.removeSession("s1");
    service.updateTerminal({ id: "t1", cwd: "/repo", exited: true });

    expect(service.snapshot().workspaces).toEqual([]);
    expect(onChanged).toHaveBeenCalled();
  });
});
