/**
 * /sessions layout — renders the matched child route (the list at /sessions/ or the
 * detail at /sessions/$id) into its Outlet. Mirrors documents.tsx.
 */
import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/sessions")({
  component: () => <Outlet />,
})
