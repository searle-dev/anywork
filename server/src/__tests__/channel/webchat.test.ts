import { describe, it, expect } from "vitest";
import { webChatChannel } from "../../channel/webchat";

describe("WebChat Channel", () => {
  describe("verify()", () => {
    it("should always return true", async () => {
      const result = await webChatChannel.verify({
        headers: {},
        body: {},
        query: {},
      });
      expect(result).toBe(true);
    });
  });

  describe("toTaskRequest()", () => {
    it("should parse message, session_id, skills, mcp_servers", async () => {
      const req = {
        headers: {},
        body: {
          type: "chat",
          session_id: "sess-123",
          message: "Hello",
          skills: ["code-review"],
          mcp_servers: [{ name: "github", transport: "stdio" as const }],
        },
        query: {},
      };
      const result = await webChatChannel.toTaskRequest(req);
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe("sess-123");
      expect(result!.message).toBe("Hello");
      expect(result!.skills).toEqual(["code-review"]);
      expect(result!.mcpServers).toEqual([{ name: "github", transport: "stdio" }]);
      expect(result!.channelType).toBe("webchat");
      expect(result!.channelMeta).toEqual({});
    });

    it("should return null when message is empty", async () => {
      const result = await webChatChannel.toTaskRequest({
        headers: {},
        body: { type: "chat", message: "" },
        query: {},
      });
      expect(result).toBeNull();
    });

    it("should return null when message is missing", async () => {
      const result = await webChatChannel.toTaskRequest({
        headers: {},
        body: { type: "chat" },
        query: {},
      });
      expect(result).toBeNull();
    });

    it("should use empty string for sessionId when session_id not provided", async () => {
      const result = await webChatChannel.toTaskRequest({
        headers: {},
        body: { type: "chat", message: "Hi" },
        query: {},
      });
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe("");
    });

    it("should default skills and mcp_servers to empty arrays", async () => {
      const result = await webChatChannel.toTaskRequest({
        headers: {},
        body: { type: "chat", session_id: "s1", message: "Hi" },
        query: {},
      });
      expect(result!.skills).toEqual([]);
      expect(result!.mcpServers).toEqual([]);
    });
  });

  describe("defaults", () => {
    it("should have empty skills and mcpServers arrays", () => {
      expect(webChatChannel.defaults.skills).toEqual([]);
      expect(webChatChannel.defaults.mcpServers).toEqual([]);
    });
  });

  describe("type", () => {
    it('should be "webchat"', () => {
      expect(webChatChannel.type).toBe("webchat");
    });
  });

  describe("deliver", () => {
    it("should not have a deliver method", () => {
      expect(webChatChannel.deliver).toBeUndefined();
    });
  });
});
