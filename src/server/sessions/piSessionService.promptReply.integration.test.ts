import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "pi-web-typebox";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentSession, DefaultResourceLoader, defineTool, SessionManager, SettingsManager,
  type AgentSession, type ExtensionContext, type InlineExtension, type SessionBoundaryDraft,
} from "../../piSdk.js";
import type { ExtensionWidget, PromptReplyLink } from "../../shared/apiTypes.js";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { PiSessionService, type PiSessionServiceDependencies } from "./piSessionService.js";
import { CapturingSessionEventHub, createTestModelRuntime, emptyArchiveStore, testModel } from "./piSessionService.testSupport.js";

// Real SDK dispatch, persistence and run ordering; only runtime construction,
// model transport and one extension are substituted. The link needs an SDK
// whose preflightResult passes the dispatched user message (the p5yr hook);
// with any other SDK the same submissions must stay silent. A busy prompt's
// link also needs the queued message, which an SDK may report or not.
const sdkReportsPromptMessages = await withHostedSession([reply([{ type: "text", text: "Probe" }])], [], async ({ session }) => {
  let reported: unknown;
  await session.prompt("Probe", { preflightResult: (_disposition, message?: unknown) => { reported = message; } });
  return typeof reported === "object" && reported !== null;
});
const probeRun = heldReply([{ type: "text", text: "Probe" }]);
const sdkReportsQueuedMessages = sdkReportsPromptMessages && await withHostedSession([probeRun.reply, reply([{ type: "text", text: "Queued" }])], [], async ({ session }) => {
  let reported: unknown;
  const run = session.prompt("Probe");
  await probeRun.requested;
  await session.prompt("Queued", { streamingBehavior: "followUp", preflightResult: (_disposition, message?: unknown) => { reported = message; } });
  probeRun.release();
  await run;
  return typeof reported === "object" && reported !== null;
});

