import { Layers } from "lucide-react";
import { makeCicReference } from "./make-cic-reference";

/**
 * Migrated `<cic-epic>` tag - focuses the target epic by its embedded id
 * (no artifact). Carries no node id, so the open handler navigates to the epic
 * and focuses it without opening any tile.
 */
export const CicEpicReference = makeCicReference({
  icon: <Layers className="size-3.5" aria-hidden />,
  idAttr: null,
  refKind: "epic",
  requiresNode: false,
});
