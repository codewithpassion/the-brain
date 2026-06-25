import { createFileRoute } from "@tanstack/react-router"
import { ComingSoon } from "../components/ComingSoon"

export const Route = createFileRoute("/sessions")({
  component: () => (
    <ComingSoon
      title="Sessions"
      version="v2"
      blurb="Capture / finalize / get_session_context plus recall traces. Backed by live session ops; the timeline UI is the remaining work."
    />
  ),
})
