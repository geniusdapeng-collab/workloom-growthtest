// Preserve the existing CI test path and run every assertion in the canonical
// original-native standard-post suite with its actual Vitest runner.
// This alias provides no free-edit production entrypoint.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

if (process.env.VITEST) {
  await import("./film-standard-post.test.js");
} else {
  const require = createRequire(import.meta.url);
  const runner = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
  const result = spawnSync(process.execPath, [runner, "run", "scripts/tools/film-standard-post.test.ts"], {
    cwd: resolve(import.meta.dirname, "../.."), stdio: "inherit", timeout: 900_000,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Canonical standard-post suite terminated by ${result.signal}`);
  process.exitCode = result.status ?? 1;
}
