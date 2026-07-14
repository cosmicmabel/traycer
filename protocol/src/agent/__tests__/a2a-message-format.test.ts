import { describe, expect, it } from "vitest";
import { formatAgentMessage } from "../a2a-message-format";

describe("formatAgentMessage", () => {
  it("formats GUI agent messages that expect a reply", () => {
    expect(
      formatAgentMessage({
        receiverChannel: "gui",
        sender: {
          agentId: "agent-1",
          title: "Review Agent",
          harnessId: "codex",
        },
        reply: { expectsReply: true, responseId: "response-1" },
        body: "Please review this.",
      }),
    ).toBe(
      [
        "[cic:agent-message] from Review Agent (agent agent-1) [codex]",
        '[cic:agent-message] A reply is expected. Use the cic_send_message tool to reply with responseId="response-1".',
        "",
        "Please review this.",
      ].join("\n"),
    );
  });

  it("formats GUI reply requests without optional display metadata", () => {
    expect(
      formatAgentMessage({
        receiverChannel: "gui",
        sender: {
          agentId: "agent-1",
          title: null,
          harnessId: null,
        },
        reply: { expectsReply: true, responseId: "response-1" },
        body: "Please review this.",
      }),
    ).toBe(
      [
        "[cic:agent-message] from agent agent-1",
        '[cic:agent-message] A reply is expected. Use the cic_send_message tool to reply with responseId="response-1".',
        "",
        "Please review this.",
      ].join("\n"),
    );
  });

  it("formats CLI inbox messages without a reply request", () => {
    expect(
      formatAgentMessage({
        receiverChannel: "cli",
        sender: {
          agentId: "agent-1",
          title: "Review Agent",
          harnessId: "claude",
        },
        reply: { expectsReply: false },
        body: "Context only.",
      }),
    ).toBe(
      [
        "",
        "[cic inbox] message from Review Agent (agent agent-1) [claude]",
        "",
        "Context only.",
        "[cic inbox] ─── end of message ───",
        "[cic inbox] if the message above looks cut off, read it in full with: cic agent inbox",
      ].join("\n"),
    );
  });

  it("formats CLI reply requests without optional display metadata", () => {
    expect(
      formatAgentMessage({
        receiverChannel: "cli",
        sender: {
          agentId: "agent-1",
          title: null,
          harnessId: null,
        },
        reply: { expectsReply: true, responseId: "response-1" },
        body: "Please review this.",
      }),
    ).toBe(
      [
        "",
        "[cic inbox] message from agent agent-1 — responseId response-1",
        '[cic inbox] a reply is expected — reply with: cic agent send --to agent-1 --response-id response-1 --message "<your reply>"',
        "",
        "Please review this.",
        "[cic inbox] ─── end of message ───",
        "[cic inbox] if the message above looks cut off, read it in full with: cic agent inbox",
      ].join("\n"),
    );
  });
});
