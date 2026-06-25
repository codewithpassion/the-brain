import { env } from "cloudflare:test"

/**
 * Apply the frozen Drizzle migrations into the test D1, inside workerd, before any test.
 *
 * The statements arrive pre-split (on `--> statement-breakpoint`) from `vitest.config.ts`;
 * each is a single SQL statement (a `CREATE TRIGGER ... BEGIN ... END` keeps its internal
 * semicolons intact because it was never split on `;`). We run them in order via
 * `prepare().run()` with NO try/catch: if workerd's SQLite rejects a statement — most
 * notably the FTS5 `CREATE VIRTUAL TABLE` DDL — it throws here with the offending SQL
 * visible, so a harness that cannot honestly apply the full schema fails loudly.
 */
for (const statement of env.MIGRATIONS) {
  await env.DB.prepare(statement).run()
}
