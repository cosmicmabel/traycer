import { Ticket } from "lucide-react";
import { makeCicReference } from "./make-cic-reference";

/**
 * Migrated `<cic-ticket>` tag - opens the ticket artifact by its embedded
 * id. Same-epic opens a preview tile; cross-epic navigates and focuses the
 * artifact.
 */
export const CicTicketReference = makeCicReference({
  icon: <Ticket className="size-3.5" aria-hidden />,
  idAttr: "data-ticket-id",
  refKind: "ticket",
  requiresNode: true,
});
