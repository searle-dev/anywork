/**
 * Container scheduler driver interface.
 *
 * Abstracts the difference between local Docker and Google Cloud Run.
 * Each driver knows how to create, destroy, and locate worker containers.
 */

export interface WorkerEndpoint {
  /** Base URL of the worker HTTP API, e.g. "http://localhost:8080" */
  url: string;
  /** Container / instance ID for lifecycle management */
  containerId: string;
}

export interface ContainerDriver {
  /** Get or create a worker endpoint for the given user */
  getWorkerEndpoint(userId: string): Promise<WorkerEndpoint>;
  /** Release a worker (stop container, etc.) */
  releaseWorker(userId: string): Promise<void>;
  /** Health check */
  isHealthy(endpoint: WorkerEndpoint): Promise<boolean>;
}
