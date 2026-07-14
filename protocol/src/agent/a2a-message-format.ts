export type AgentMessageReceiverChannel = "gui" | "cli";

export type AgentMessageReply =
  | {
      readonly expectsReply: true;
      readonly responseId: string;
    }
  | {
      readonly expectsReply: false;
    };

export interface AgentMessageSenderDisplay {
  readonly agentId: string;
  readonly title: string | null;
  readonly harnessId: string | null;
}

export interface FormatAgentMessageInput {
  readonly receiverChannel: AgentMessageReceiverChannel;
  readonly sender: AgentMessageSenderDisplay;
  readonly reply: AgentMessageReply;
  readonly body: string;
}

export function formatAgentMessage(input: FormatAgentMessageInput): string {
  switch (input.receiverChannel) {
    case "gui":
      return formatGuiAgentMessage(input);
    case "cli":
      return formatCliAgentMessage(input);
    default: {
      const _exhaustiveCheck: never = input.receiverChannel;
      throw new Error(`Unhandled agent message channel: ${_exhaustiveCheck}`);
    }
  }
}

function formatGuiAgentMessage(input: FormatAgentMessageInput): string {
  const replyLine = input.reply.expectsReply
    ? `[cic:agent-message] A reply is expected. Use the cic_send_message tool to reply with responseId="${input.reply.responseId}".`
    : "[cic:agent-message] No reply is required.";

  return `[cic:agent-message] from ${formatAgentMessageSenderLabel(input.sender)}
${replyLine}

${input.body}`;
}

function formatCliAgentMessage(input: FormatAgentMessageInput): string {
  const responseHint = input.reply.expectsReply
    ? ` — responseId ${input.reply.responseId}`
    : "";
  const header = `[cic inbox] message from ${formatAgentMessageSenderLabel(input.sender)}${responseHint}`;

  if (input.reply.expectsReply) {
    return `
${header}
[cic inbox] a reply is expected — reply with: cic agent send --to ${input.sender.agentId} --response-id ${input.reply.responseId} --message "<your reply>"

${input.body}
[cic inbox] ─── end of message ───
[cic inbox] if the message above looks cut off, read it in full with: cic agent inbox`;
  }

  return `
${header}

${input.body}
[cic inbox] ─── end of message ───
[cic inbox] if the message above looks cut off, read it in full with: cic agent inbox`;
}

export function formatAgentMessageSenderLabel(
  sender: AgentMessageSenderDisplay,
): string {
  const senderName =
    sender.title !== null
      ? `${sender.title} (agent ${sender.agentId})`
      : `agent ${sender.agentId}`;
  const harnessSuffix =
    sender.harnessId !== null ? ` [${sender.harnessId}]` : "";
  return `${senderName}${harnessSuffix}`;
}
