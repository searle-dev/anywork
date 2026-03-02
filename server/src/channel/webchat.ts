import type { Channel, IncomingRequest, TaskRequest, MCPServerConfig } from "./types";

interface WebChatMessage {
  type: "chat";
  session_id?: string;
  message: string;
  skills?: string[];
  mcp_servers?: MCPServerConfig[];
}

export const webChatChannel: Channel = {
  type: "webchat",

  defaults: {
    skills: [],
    mcpServers: [],
  },

  async verify(): Promise<boolean> {
    // WebSocket connections are already authenticated at connection level
    return true;
  },

  async toTaskRequest(req: IncomingRequest): Promise<TaskRequest | null> {
    const msg = req.body as unknown as WebChatMessage;
    if (!msg.message) return null;

    return {
      sessionId: msg.session_id ?? "",  // caller fills in if empty
      channelType: "webchat",
      channelMeta: {},
      message: msg.message,
      skills: msg.skills ?? [],
      mcpServers: msg.mcp_servers ?? [],
    };
  },

  // No deliver — interactive mode uses WebSocket real-time push
};
