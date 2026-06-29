/**
 * /documents layout — renders the matched child route (the list at /documents/ or the
 * detail at /documents/$id) into its Outlet. Without this layout the nested $id detail
 * route has nowhere to render.
 */
import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/documents")({
  component: () => <Outlet />,
})
