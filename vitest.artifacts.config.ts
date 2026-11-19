import { defineConfig } from "vitest/config";
import "./vitest.isolation.js";

// Opt-in delivery checks consume dist from the preceding build; ordinary tests stay build-free.
export default defineConfig({
  test: {
    include: ["scripts/**/*.artifact.mjs"],
  },
});
