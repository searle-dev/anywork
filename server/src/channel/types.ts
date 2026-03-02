export interface MCPServerConfig {
  name: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface ChannelDefaults {
  skills: string[];
  mcpServers: MCPServerConfig[];
}

export interface TaskRequest {
  sessionId: string;
  channelType: string;
  channelMeta: Record<string, unknown>;
  message: string;
  skills: string[];
  mcpServers: MCPServerConfig[];
  pushNotification?: {
    webhookUrl: string;
    authHeader?: string;
    events?: string[];
  };
}

export interface IncomingRequest {
  headers: Record<string, string>;
  body: Record<string, unknown>;
  query: Record<string, string>;
}

export interface Channel {
  readonly type: string;
  readonly defaults: ChannelDefaults;

  /** Verify inbound request (signature check, etc.) */
  verify(req: IncomingRequest): Promise<boolean>;

  /** Convert raw request to unified TaskRequest. Return null to skip. */
  toTaskRequest(req: IncomingRequest): Promise<TaskRequest | null>;

  /** Deliver result back to source platform (oneshot mode). */
  deliver?(task: { status: string; result?: string | null; channelMeta: Record<string, unknown> }): Promise<void>;
}
