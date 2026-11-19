import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests started from inside Pi or PI WEB inherit the live agent directory and daemon settings,
// and code under test would load the real extensions. Workers inherit this process's environment.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_")) Reflect.deleteProperty(process.env, key);
}
process.env["HOME"] = mkdtempSync(join(tmpdir(), "pi-web-test-home-"));
