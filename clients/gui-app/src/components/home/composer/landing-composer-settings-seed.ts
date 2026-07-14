import type { ChatRunSettings } from "@cic/protocol/host/agent/gui/subscribe";

export function landingComposerSettingsSeedForDraft(
  draftId: string | null,
  draftSettings: ChatRunSettings | null,
  globalLastRunSettings: ChatRunSettings | null,
): ChatRunSettings | null {
  return draftId === null ? globalLastRunSettings : draftSettings;
}
