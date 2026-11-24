import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { globalSessionEvents, realtimeEvents, sessionEvents } from "./sockets";

const webSocketUrls: string[] = [];

function FakeWebSocket(url: string): void {
  webSocketUrls.push(url);
}

beforeEach(() => {
  webSocketUrls.length = 0;
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("document", { baseURI: "https://pi.example.test/" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("machine-scoped socket urls", () => {
  it("negotiates reference images and derived tool text only on encoded selected-session sockets under a nested base", () => {
    vi.stubEnv("BASE_URL", "./");
    vi.stubGlobal("document", { baseURI: "https://pi.example.test/nested/pi-web/" });
    sessionEvents({ id: "session /?#%", cwd: "/repo +/?#%" }, "remote /?#%");
    expect(webSocketUrls).toEqual([
      "wss://pi.example.test/nested/pi-web/api/machines/remote%20%2F%3F%23%25/sessions/session%20%2F%3F%23%25/events?cwd=%2Frepo+%2B%2F%3F%23%25&media=reference&toolText=derived",
    ]);
  });
  it("defaults session sockets to the local machine scope", () => {
    sessionEvents({ id: "s1", cwd: "/repo" });
    globalSessionEvents();
    realtimeEvents();

    expect(webSocketUrls).toEqual([
      "wss://pi.example.test/api/machines/local/sessions/s1/events?cwd=%2Frepo&media=reference&toolText=derived",
      "wss://pi.example.test/api/machines/local/sessions/events",
      "wss://pi.example.test/api/machines/local/events",
    ]);
  });
});
