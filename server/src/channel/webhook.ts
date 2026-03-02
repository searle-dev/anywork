/**
 * Generic webhook channel.
 *
 * Accepts arbitrary event payloads via POST /api/channel/webhook/webhook.
 * Flexible enough for GitHub, Slack, CI/CD, cron, or any HTTP caller.
 *
 * Payload format:
 *   {
 *     "session_id": "optional-session-id",
 *     "message":    "task instruction (required)",
 *     "event":      "pull_request.opened",        // optional, stored in channelMeta
 *     "source":     "github",                      // optional, stored in channelMeta
 *     "meta":       { ... },                       // optional, merged into channelMeta
 *     "skills":     ["code-review"],               // optional
 *     "mcp_servers": [],                           // optional
 *     "callback_url": "https://...",               // optional, result POSTed back here
 *     "callback_auth": "Bearer xxx"                // optional, Authorization header for callback
 *   }
 *
 * Verification:
 *   If WEBHOOK_SECRET is set, requires X-Webhook-Secret header to match.
 *   Otherwise accepts all requests (suitable for local dev).
 *
 * Deliver:
 *   If callback_url is present in channelMeta, POSTs the task result back.
 */

import { v4 as uuid } from "uuid";
import type { Channel, IncomingRequest, TaskRequest } from "./types";

interface WebhookPayload {
  session_id?: string;
  message?: string;
  event?: string;
  source?: string;
  meta?: Record<string, unknown>;
  skills?: string[];
  mcp_servers?: Array<{
    name: string;
    transport: "stdio" | "sse";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
  }>;
  callback_url?: string;
  callback_auth?: string;
}

export const webhookChannel: Channel = {
  type: "webhook",

  defaults: {
    skills: [],
    mcpServers: [],
  },

  async verify(req: IncomingRequest): Promise<boolean> {
    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) return true; // no secret = accept all (dev mode)
    return req.headers["x-webhook-secret"] === secret;
  },

  async toTaskRequest(req: IncomingRequest): Promise<TaskRequest | null> {
    const body = req.body as unknown as WebhookPayload;

    if (!body.message) return null;

    return {
      sessionId: body.session_id || `wh-${uuid().slice(0, 8)}`,
      channelType: "webhook",
      channelMeta: {
        event: body.event,
        source: body.source,
        callback_url: body.callback_url,
        callback_auth: body.callback_auth,
        ...body.meta,
      },
      message: body.message,
      skills: body.skills ?? [],
      mcpServers: body.mcp_servers ?? [],
    };
  },

  async deliver(task) {
    const callbackUrl = task.channelMeta.callback_url as string | undefined;
    if (!callbackUrl) return;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const auth = task.channelMeta.callback_auth as string | undefined;
    if (auth) headers["Authorization"] = auth;

    try {
      await fetch(callbackUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          status: task.status,
          result: task.result,
          channelMeta: task.channelMeta,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err: any) {
      console.error(`[Webhook] Callback to ${callbackUrl} failed:`, err.message);
    }
  },
};
