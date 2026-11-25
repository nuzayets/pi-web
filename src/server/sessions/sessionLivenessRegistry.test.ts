import { describe, expect, it, onTestFinished } from "vitest";
import { sessionLivenessActive, sessionLivenessRegistry } from "./sessionLivenessRegistry.js";

const KEY = Symbol.for("@agegr/pi-web/session-liveness/v1");

describe("session liveness registry", () => {
  it("answers per session from the providers registered for it, and forgets released ones", () => {
    const registry = sessionLivenessRegistry();
    expect(registry).toBe(Reflect.get(globalThis, KEY));
    let live = true;
    const release = registry?.register({ name: "pi-subagents", sessionId: "s1", isActive: () => live });
    onTestFinished(() => release?.());
    const releaseIdle = registry?.register({ name: "other", sessionId: "s1", isActive: () => false });
    onTestFinished(() => releaseIdle?.());

    expect(sessionLivenessActive(registry, "s1")).toBe(true);
    expect(sessionLivenessActive(registry, "s2")).toBeNull();
    live = false;
    expect(sessionLivenessActive(registry, "s1")).toBe(false);
    live = true;
    release?.();
    expect(sessionLivenessActive(registry, "s1")).toBe(false);
    releaseIdle?.();
    expect(sessionLivenessActive(registry, "s1")).toBeNull();
    expect(() => registry?.register({ name: "broken", sessionId: "s1" })).toThrow();
  });

  it("reports unknown when a provider fails or the registry belongs to another host", () => {
    const registry = sessionLivenessRegistry();
    const release = registry?.register({ name: "failing", sessionId: "s3", isActive: () => { throw new Error("stale context"); } });
    onTestFinished(() => release?.());
    expect(sessionLivenessActive(registry, "s3")).toBeNull();
    expect(sessionLivenessActive(undefined, "s3")).toBeNull();

    const ours: unknown = Reflect.get(globalThis, KEY);
    const foreign = { version: 1, register: () => () => undefined };
    Reflect.set(globalThis, KEY, foreign);
    onTestFinished(() => { Reflect.set(globalThis, KEY, ours); });
    expect(sessionLivenessRegistry()).toBeUndefined();
    expect(Reflect.get(globalThis, KEY)).toBe(foreign);
  });
});
