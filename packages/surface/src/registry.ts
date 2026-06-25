/**
 * `buildRegistry` — assemble the FULL op-registry across every phase's family (search, graph,
 * session, governance, admin). This is the single frozen set the three generators project from;
 * the drift test asserts each generated surface covers exactly its `bySurface(...)` slice of this
 * registry. A duplicate op name throws here (a frozen catalog cannot silently shadow an op).
 */
import {
  registerAdminOps,
  registerGovernanceOps,
  registerGraphOps,
  registerSearchOps,
  registerSessionOps,
} from "@brain/db"
import { OpRegistry } from "@brain/shared"

export const buildRegistry = (): OpRegistry => {
  const registry = new OpRegistry()
  registerSearchOps(registry)
  registerGraphOps(registry)
  registerSessionOps(registry)
  registerGovernanceOps(registry)
  registerAdminOps(registry)
  return registry
}
