import { afterEach, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, EmitSocket, emptyPage, oldSession, status, workspace, type AppState } from "./sessionController.testSupport";

afterEach(() => { vi.useRealTimers(); });

it("seeds extension UI from the snapshot, applies live updates, and lets toasts pass", async () => {
  vi.useFakeTimers();
  const socket = new EmitSocket();
  let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
  const seeded = { statuses: { goal: "active" }, widgets: [] };
  const controller = new SessionController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    undefined,
    {
      socket,
      api: {
        ...defaultApi,
        transcriptSnapshot: vi.fn(() => Promise.resolve({ page: emptyPage, status: status(oldSession.id), seq: 0, partial: null, extensionUi: seeded })),
      },
    },
  );

  await controller.selectSession(oldSession, { updateUrl: false });
  await vi.waitFor(() => { expect(state.extensionUi).toEqual(seeded); });

  // Published before the snapshot was taken, so already reflected in it.
  socket.emit({ type: "extension.ui", ui: { statuses: {}, widgets: [] }, seq: 0 });
  expect(state.extensionUi).toEqual(seeded);
  const live = { statuses: { goal: "complete" }, widgets: [{ key: "btw", lines: ["answer"] }] };
  socket.emit({ type: "extension.ui", ui: live, seq: 1 });
  expect(state.extensionUi).toEqual(live);

  socket.emit({ type: "extension.toast", message: "Goal waiting", seq: 2 });
  expect(state.extensionToasts.map((toast) => toast.message)).toEqual(["Goal waiting"]);
  vi.advanceTimersByTime(6000 + "Goal waiting".length * 50);
  expect(state.extensionToasts).toEqual([]);

  controller.clearActiveSession();
  expect(state.extensionUi).toBeUndefined();
  controller.dispose();
});

it("keeps the snapshot's open question until the branch changes", async () => {
  const socket = new EmitSocket();
  let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
  const openAsk = { askId: "ask-1", askedAt: "2026-07-20T10:00:00.000Z", questions: [{ id: "q", question: "Choose?", options: [] }] };
  const refreshed = deferred<Awaited<ReturnType<typeof defaultApi.transcriptSnapshot>>>();
  const transcriptSnapshot = vi.fn<typeof defaultApi.transcriptSnapshot>()
    .mockResolvedValueOnce({ page: emptyPage, status: status(oldSession.id), seq: 0, partial: null, openAsk })
    .mockReturnValueOnce(refreshed.promise);
  const controller = new SessionController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    undefined,
    { socket, api: { ...defaultApi, transcriptSnapshot } },
  );
  await controller.selectSession(oldSession, { updateUrl: false });
  await vi.waitFor(() => { expect(state.openAsk).toEqual(openAsk); });
  socket.emit({ type: "session.tree.changed", seq: 1 });
  expect(state.openAsk).toBeUndefined();
  refreshed.resolve({ page: emptyPage, status: status(oldSession.id), seq: 1, partial: null });
  controller.dispose();
});

it("forgets the previous session's widgets as soon as another session is selected", () => {
  const socket = new EmitSocket();
  const other = { ...oldSession, id: "other-session" };
  let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession, other] };
  const snapshot = deferred<Awaited<ReturnType<typeof defaultApi.transcriptSnapshot>>>();
  const controller = new SessionController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    undefined,
    { socket, api: { ...defaultApi, transcriptSnapshot: vi.fn(() => snapshot.promise) } },
  );
  void controller.selectSession(oldSession, { updateUrl: false });
  // Toasts are not part of the snapshot, so a pending read must not hold them back.
  socket.emit({ type: "extension.toast", message: "while loading", seq: 0 });
  expect(state.extensionToasts.map((toast) => toast.message)).toEqual(["while loading"]);
  state = { ...state, extensionUi: { statuses: {}, widgets: [{ key: "btw", lines: ["A"] }] } };
  void controller.selectSession(other, { updateUrl: false });
  expect(state.extensionUi).toBeUndefined();
  expect(state.extensionToasts).toEqual([]);
  controller.dispose();
});