describe.runIf(sdkReportsPromptMessages)("prompt reply link with an SDK that reports prompt messages", () => {
  it("links the run's settled final to its request once, after a tool round", async () => {
    await withHostedSession([
      reply([{ type: "toolCall", id: "lookup-call", name: "lookup", arguments: {} }]),
      reply([{ type: "text", text: "Final" }]),
      reply([{ type: "text", text: "Unrequested" }]),
    ], [], async ({ service, ref, session, hub }) => {
      await service.prompt(ref, "Look it up", undefined, undefined, { requestId: "voice-1" });
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      const final = session.sessionManager.getBranch().at(-1);
      expect(final?.type === "message" && final.message.role === "assistant" && final.message.stopReason).toBe("stop");
      expect(promptReplies(hub)).toEqual([{ requestId: "voice-1", entryId: final?.id }]);
      // Both assistant entries were linked to their streams; only the final answers the request.
      expect(hub.sessionEvents.filter(({ event }) => event.type === "assistant.saved").map(({ event }) => event.type === "assistant.saved" && event.entryId))
        .toEqual([expect.any(String), final?.id]);

      // A later run without a request ID is never attributed to the earlier one.
      await service.prompt(ref, "Again");
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(2); });
      expect(promptReplies(hub)).toHaveLength(1);
    });
  });

  const continuations: { change: string; drafts: (ctx: ExtensionContext) => SessionBoundaryDraft[]; input: string }[] = [
    {
      change: "a hidden custom message",
      drafts: () => [{ type: "custom_message", customType: "prompt-reply-test", content: "Keep going", display: false }],
      input: "Keep going",
    },
    {
      change: "a compaction",
      drafts: () => [{ type: "compaction", summary: "Extension summary", firstKeptEntryId: null }],
      input: "Extension summary",
    },
    {
      change: "a rewrite of the requested message",
      drafts: (ctx) => [
        { type: "context_edit", targetId: lastMessageEntryId(ctx, "user"), replacement: { content: "Rewritten request" } },
        // Omitting the first stop lets the run continue from the rewritten request.
        { type: "context_edit", targetId: lastMessageEntryId(ctx, "assistant"), replacement: null },
      ],
      input: "Rewritten request",
    },
  ];

  it.each(continuations)("stays silent when an extension continues the run with $change", async ({ drafts, input }) => {
    await withHostedSession([
      reply([{ type: "text", text: "First stop" }]),
      reply([{ type: "text", text: "Continued final" }]),
    ], [continueOnceBeforeSettle(drafts)], async ({ service, ref, hub, modelRequests }) => {
      await service.prompt(ref, "Answer", undefined, undefined, { requestId: "voice-1" });
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      expect(modelRequests[1]).toContain(input);
      expect(hub.sessionEvents.filter(({ event }) => event.type === "assistant.saved")).toHaveLength(2);
      expect(promptReplies(hub)).toEqual([]);
    });
  });

  it.runIf(!sdkReportsQueuedMessages)("stays silent for both requests when the SDK does not report a queued prompt's message", async () => {
    const first = heldReply([{ type: "text", text: "Answer to first" }]);
    await withHostedSession([first.reply, reply([{ type: "text", text: "Answer to second" }])], [], async ({ service, ref, session, hub }) => {
      await service.prompt(ref, "First", undefined, undefined, { requestId: "voice-1" });
      await first.requested;
      await service.prompt(ref, "Second", undefined, undefined, { requestId: "voice-2" });
      await vi.waitFor(() => { expect(session.getFollowUpMessages()).toEqual(["Second"]); });
      first.release();
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      expect(modelInputKinds(session)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(promptReplies(hub)).toEqual([]);
    });
  });

  it("stays silent when a steered prompt joins a run that a custom message started", async () => {
    const holding = latch();
    const release = latch();
    await withHostedSession([reply([{ type: "text", text: "Answer to both" }])], [holdFirstRunStart(holding.resolve, release.promise)], async ({ service, ref, session, hub }) => {
      const foreignRun = session.sendCustomMessage({ customType: "foreign", content: "Foreign work", display: true }, { triggerTurn: true });
      await holding.promise;
      await service.prompt(ref, "Steered", "steer", undefined, { requestId: "voice-1" });
      await vi.waitFor(() => { expect(session.getSteeringMessages()).toEqual(["Steered"]); });
      release.resolve();
      await foreignRun;
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      // The steered prompt reached the model before the run's only reply.
      expect(modelInputKinds(session)).toEqual(["custom_message", "user", "assistant"]);
      expect(promptReplies(hub)).toEqual([]);
    });
  });

  it("stays silent when a custom message is steered into the prompt's run before its reply", async () => {
    const holding = latch();
    const release = latch();
    await withHostedSession([reply([{ type: "text", text: "Answer to both" }])], [holdFirstRunStart(holding.resolve, release.promise)], async ({ service, ref, session, hub }) => {
      await service.prompt(ref, "Answer", undefined, undefined, { requestId: "voice-1" });
      await holding.promise;
      await session.sendCustomMessage({ customType: "foreign", content: "Foreign work", display: true }, { deliverAs: "steer" });
      release.resolve();
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      expect(modelInputKinds(session)).toEqual(["user", "custom_message", "assistant"]);
      expect(promptReplies(hub)).toEqual([]);
    });
  });

  it("stays silent when the run is aborted", async () => {
    const pending = latch();
    await withHostedSession([
      reply([{ type: "toolCall", id: "lookup-call", name: "lookup", arguments: {} }]),
      replyUntilAborted(pending.resolve),
    ], [], async ({ service, ref, hub }) => {
      await service.prompt(ref, "Look it up", undefined, undefined, { requestId: "voice-1" });
      await pending.promise;
      await service.abort(ref);
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      expect(promptReplies(hub)).toEqual([]);
    });
  });

  it("stays silent when the final reply is a provider error", async () => {
    await withHostedSession([failedReply("Provider unavailable")], [], async ({ service, ref, session, hub }) => {
      await service.prompt(ref, "Answer", undefined, undefined, { requestId: "voice-1" });
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      const final = session.sessionManager.getBranch().at(-1);
      expect(final?.type === "message" && final.message.role === "assistant" && final.message.stopReason).toBe("error");
      expect(promptReplies(hub)).toEqual([]);
    });
  });
});

