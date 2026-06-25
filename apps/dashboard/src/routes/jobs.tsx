import { createFileRoute } from "@tanstack/react-router"
import { ComingSoon } from "../components/ComingSoon"

export const Route = createFileRoute("/jobs")({
  component: () => (
    <ComingSoon
      title="Jobs"
      version="v2"
      blurb="Backfill / re-embed runs (Enumerator + queues + cron). No read op exposes run status yet — a follow-up on the API surface, then this screen."
    />
  ),
})
