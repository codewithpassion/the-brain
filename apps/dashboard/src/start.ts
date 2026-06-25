/**
 * TanStack Start instance — auto-discovered by the `tanstackStart()` vite plugin.
 *
 * Registers Clerk's `clerkMiddleware()` as request middleware so the per-request Clerk context is
 * established BEFORE any server fn runs. This is what makes `auth()` (server-side) resolve the
 * signed-in `userId` + session token in `src/server/brain.ts` (`resolveBrainAuth`). Without it the
 * SSR shell still renders, but every authenticated `brainCall` would see no Clerk context. Required
 * setup per the Clerk TanStack Start guide.
 */
import { clerkMiddleware } from "@clerk/tanstack-react-start/server"
import { createStart } from "@tanstack/react-start"

export const startInstance = createStart(() => ({
  requestMiddleware: [clerkMiddleware()],
}))
