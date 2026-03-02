/**
 * Static container driver.
 *
 * In docker-compose, the worker is a pre-running service at a fixed URL.
 * This driver simply returns that URL for all sessions.
 * Suitable for local development and single-session setups.
 */

import { ContainerDriver, WorkerEndpoint, checkWorkerHealth } from "./interface";

export class StaticDriver implements ContainerDriver {
  private workerUrl: string;

  constructor(workerUrl: string) {
    this.workerUrl = workerUrl;
  }

  async getWorkerEndpoint(_sessionId: string): Promise<WorkerEndpoint> {
    return {
      url: this.workerUrl,
      containerId: "static-worker",
    };
  }

  listEndpoints(): Map<string, WorkerEndpoint> {
    const map = new Map<string, WorkerEndpoint>();
    map.set("*", { url: this.workerUrl, containerId: "static-worker" });
    return map;
  }

  async releaseWorker(_sessionId: string): Promise<void> {
    // No-op for static worker
  }

  async isHealthy(endpoint: WorkerEndpoint): Promise<boolean> {
    return checkWorkerHealth(endpoint);
  }
}
