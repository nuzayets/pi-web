import "./components/PiWebApp";
import { initializeLocalization } from "./localization/browser.js";

// Browser-local preferences apply at once. PiWebApp's startup read of the
// gateway config applies localization defaults and policy when it arrives.
void initializeLocalization().catch((cause: unknown) => {
  console.error("[i18n] Localization startup failed", cause);
});
