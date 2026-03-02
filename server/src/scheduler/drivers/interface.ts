/**
 * Container scheduler driver interface.
 *
 * Abstracts the difference between local Docker, Kubernetes, and future runtimes.
 * Each driver knows how to create, destroy, and locate worker containers.
 *
 * Routing key is `sessionId` — no user-level abstraction in anywork core.
 */

export interface WorkerEndpoint {
  /** Base URL of the worker HTTP API, e.g. "http://localhost:8080" */
  url: string;
  /** Container / Pod / instance identifier for lifecycle management */
  containerId: string;
}

export interface ContainerDriver {
  /**
   * Get or create a worker endpoint for the given session.
   * Same sessionId will reuse the same worker (pod/container).
   */
  getWorkerEndpoint(sessionId: string): Promise<WorkerEndpoint>;

  /** Release a worker (stop container / delete pod). */
  releaseWorker(sessionId: string): Promise<void>;

  /** Health check. */
  isHealthy(endpoint: WorkerEndpoint): Promise<boolean>;
}