describe.runIf(sdkReportsQueuedMessages)("busy prompt reply link with an SDK that also reports queued messages", () => {
  it("links a spoken follow-up queued behind a typed prompt to the run's final, live only", async () => {
    const typed = heldReply([{ type: "text", text: "Answer to typed" }]);
    await withHostedSession([typed.reply, reply([{ type: "text", text: "Answer to spoken" }]), reply([{ type: "text", text: "Later" }])], [], async ({ service, ref, session, hub }) => {
      await service.prompt(ref, "Typed");
      await typed.requested;
      await service.prompt(ref, "Spoken", "followUp", undefined, { requestId: "voice-1" });
      await vi.waitFor(() => { expect(session.getFollowUpMessages()).toEqual(["Spoken"]); });
      typed.release();
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      expect(modelInputKinds(session)).toEqual(["user", "assistant", "user", "assistant"]);
      const final = session.sessionManager.getBranch().at(-1);
      expect(promptReplies(hub)).toEqual([{ requestId: "voice-1", entryId: final?.id }]);
      // Only the live agent_settled frame carries it: what a reconnecting client reads does not.
      expect(hub.sessionEvents.filter(({ event }) => JSON.stringify(event).includes("voice-1"))).toHaveLength(1);
      for (const snapshot of [await service.transcriptSnapshot(ref), await service.streamSnapshot(ref), await service.status(ref)]) {
        expect(JSON.stringify(snapshot)).not.toContain("voice-1");
      }

      await service.prompt(ref, "Again");
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(2); });
      expect(promptReplies(hub)).toHaveLength(1);
    });
  });

  it("links a spoken steer that the run consumes after a tool round", async () => {
    const tool = heldReply([{ type: "toolCall", id: "lookup-call", name: "lookup", arguments: {} }]);
    await withHostedSession([tool.reply, reply([{ type: "text", text: "Answer to steer" }])], [], async ({ service, ref, session, hub }) => {
      await service.prompt(ref, "Look it up");
      await tool.requested;
      await service.prompt(ref, "Steered", "steer", undefined, { requestId: "voice-1" });
      await vi.waitFor(() => { expect(session.getSteeringMessages()).toEqual(["Steered"]); });
      tool.release();
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      expect(modelInputKinds(session)).toEqual(["user", "assistant", "toolResult", "user", "assistant"]);
      expect(promptReplies(hub)).toEqual([{ requestId: "voice-1", entryId: session.sessionManager.getBranch().at(-1)?.id }]);
    });
  });

  it("links only the run's last input, not an earlier one that had its own reply", async () => {
    const first = heldReply([{ type: "text", text: "Answer to first" }]);
    await withHostedSession([
      first.reply, reply([{ type: "text", text: "Answer to second" }]), reply([{ type: "text", text: "Answer to third" }]),
    ], [], async ({ service, ref, session, hub }) => {
      await service.prompt(ref, "First", undefined, undefined, { requestId: "voice-1" });
      await first.requested;
      await service.prompt(ref, "Second", "followUp", undefined, { requestId: "voice-2" });
      await service.prompt(ref, "Third", "followUp", undefined, { requestId: "voice-3" });
      await vi.waitFor(() => { expect(session.getFollowUpMessages()).toEqual(["Second", "Third"]); });
      first.release();
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      expect(modelInputKinds(session)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
      expect(promptReplies(hub)).toEqual([{ requestId: "voice-3", entryId: session.sessionManager.getBranch().at(-1)?.id }]);
    });
  });

  it.each([
    { batch: "two devices", requests: ["device-a-1", "device-b-1"] },
    { batch: "one device", requests: ["device-a-1", "device-a-2"] },
    { batch: "a spoken and a typed steer", requests: ["device-a-1", undefined] },
  ])("stays silent for steers delivered together from $batch", async ({ requests }) => {
    const typed = heldReply([{ type: "text", text: "Answer to typed" }]);
    await withHostedSession([typed.reply, reply([{ type: "text", text: "One answer to both" }])], [], async ({ service, ref, session, hub }) => {
      await service.prompt(ref, "Typed");
      await typed.requested;
      for (const [index, requestId] of requests.entries()) {
        await service.prompt(ref, `Steer ${String(index)}`, "steer", undefined, requestId === undefined ? undefined : { requestId });
      }
      await vi.waitFor(() => { expect(session.getSteeringMessages()).toEqual(["Steer 0", "Steer 1"]); });
      typed.release();
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      expect(modelInputKinds(session)).toEqual(["user", "assistant", "user", "user", "assistant"]);
      expect(promptReplies(hub)).toEqual([]);
    }, { steeringMode: "all" });
  });

  it("links the queued request, not the same text a second device sent while it waited", async () => {
    const typed = heldReply([{ type: "text", text: "Answer to typed" }]);
    await withHostedSession([typed.reply, reply([{ type: "text", text: "Answer to same" }])], [], async ({ service, ref, session, hub }) => {
      await service.prompt(ref, "Typed");
      await typed.requested;
      await service.prompt(ref, "Same", "followUp", undefined, { requestId: "device-a-1" });
      await vi.waitFor(() => { expect(session.getFollowUpMessages()).toEqual(["Same"]); });
      // A duplicate of queued text is dropped before the SDK.
      await service.prompt(ref, "Same", "followUp", undefined, { requestId: "device-b-1" });
      typed.release();
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      expect(modelInputKinds(session)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(promptReplies(hub)).toEqual([{ requestId: "device-a-1", entryId: session.sessionManager.getBranch().at(-1)?.id }]);
    });
  });

  it("stays silent when the same text, typed, is the run's last input", async () => {
    const typed = heldReply([{ type: "text", text: "Answer to typed" }]);
    const spoken = heldReply([{ type: "text", text: "Answer to spoken" }]);
    await withHostedSession([typed.reply, spoken.reply, reply([{ type: "text", text: "Answer to same, typed" }])], [], async ({ service, ref, session, hub }) => {
      await service.prompt(ref, "Typed");
      await typed.requested;
      await service.prompt(ref, "Same", "followUp", undefined, { requestId: "device-a-1" });
      await vi.waitFor(() => { expect(session.getFollowUpMessages()).toEqual(["Same"]); });
      typed.release();
      await spoken.requested;
      await service.prompt(ref, "Same", "followUp");
      await vi.waitFor(() => { expect(session.getFollowUpMessages()).toEqual(["Same"]); });
      spoken.release();
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      expect(modelInputKinds(session)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
      expect(promptReplies(hub)).toEqual([]);
    });
  });

  const retractions: { retraction: string; retract: (service: PiSessionService, ref: { id: string; cwd: string }) => Promise<unknown> }[] = [
    { retraction: "removed", retract: (service, ref) => service.mutateQueueMessage(ref, { action: "remove", index: 0, expectedQueue: [{ kind: "followUp", text: "Spoken" }] }) },
    {
      retraction: "edited and sent again",
      retract: async (service, ref) => {
        await service.mutateQueueMessage(ref, { action: "edit", index: 0, expectedQueue: [{ kind: "followUp", text: "Spoken" }] });
        await service.prompt(ref, "Spoken, edited", "followUp");
      },
    },
    { retraction: "cleared", retract: (service, ref) => service.clearQueue(ref) },
  ];

  it.each(retractions)("stays silent for a queued request that is $retraction", async ({ retract }) => {
    const typed = heldReply([{ type: "text", text: "Answer to typed" }]);
    await withHostedSession([typed.reply, reply([{ type: "text", text: "Answer to edit" }])], [], async ({ service, ref, session, hub }) => {
      await service.prompt(ref, "Typed");
      await typed.requested;
      await service.prompt(ref, "Spoken", "followUp", undefined, { requestId: "voice-1" });
      await vi.waitFor(() => { expect(session.getFollowUpMessages()).toEqual(["Spoken"]); });
      await retract(service, ref);
      typed.release();
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      expect(JSON.stringify(session.sessionManager.getBranch())).not.toContain("\"Spoken\"");
      expect(promptReplies(hub)).toEqual([]);
    });
  });

  it.each([false, true])("clearing a selected follow-up before delivery retires only old requests (new follow-up: %s)", async (sendAfterClear) => {
    const typed = heldReply([{ type: "text", text: "Answer to typed" }]);
    const turnStarted = latch();
    const deliver = latch();
    const holdDelivery: InlineExtension = (pi) => {
      pi.on("turn_start", async ({ turnIndex }) => {
        if (turnIndex !== 1) return;
        turnStarted.resolve();
        await deliver.promise;
      });
    };
    await withHostedSession([typed.reply, reply([{ type: "text", text: "Answer to cleared" }]), reply([{ type: "text", text: "Answer to new" }])], [holdDelivery], async ({ service, ref, session, hub, modelRequests }) => {
      try {
        await service.prompt(ref, "Typed");
        await typed.requested;
        await service.prompt(ref, "Cleared", "followUp", undefined, { requestId: "voice-old" });
        await vi.waitFor(() => { expect(session.getFollowUpMessages()).toEqual(["Cleared"]); });
        typed.release();
        await turnStarted.promise;
        expect(session.agent.hasQueuedMessages()).toBe(false);
        expect(session.getFollowUpMessages()).toEqual(["Cleared"]);
        await service.clearQueue(ref);
        expect(session.getFollowUpMessages()).toEqual([]);
        if (sendAfterClear) {
          await service.prompt(ref, "New", "followUp", undefined, { requestId: "voice-new" });
          await vi.waitFor(() => { expect(session.getFollowUpMessages()).toEqual(["New"]); });
        }
      } finally {
        typed.release();
        deliver.resolve();
      }
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      // Clear did not remove the input Pi had already selected; it revoked only its spoken link.
      expect(modelRequests[1]).toContain("Cleared");
      expect(promptReplies(hub)).toEqual(sendAfterClear
        ? [{ requestId: "voice-new", entryId: session.sessionManager.getBranch().at(-1)?.id }] : []);
    });
  });

  it("keeps the link when another prompt is cleared after the dictated input was delivered", async () => {
    const typed = heldReply([{ type: "text", text: "Answer to typed" }]);
    const spoken = heldReply([{ type: "text", text: "Answer to spoken" }]);
    await withHostedSession([typed.reply, spoken.reply], [], async ({ service, ref, session, hub }) => {
      try {
        await service.prompt(ref, "Typed");
        await typed.requested;
        await service.prompt(ref, "Spoken", "followUp", undefined, { requestId: "voice-1" });
        await vi.waitFor(() => { expect(session.getFollowUpMessages()).toEqual(["Spoken"]); });
        typed.release();
        await spoken.requested;
        await service.prompt(ref, "Clear this", "followUp");
        await vi.waitFor(() => { expect(session.getFollowUpMessages()).toEqual(["Clear this"]); });
        await service.clearQueue(ref);
      } finally {
        typed.release();
        spoken.release();
      }
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      expect(modelInputKinds(session)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(promptReplies(hub)).toEqual([{ requestId: "voice-1", entryId: session.sessionManager.getBranch().at(-1)?.id }]);
    });
  });

  it("stays silent for a queued request when the run is stopped", async () => {
    const pending = latch();
    await withHostedSession([replyUntilAborted(pending.resolve)], [], async ({ service, ref, session, hub }) => {
      await service.prompt(ref, "Typed");
      await pending.promise;
      await service.prompt(ref, "Spoken", "followUp", undefined, { requestId: "voice-1" });
      await vi.waitFor(() => { expect(session.getFollowUpMessages()).toEqual(["Spoken"]); });
      await service.abort(ref);
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      expect(modelInputKinds(session)).toEqual(["user", "assistant"]);
      expect(promptReplies(hub)).toEqual([]);
    });
  });

  it("stays silent when the queued request's reply is a provider error", async () => {
    const typed = heldReply([{ type: "text", text: "Answer to typed" }]);
    await withHostedSession([typed.reply, failedReply("Provider unavailable")], [], async ({ service, ref, session, hub }) => {
      await service.prompt(ref, "Typed");
      await typed.requested;
      await service.prompt(ref, "Spoken", "followUp", undefined, { requestId: "voice-1" });
      await vi.waitFor(() => { expect(session.getFollowUpMessages()).toEqual(["Spoken"]); });
      typed.release();
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      expect(modelInputKinds(session)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(promptReplies(hub)).toEqual([]);
    });
  });

  it("stays silent when an unrecovered provider error precedes a successful queued input", async () => {
    const failed = latch();
    const release = latch();
    const initial: ModelReply = (signal) => {
      failed.resolve();
      return failedReply("Provider unavailable", release.promise)(signal);
    };
    await withHostedSession([initial, reply([{ type: "text", text: "Answer to spoken" }])], [], async ({ service, ref, session, hub, modelRequests }) => {
      try {
        await service.prompt(ref, "Typed");
        await failed.promise;
        await service.prompt(ref, "Spoken", "followUp", undefined, { requestId: "voice-1" });
        await vi.waitFor(() => { expect(session.getFollowUpMessages()).toEqual(["Spoken"]); });
      } finally {
        release.resolve();
      }
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      expect(modelRequests[1]).toContain("Spoken");
      expect(session.sessionManager.getBranch().flatMap((entry) => entry.type === "message" && entry.message.role === "assistant" ? [entry.message.stopReason] : []))
        .toEqual(["error", "stop"]);
      expect(promptReplies(hub)).toEqual([]);
    });
  });

  it("links a queued input after a successful retry of that same input", async () => {
    const typed = heldReply([{ type: "text", text: "Answer to typed" }]);
    await withHostedSession([
      typed.reply, failedReply("Overloaded"), reply([{ type: "text", text: "Answer after retry" }]),
    ], [], async ({ service, ref, session, hub, modelRequests }) => {
      try {
        await service.prompt(ref, "Typed");
        await typed.requested;
        await service.prompt(ref, "Spoken", "followUp", undefined, { requestId: "voice-1" });
        await vi.waitFor(() => { expect(session.getFollowUpMessages()).toEqual(["Spoken"]); });
      } finally {
        typed.release();
      }
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      expect(modelRequests).toHaveLength(3);
      expect(modelRequests[1]).toContain("Spoken");
      expect(modelRequests[2]).toEqual(modelRequests[1]);
      expect(promptReplies(hub)).toEqual([{ requestId: "voice-1", entryId: session.sessionManager.getBranch().at(-1)?.id }]);
    }, { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } });
  });
});

it.runIf(!sdkReportsPromptMessages)("sends no prompt reply link when the SDK does not report prompt messages", async () => {
  await withHostedSession([reply([{ type: "text", text: "Final" }])], [], async ({ service, ref, hub }) => {
    await service.prompt(ref, "Answer", undefined, undefined, { requestId: "voice-1" });
    await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

    expect(hub.sessionEvents.filter(({ event }) => event.type === "assistant.saved")).toHaveLength(1);
    expect(promptReplies(hub)).toEqual([]);
  });
});

// The SDK reports an extension command "handled" with or without the p5yr hook.
describe("command reply link on an extension widget", () => {
  it("names the request on the first live frame of the command's own opted-in final widget only", async () => {
    const side = sideCommand();
    await withHostedSession([], [side.extension], async ({ service, ref, hub }) => {
      await service.prompt(ref, "/side a", undefined, undefined, { requestId: "voice-a" });
      await vi.waitFor(() => { expect(side.started).toContain("a"); });
      side.finish("a", true);
      await vi.waitFor(() => { expect(widgetFrames(hub, "a").at(-1)?.lines).toEqual(["answer a"]); }, { timeout: 3000 });
      expect(widgetFrames(hub, "a")).toEqual([{ key: "a", lines: ["running"] }, { key: "a", lines: ["answer a"], requestId: "voice-a" }]);

      // Later frames of the whole state, and snapshots for reconnecting clients, omit it.
      await service.prompt(ref, "/side b");
      await vi.waitFor(() => { expect(widgetFrames(hub, "b")).not.toEqual([]); }, { timeout: 3000 });
      expect(widgetFrames(hub, "a").at(-1)).toEqual({ key: "a", lines: ["answer a"] });
      expect((await service.transcriptSnapshot(ref)).extensionUi?.widgets.find((widget) => widget.key === "a")).toEqual({ key: "a", lines: ["answer a"] });
      expect(linkedFrames(hub)).toHaveLength(1);
    });
  });

  it("names each overlapping command's own request, and none for a typed command or an unsuccessful result", async () => {
    const side = sideCommand();
    await withHostedSession([], [side.extension], async ({ service, ref, hub }) => {
      await service.prompt(ref, "/side a", undefined, undefined, { requestId: "client-a" });
      await service.prompt(ref, "/side b", undefined, undefined, { requestId: "client-b" });
      await service.prompt(ref, "/side typed");
      await service.prompt(ref, "/side stopped", undefined, undefined, { requestId: "client-stopped" });
      await vi.waitFor(() => { expect(side.started).toEqual(["a", "b", "typed", "stopped"]); });
      for (const [name, succeeded] of [["b", true], ["stopped", false], ["typed", true], ["a", true]] as const) {
        side.finish(name, succeeded);
        await vi.waitFor(() => { expect(widgetFrames(hub, name).at(-1)?.lines).toEqual([succeeded ? `answer ${name}` : "partial"]); }, { timeout: 3000 });
      }

      expect(linkedFrames(hub)).toEqual([{ key: "b", requestId: "client-b" }, { key: "a", requestId: "client-a" }]);
    });
  });

  it("names neither request when the SDK defers a command into the scope of another command's settling run", async () => {
    const side = sideCommand();
    const settling = latch();
    const release = latch();
    await withHostedSession([reply([{ type: "text", text: "Started" }])], [side.extension, holdFirstSettle(settling.resolve, release.promise)], async ({ service, ref, session, hub }) => {
      // /start returns once its run begins, so the SDK reports it handled in its own scope.
      await service.prompt(ref, "/start", undefined, undefined, { requestId: "client-start" });
      await settling.promise;
      await service.prompt(ref, "/side deferred", undefined, undefined, { requestId: "client-deferred" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(side.started).toEqual([]);
      release.resolve();
      await vi.waitFor(() => { expect(side.started).toEqual(["deferred"]); });
      side.finish("deferred", true);
      await vi.waitFor(() => { expect(widgetFrames(hub, "deferred").at(-1)?.lines).toEqual(["answer deferred"]); }, { timeout: 3000 });

      expect(modelInputKinds(session)).toEqual(["user", "assistant"]);
      expect(linkedFrames(hub)).toEqual([]);
    });
  });

  it("names no request for a command another submitted command dispatches in its scope", async () => {
    const side = sideCommand();
    await withHostedSession([], [side.extension], async ({ service, ref, hub }) => {
      // /forward dispatches /side through Pi's public API and returns, so the SDK reports /forward handled.
      await service.prompt(ref, "/forward nested", undefined, undefined, { requestId: "client-forward" });
      await vi.waitFor(() => { expect(side.started).toEqual(["nested"]); });
      await new Promise((resolve) => setTimeout(resolve, 50));
      side.finish("nested", true);
      await vi.waitFor(() => { expect(widgetFrames(hub, "nested").at(-1)?.lines).toEqual(["answer nested"]); }, { timeout: 3000 });

      expect(linkedFrames(hub)).toEqual([]);
    });
  });
});

interface SideCommand {
  extension: InlineExtension;
  /** Names `/side <name>` handled, in order. */
  started: string[];
  finish(name: string, succeeded: boolean): void;
}

/**
 * Like /btw: `/side <name>` shows a running widget, returns, and later sets a
 * final one opted in to the reply link only if `finish` reports success.
 * `/forward <name>` runs `/side <name>` through Pi's public API and returns.
 * `/start` starts a main run from its own command scope and returns.
 */
function sideCommand(): SideCommand {
  const started: string[] = [];
  const outcomes = new Map<string, (succeeded: boolean) => void>();
  return {
    started,
    finish: (name, succeeded) => { outcomes.get(name)?.(succeeded); },
    extension: (pi) => {
      pi.registerCommand("side", {
        description: "Side question",
        handler: (name, ctx) => {
          ctx.ui.setWidget(name, ["running"]);
          void new Promise<boolean>((resolve) => { outcomes.set(name, resolve); }).then((succeeded) => {
            // PI WEB's own option, beyond Pi's.
            const options = { placement: "aboveEditor" as const, ...(succeeded ? { requestReply: "side" } : {}) };
            ctx.ui.setWidget(name, [succeeded ? `answer ${name}` : "partial"], options);
          });
          started.push(name);
          return Promise.resolve();
        },
      });
      pi.registerCommand("forward", {
        description: "Ask a side question for the user",
        handler: (name) => { pi.sendUserMessage(`/side ${name}`, { expandPromptTemplates: true }); return Promise.resolve(); },
      });
      pi.registerCommand("start", {
        description: "Start a main run",
        handler: () => { pi.sendUserMessage("Start"); return Promise.resolve(); },
      });
    },
  };
}

/** Holds the first `agent_settled` extension hook, while the SDK defers prompts, until `release`. */
function holdFirstSettle(onHold: () => void, release: Promise<void>): InlineExtension {
  return (pi) => {
    let held = false;
    pi.on("agent_settled", async () => {
      if (held) return;
      held = true;
      onHold();
      await release;
    });
  };
}

function widgetFrames(hub: CapturingSessionEventHub, key: string): ExtensionWidget[] {
  return hub.sessionEvents.flatMap(({ event }) => event.type === "extension.ui" ? event.ui.widgets.filter((widget) => widget.key === key) : []);
}

function linkedFrames(hub: CapturingSessionEventHub): { key: string; requestId: string }[] {
  return hub.sessionEvents.flatMap(({ event }) => event.type === "extension.ui"
    ? event.ui.widgets.flatMap((widget) => widget.requestId === undefined ? [] : [{ key: widget.key, requestId: widget.requestId }])
    : []);
}

interface HostedSession {
  service: PiSessionService;
  ref: { id: string; cwd: string };
  session: AgentSession;
  hub: CapturingSessionEventHub;
  /** Each model request's context messages, serialized when it was made. */
  modelRequests: string[];
}

type ModelReply = (abort: AbortSignal | undefined) => ReturnType<typeof createAssistantMessageEventStream>;

function settledCount(hub: CapturingSessionEventHub): number {
  return hub.sessionEvents.filter(({ event }) => event.type === "pi.event" && event.eventType === "agent_settled").length;
}

function promptReplies(hub: CapturingSessionEventHub): PromptReplyLink[] {
  return hub.sessionEvents.flatMap(({ event }) => event.type === "pi.event" && event.promptReply !== undefined ? [event.promptReply] : []);
}

/** Branch messages and custom messages, without system messages. */
function modelInputKinds(session: AgentSession): string[] {
  return session.sessionManager.getBranch().flatMap((entry) => {
    if (entry.type === "custom_message") return ["custom_message"];
    const role: string | undefined = entry.type === "message" ? entry.message.role : undefined;
    return role === undefined || role === "system" ? [] : [role];
  });
}

/** Holds the first run in before_agent_start, where the SDK already counts it as streaming, until `release`. */
function holdFirstRunStart(onHold: () => void, release: Promise<void>): InlineExtension {
  return (pi) => {
    let held = false;
    pi.on("before_agent_start", async () => {
      if (held) return;
      held = true;
      onHold();
      await release;
    });
  };
}

/** Appends `drafts` and requests one more model turn, without user input, the first time the run would settle. */
function continueOnceBeforeSettle(drafts: (ctx: ExtensionContext) => SessionBoundaryDraft[]): InlineExtension {
  return (pi) => {
    let continued = false;
    pi.on("agent_before_settle", (_event, ctx) => {
      if (continued) return undefined;
      continued = true;
      return { entries: drafts(ctx), continue: true };
    });
  };
}

function lastMessageEntryId(ctx: ExtensionContext, role: "user" | "assistant"): string {
  const entry = ctx.sessionManager.getBranch().filter((candidate) => candidate.type === "message" && candidate.message.role === role).at(-1);
  if (entry === undefined) throw new Error(`No ${role} message on the branch`);
  return entry.id;
}

async function withHostedSession<T>(
  replies: ModelReply[], extensionFactories: InlineExtension[], scenario: (hosted: HostedSession) => Promise<T>,
  settings: Pick<NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>, "steeringMode" | "retry"> = {},
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-prompt-reply-"));
  const agentDir = join(directory, "agent");
  let service: PiSessionService | undefined;
  let nativeSession: AgentSession | undefined;
  const modelRequests: string[] = [];
  try {
    const modelRuntime = await createTestModelRuntime();
    await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");
    const lookup = defineTool({
      name: "lookup", label: "lookup", description: "Return a fixed result.", parameters: Type.Object({}),
      execute: () => Promise.resolve({ content: [{ type: "text" as const, text: "Done" }], details: {} }),
    });
    const createAgentRuntime: NonNullable<PiSessionServiceDependencies["createAgentRuntime"]> = async (_factory, options) => {
      if (!(options.sessionManager instanceof SessionManager)) throw new Error("Expected a file-backed SessionManager");
      const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, ...settings });
      const resourceLoader = new DefaultResourceLoader({
        cwd: directory, agentDir, settingsManager, extensionFactories,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        agentsFilesOverride: () => ({ agentsFiles: [] }),
      });
      await resourceLoader.reload();
      const { session } = await createAgentSession({
        cwd: directory, agentDir, sessionManager: options.sessionManager, settingsManager, resourceLoader,
        modelRuntime, model: testModel(), noTools: "builtin", customTools: [lookup],
      });
      nativeSession = session;
      session.agent.streamFunction = (_model, context, streamOptions) => {
        modelRequests.push(JSON.stringify(context.messages));
        const next = replies.shift();
        if (next === undefined) throw new Error("Unexpected model request");
        return next(streamOptions?.signal);
      };
      return {
        cwd: directory, session, setRebindSession: () => undefined,
        fork: () => Promise.resolve({ cancelled: true }),
        dispose: () => { session.dispose(); return Promise.resolve(); },
      };
    };
    const hub = new CapturingSessionEventHub();
    service = new PiSessionService(hub, {
      agentDir, modelRuntime, createAgentRuntime, archiveStore: emptyArchiveStore(), heartbeatIntervalMs: 60_000,
      sessionManager: createPiSessionManagerGateway({ agentDir, env: { PI_CODING_AGENT_SESSION_DIR: join(directory, "sessions") } }),
    });
    const started = await service.start(directory);
    if (nativeSession === undefined) throw new Error("Expected the hosted SDK session");
    return await scenario({ service, ref: { id: started.id, cwd: directory }, session: nativeSession, hub, modelRequests });
  } finally {
    await service?.dispose();
    nativeSession?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

function assistantMessage(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant", content,
    api: "anthropic-messages", provider: "anthropic", model: testModel().id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  };
}

/** Completes with `content` once `release` settles. */
function reply(content: AssistantMessage["content"], release: Promise<void> = Promise.resolve()): ModelReply {
  return () => {
    const stopReason = content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
    const message = assistantMessage(content, stopReason);
    const stream = createAssistantMessageEventStream();
    void release.then(() => {
      stream.push({ type: "done", reason: stopReason, message });
      stream.end(message);
    });
    return stream;
  };
}

function failedReply(errorMessage: string, release: Promise<void> = Promise.resolve()): ModelReply {
  return () => {
    const message = { ...assistantMessage([], "error"), errorMessage };
    const stream = createAssistantMessageEventStream();
    void release.then(() => {
      stream.push({ type: "error", reason: "error", error: message });
      stream.end(message);
    });
    return stream;
  };
}

/** Streams nothing until the run aborts, calling `onRequest` once the request is made. */
function replyUntilAborted(onRequest: () => void): ModelReply {
  return (abort) => {
    const stream = createAssistantMessageEventStream();
    abort?.addEventListener("abort", () => {
      const message = assistantMessage([], "aborted");
      stream.push({ type: "error", reason: "aborted", error: message });
      stream.end(message);
    }, { once: true });
    onRequest();
    return stream;
  };
}

/** Completes with `content` once released, reporting when the model was asked. */
function heldReply(content: AssistantMessage["content"]): { reply: ModelReply; requested: Promise<void>; release: () => void } {
  const requested = latch();
  const released = latch();
  return {
    requested: requested.promise,
    release: released.resolve,
    reply: (abort) => {
      requested.resolve();
      return reply(content, released.promise)(abort);
    },
  };
}

function latch(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}
