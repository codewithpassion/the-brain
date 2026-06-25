import { createFileRoute } from "@tanstack/react-router"
import { ComingSoon } from "../components/ComingSoon"

export const Route = createFileRoute("/audit")({
  component: () => (
    <ComingSoon
      title="Audit log"
      version="v2"
      blurb="A reader over audit_export (append-only memory_audit + recall traces). The export op is live; the paged audit viewer is the remaining work."
    />
  ),
})
