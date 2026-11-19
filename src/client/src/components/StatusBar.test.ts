// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import type { SessionStatus } from "../api";
import { localization } from "../localization/browser";
import { StatusBar, statusBarMessages as messages } from "./StatusBar";

const releases: (() => void)[] = [];
afterEach(async () => {
  document.body.replaceChildren();
  localStorage.clear();
  releases.splice(0).forEach((release) => { release(); });
  await localization.setPreferences({ language: "en", formatLocale: "en" });
});

it("updates status formatting and context variants when the locale changes", async () => {
  releases.push(localization.registerCatalog({ id: "status-bar-test", namespace: "core.statusBar", locale: "de", load: () => Promise.resolve({
    empty: "Noch kein Status", contextSize: "Kontext {size}", contextUsage: "{percent} von {size}", contextUnknown: "Kontext unbekannt",
    queued: "{count, plural, one {# vorgemerkt} other {# vorgemerkt}}",
  }) }));
  const bar = new StatusBar();
  document.body.append(bar);
  const snapshot = status();
  for (const language of ["de", "en"]) {
    await localization.setPreferences({ language, formatLocale: "de-DE" });
    bar.status = undefined;
    await bar.updateComplete;
    expect(bar.shadowRoot?.textContent).toContain(messages.t("empty"));
    for (const contextUsage of [undefined, { contextWindow: 128000, tokens: null, percent: null }, { contextWindow: 128000, tokens: 16000, percent: 12.5 }]) {
      bar.status = { ...snapshot, ...(contextUsage === undefined ? {} : { contextUsage }) };
      await bar.updateComplete;
      const context = bar.shadowRoot?.querySelector(".context");
      const size = new Intl.NumberFormat("de-DE", { notation: "compact", maximumFractionDigits: 0 }).format(128000);
      expect(context?.textContent).toBe(contextUsage === undefined ? messages.t("contextUnknown") : contextUsage.percent === null ? messages.t("contextSize", { size }) : messages.t("contextUsage", {
        size, percent: new Intl.NumberFormat("de-DE", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(0.125),
      }));
      expect(bar.shadowRoot?.textContent).toContain(messages.t("queued", { count: 1200 }));
      expect(bar.shadowRoot?.textContent).toContain(new Intl.NumberFormat("de-DE", { notation: "compact", maximumFractionDigits: 1 }).format(snapshot.tokens.input));
      expect(bar.shadowRoot?.textContent).toContain(new Intl.NumberFormat("de-DE", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(snapshot.cost));
    }
  }
});

it("shows extension statuses before the figures", async () => {
  const bar = new StatusBar();
  bar.status = status();
  bar.extensionStatuses = ["adaptive · medium → high", "5h 40%"];
  document.body.append(bar);
  await bar.updateComplete;
  const items = [...bar.shadowRoot?.querySelectorAll(".extension-status") ?? []].map((item) => item.textContent);
  expect(items).toEqual(["adaptive · medium → high", "5h 40%"]);
  expect(bar.shadowRoot?.querySelector(".bar")?.firstElementChild?.className).toBe("extension-statuses");
});

function status(): SessionStatus {
  return {
    sessionId: "session-1", isStreaming: true, isCompacting: false, isBashRunning: false,
    pendingMessageCount: 1200, queuedMessages: [],
    tokens: { input: 1234, output: 5678, cacheRead: 0, cacheWrite: 0, total: 6912 }, cost: 12.34,
  };
}
