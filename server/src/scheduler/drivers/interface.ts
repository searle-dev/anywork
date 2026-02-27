/**
 * Container scheduler driver interface.
 *
 * Abstracts the difference between local Docker, Google Cloud Run, and Kubernetes.
 * Each driver knows how to create, destroy, and locate worker containers.
 */

export interface WorkerEndpoint {
  /** Base URL of the worker HTTP API, e.g. "http://localhost:8080" */
  url: string;
  /** Container / instance ID for lifecycle management */
  containerId: string;
}

/** MCP server connection config passed from the client chat request. */
export interface MCPServerConfig {
  /** Logical name for this MCP server (e.g. "github", "jira") */
  name: string;
  /**
   * Transport type:
   *  - "stdio"  → launch a local subprocess (command + args + env)
   *  - "sse"    → connect to a remote SSE endpoint (url)
   */
  transport: "stdio" | "sse";
  /** For stdio transport: command to execute */
  command?: string;
  /** For stdio transport: command arguments */
  args?: string[];
  /** For stdio/sse transport: extra environment variables */
  env?: Record<string, string>;
  /** For sse transport: URL of the SSE endpoint */
  url?: string;
}

/**
 * Per-request worker specification.
 * Carries the skills and MCP servers the user wants for this session,
 * plus an optional engine override.
 */
export interface WorkerSpec {
  /**
   * Session-level routing key (preferred over userId for K8s per-session pods).
   * When provided, the driver creates/reuses a pod scoped to this session.
   */
  sessionId?: string;
  /** Skill names to activate (e.g. ["code-review", "data-analysis"]). */
  skills?: string[];
  /** MCP servers to connect on worker startup. */
  mcpServers?: MCPServerConfig[];
  /** Execution engine: "nanobot" (default) or "claudecode". */
  engine?: "nanobot" | "claudecode";
}

export interface ContainerDriver {
  /**
   * Get or create a worker endpoint for the given user.
   * @param userId   Owning user (used for workspace isolation and fallback routing).
   * @param spec     Optional per-session/per-request worker specification.
   */
  getWorkerEndpoint(userId: string, spec?: WorkerSpec): Promise<WorkerEndpoint>;
  /** Release a worker (stop container, etc.) */
  releaseWorker(userId: string): Promise<void>;
  /** Health check */
  isHealthy(endpoint: WorkerEndpoint): Promise<boolean>;
}
