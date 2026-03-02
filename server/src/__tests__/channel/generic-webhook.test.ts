import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { webhookChannel } from "../../channel/webhook";

describe("Generic Webhook Channel", () => {
  const originalEnv = process.env.WEBHOOK_SECRET;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.WEBHOOK_SECRET;
    } else {
      process.env.WEBHOOK_SECRET = originalEnv;
    }
  });

  describe("type", () => {
    it('should be "webhook"', () => {
      expect(webhookChannel.type).toBe("webhook");
    });
  });

  describe("verify()", () => {
    it("should accept all requests when WEBHOOK_SECRET is not set", async () => {
      delete process.env.WEBHOOK_SECRET;
      const result = await webhookChannel.verify({ headers: {}, body: {}, query: {} });
      expect(result).toBe(true);
    });

    it("should accept request with matching secret", async () => {
      process.env.WEBHOOK_SECRET = "my-secret";
      const result = await webhookChannel.verify({
        headers: { "x-webhook-secret": "my-secret" },
        body: {},
        query: {},
      });
      expect(result).toBe(true);
    });

    it("should reject request with wrong secret", async () => {
      process.env.WEBHOOK_SECRET = "my-secret";
      const result = await webhookChannel.verify({
        headers: { "x-webhook-secret": "wrong" },
        body: {},
        query: {},
      });
      expect(result).toBe(false);
    });

    it("should reject request with missing secret header", async () => {
      process.env.WEBHOOK_SECRET = "my-secret";
      const result = await webhookChannel.verify({
        headers: {},
        body: {},
        query: {},
      });
      expect(result).toBe(false);
    });
  });

  describe("toTaskRequest()", () => {
    it("should return null when message is missing", async () => {
      const result = await webhookChannel.toTaskRequest({
        headers: {},
        body: { event: "push" },
        query: {},
      });
      expect(result).toBeNull();
    });

    it("should parse a minimal payload", async () => {
      const result = await webhookChannel.toTaskRequest({
        headers: {},
        body: { message: "deploy to staging" },
        query: {},
      });
      expect(result).not.toBeNull();
      expect(result!.message).toBe("deploy to staging");
      expect(result!.channelType).toBe("webhook");
      expect(result!.sessionId).toMatch(/^wh-/); // auto-generated
    });

    it("should use provided session_id", async () => {
      const result = await webhookChannel.toTaskRequest({
        headers: {},
        body: { session_id: "gh-pr-42", message: "review this" },
        query: {},
      });
      expect(result!.sessionId).toBe("gh-pr-42");
    });

    it("should capture event, source, and meta in channelMeta", async () => {
      const result = await webhookChannel.toTaskRequest({
        headers: {},
        body: {
          message: "handle event",
          event: "pull_request.opened",
          source: "github",
          meta: { repo: "foo/bar", pr: 123 },
        },
        query: {},
      });
      expect(result!.channelMeta.event).toBe("pull_request.opened");
      expect(result!.channelMeta.source).toBe("github");
      expect(result!.channelMeta.repo).toBe("foo/bar");
      expect(result!.channelMeta.pr).toBe(123);
    });

    it("should capture callback_url in channelMeta", async () => {
      const result = await webhookChannel.toTaskRequest({
        headers: {},
        body: {
          message: "do something",
          callback_url: "https://example.com/done",
          callback_auth: "Bearer tok",
        },
        query: {},
      });
      expect(result!.channelMeta.callback_url).toBe("https://example.com/done");
      expect(result!.channelMeta.callback_auth).toBe("Bearer tok");
    });

    it("should forward skills and mcp_servers", async () => {
      const result = await webhookChannel.toTaskRequest({
        headers: {},
        body: {
          message: "go",
          skills: ["code-review"],
          mcp_servers: [{ name: "gh", transport: "stdio" }],
        },
        query: {},
      });
      expect(result!.skills).toEqual(["code-review"]);
      expect(result!.mcpServers).toEqual([{ name: "gh", transport: "stdio" }]);
    });
  });

  describe("deliver()", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("OK")));
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should POST result to callback_url", async () => {
      await webhookChannel.deliver!({
        status: "completed",
        result: "done",
        channelMeta: {
          callback_url: "https://example.com/cb",
          callback_auth: "Bearer abc",
        },
      });

      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = (fetch as any).mock.calls[0];
      expect(url).toBe("https://example.com/cb");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer abc");
      const body = JSON.parse(init.body);
      expect(body.status).toBe("completed");
      expect(body.result).toBe("done");
    });

    it("should do nothing when callback_url is absent", async () => {
      await webhookChannel.deliver!({
        status: "completed",
        result: "done",
        channelMeta: {},
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("should not throw on callback failure", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
      await expect(
        webhookChannel.deliver!({
          status: "completed",
          result: "done",
          channelMeta: { callback_url: "https://dead.host/cb" },
        })
      ).resolves.toBeUndefined();
    });
  });
});
