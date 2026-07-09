import { describe, expect, it } from "vitest";
import {
  isValidLocalHostWebsocketUrl,
  upstreamHostUrl,
  type HostPidMetadata,
} from "../host-pid";
import { webRuntimeConfigSchema } from "../../shell/runtime-config";

const metadata: HostPidMetadata = {
  pid: 4242,
  hostId: "host-1",
  version: "1.2.3",
  websocketUrl: "ws://127.0.0.1:48000/rpc",
  startedAt: "2026-07-09T00:00:00.000Z",
};

describe("isValidLocalHostWebsocketUrl", () => {
  it("accepts the host's loopback /rpc URL", () => {
    expect(isValidLocalHostWebsocketUrl("ws://127.0.0.1:48000/rpc")).toBe(true);
  });

  it.each([
    ["http scheme", "http://127.0.0.1:48000/rpc"],
    ["non-loopback host", "ws://192.168.1.4:48000/rpc"],
    ["localhost alias", "ws://localhost:48000/rpc"],
    ["wrong path", "ws://127.0.0.1:48000/stream"],
    ["query string", "ws://127.0.0.1:48000/rpc?x=1"],
    ["missing port", "ws://127.0.0.1/rpc"],
    ["credentials", "ws://user:pw@127.0.0.1:48000/rpc"],
    ["not a URL", "not a url"],
  ])("rejects %s", (_label, url) => {
    expect(isValidLocalHostWebsocketUrl(url)).toBe(false);
  });
});

describe("upstreamHostUrl", () => {
  it("passes the /rpc endpoint through unchanged", () => {
    expect(upstreamHostUrl(metadata, "rpc")).toBe("ws://127.0.0.1:48000/rpc");
  });

  it("swaps the /rpc suffix for /stream (mirror of toStreamDialUrl)", () => {
    expect(upstreamHostUrl(metadata, "stream")).toBe(
      "ws://127.0.0.1:48000/stream",
    );
  });
});

describe("webRuntimeConfigSchema", () => {
  it("round-trips the serve process's runtime-config payload", () => {
    const parsed = webRuntimeConfigSchema.parse({
      signInUrl: "https://platform.traycer.ai",
      systemHostName: "buildbox",
      host: {
        hostId: metadata.hostId,
        version: metadata.version,
        pid: metadata.pid,
        startedAt: metadata.startedAt,
      },
    });
    expect(parsed.host?.hostId).toBe("host-1");
  });

  it("accepts a hostless payload (no pid.json yet)", () => {
    const parsed = webRuntimeConfigSchema.parse({
      signInUrl: "https://platform.traycer.ai",
      systemHostName: "buildbox",
      host: null,
    });
    expect(parsed.host).toBeNull();
  });

  it("rejects a malformed host row", () => {
    expect(
      webRuntimeConfigSchema.safeParse({
        signInUrl: "https://platform.traycer.ai",
        systemHostName: "buildbox",
        host: { hostId: "" },
      }).success,
    ).toBe(false);
  });
});
