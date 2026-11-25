/**
 * Host side of the process-global `@agegr/pi-web/session-liveness/v1` registry.
 *
 * pi-subagents (0.90.0) registers one provider per session here when it finds
 * the registry. Its `isActive()` stays true while the session has queued or
 * running async runs, live nested or foreground children, a finished run whose
 * result has not reached the parent, or a completion wake Pi has accepted but
 * not yet started. That last part is what no widget or status line reports.
 */
const REGISTRY_KEY = Symbol.for("@agegr/pi-web/session-liveness/v1");

/**
 * pi-subagents events on the session's event bus that follow a change of its
 * liveness: a job starts, finishes or is cleared, or a result reaches the parent.
 */
export const SUBAGENT_CHANGE_EVENTS = ["subagent:jobs-changed", "subagent:async-complete"] as const;

interface LivenessProvider {
  name: string;
  sessionId: string;
  isActive: () => unknown;
}

interface HostRegistry {
  readonly version: 1;
  register(provider: unknown): () => void;
  readonly providers: Set<LivenessProvider>;
}

function isHostRegistry(value: unknown): value is HostRegistry {
  return typeof value === "object" && value !== null && Reflect.get(value, "version") === 1
    && Reflect.get(value, "providers") instanceof Set && typeof Reflect.get(value, "register") === "function";
}

function isProvider(value: unknown): value is LivenessProvider {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "name") === "string"
    && typeof Reflect.get(value, "sessionId") === "string" && typeof Reflect.get(value, "isActive") === "function";
}

/** Installs the registry once per process; extensions look it up at session_start. */
export function sessionLivenessRegistry(): HostRegistry | undefined {
  const existing: unknown = Reflect.get(globalThis, REGISTRY_KEY);
  if (isHostRegistry(existing)) return existing;
  // Another host's registry stays in place; its providers are not ours to read.
  if (existing !== undefined) return undefined;
  const providers = new Set<LivenessProvider>();
  const registry: HostRegistry = {
    version: 1,
    providers,
    register(provider: unknown) {
      if (!isProvider(provider)) throw new Error("Session liveness provider needs a name, a sessionId and isActive()");
      providers.add(provider);
      return () => { providers.delete(provider); };
    },
  };
  Reflect.set(globalThis, REGISTRY_KEY, registry);
  return registry;
}

/** Null when liveness cannot be confirmed: an empty lookup is startup or an unsupported extension, not idle. */
export function sessionLivenessActive(registry: HostRegistry | undefined, sessionId: string): boolean | null {
  if (registry === undefined) return null;
  let active: boolean | undefined;
  for (const provider of registry.providers) {
    if (provider.sessionId !== sessionId) continue;
    try {
      active = provider.isActive() === true || active === true;
    } catch {
      return null;
    }
  }
  return active ?? null;
}
