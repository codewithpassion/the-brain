/**
 * /memory layout — renders the matched child route (the list at /memory/ or the
 * detail at /memory/$slug) into its Outlet. Mirrors documents.tsx.
 */
import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/memory")({
  component: () => <Outlet />,
})
