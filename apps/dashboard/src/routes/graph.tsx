import { createFileRoute } from "@tanstack/react-router"
import { ComingSoon } from "../components/ComingSoon"

export const Route = createFileRoute("/graph")({
  component: () => (
    <ComingSoon
      title="Graph"
      version="v2"
      blurb="A viewer over traverse_graph / get_links / get_backlinks / list_entities / find_orphans. The ops are live in the API; the interactive graph UI is the remaining work."
    />
  ),
})
