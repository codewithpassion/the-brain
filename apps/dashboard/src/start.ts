/**
 * TanStack Start instance — auto-discovered by the `tanstackStart()` vite plugin.
 *
 * Registers Clerk's `clerkMiddleware()` as request middleware so the per-request Clerk context is
 * established BEFORE any server fn runs. This is what makes `auth()` (server-side) resolve the
 * signed-in `userId` + session token in `src/server/brain.ts` (`resolveBrainAuth`). Without it the
 * SSR shell still renders, but every authenticated `brainCall` would see no Clerk context. Required
 * setup per the Clerk TanStack Start guide.
 *
 * Keys are sourced from process.env at runtime, populated by the `nodejs_compat_populate_process_env`
 * compat flag (maps CF vars + secrets into process.env so Clerk's key lookup never falls back to
 * the build-time-inlined import.meta.env object, which lacks CLERK_SECRET_KEY).
 */
import { clerkMiddleware } from "@clerk/tanstack-react-start/server"
import { createStart } from "@tanstack/react-start"

// Read once at module init. With nodejs_compat_populate_process_env, these are strings at runtime.
// biome-ignore lint/complexity/useLiteralKeys: env access requires brackets under noPropertyAccessFromIndexSignature
const clerkPublishableKey = process.env["CLERK_PUBLISHABLE_KEY"]
// biome-ignore lint/complexity/useLiteralKeys: env access requires brackets under noPropertyAccessFromIndexSignature
const clerkSecretKey = process.env["CLERK_SECRET_KEY"]

export const startInstance = createStart(() => ({
  requestMiddleware: [
    clerkMiddleware({
      // Spread only when defined; exactOptionalPropertyTypes forbids explicit undefined on optional string.
      ...(clerkPublishableKey !== undefined && { publishableKey: clerkPublishableKey }),
      ...(clerkSecretKey !== undefined && { secretKey: clerkSecretKey }),
    }),
  ],
}))
