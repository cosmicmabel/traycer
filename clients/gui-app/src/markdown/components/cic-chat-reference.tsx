import { MessageSquare } from "lucide-react";
import { makeCicReference } from "./make-cic-reference";

/**
 * Migrated `<cic-chat>` tag - opens the chat by its embedded id. Same-epic
 * opens a chat preview tile; cross-epic navigates and focuses the chat via
 * `focusArtifactId` (D1 - no `focusChatId`).
 */
export const CicChatReference = makeCicReference({
  icon: <MessageSquare className="size-3.5" aria-hidden />,
  idAttr: "data-chat-id",
  refKind: "chat",
  requiresNode: true,
});
