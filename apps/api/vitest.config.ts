import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

/**
 * Phase 1e test harness: @cloudflare/vitest-pool-workers runs every test INSIDE real
 * workerd, with miniflare emulating the D1/KV/R2 bindings declared in `wrangler.jsonc`.
 *
 * The frozen Drizzle migrations are read here (Node side — workerd has no fs) and split on
 * the Drizzle `--> statement-breakpoint` markers (which are comments, NOT executable SQL).
 * Each statement is injected as the `MIGRATIONS` binding and applied into the test D1 by
 * `test/apply-migrations.ts`, in order, with NO error-swallowing — a failing statement
 * (e.g. the FTS5 DDL) throws loudly rather than being hidden.
 */
const here = fileURLToPath(new URL(".", import.meta.url))
const migrationsDir = join(here, "..", "..", "packages", "db", "drizzle")

const MIGRATIONS = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .flatMap((file) =>
    readFileSync(join(migrationsDir, file), "utf8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      // Drop fragments that are only comments/whitespace (no executable SQL).
      .filter((statement) => statement.replace(/^\s*--.*$/gm, "").trim().length > 0),
  )

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // RUN_AI_GATES plumbs the host env var INTO workerd (process.env is not visible inside
      // the worker) so the reranker live-shape gate can opt in; defaults off → visible skip.
      miniflare: { bindings: { MIGRATIONS, RUN_AI_GATES: process.env.RUN_AI_GATES ?? "0" } },
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
})
