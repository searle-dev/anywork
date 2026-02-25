/**
 * Docker container driver.
 *
 * Manages per-user worker containers using the Docker CLI.
 * Each user gets their own container with a dedicated workspace volume mount.
 *
 * Phase 2 will add a Cloud Run driver with similar interface.
 */

import { execSync, exec } from "child_process";
import { ContainerDriver, WorkerEndpoint } from "./interface";

export class DockerDriver implements ContainerDriver {
  private image: string;
  private dataDir: string;
  private workerPort: number;
  private anthropicApiKey: string;
  private defaultModel: string;
  private containers: Map<string, WorkerEndpoint> = new Map();
  private nextPort = 18800;

  constructor(opts: {
    image: string;
    dataDir: string;
    workerPort: number;
    anthropicApiKey: string;
    defaultModel: string;
  }) {
    this.image = opts.image;
    this.dataDir = opts.dataDir;
    this.workerPort = opts.workerPort;
    this.anthropicApiKey = opts.anthropicApiKey;
    this.defaultModel = opts.defaultModel;
  }

  async getWorkerEndpoint(userId: string): Promise<WorkerEndpoint> {
    // Check if container already exists
    const existing = this.containers.get(userId);
    if (existing && (await this.isHealthy(existing))) {
      return existing;
    }

    // Assign a host port
    const hostPort = this.nextPort++;
    const containerName = `anywork-worker-${userId}`;

    // Ensure user data directory exists
    const userDataDir = `${this.dataDir}/${userId}`;
    execSync(`mkdir -p ${userDataDir}`);

    // Remove stale container if exists
    try {
      execSync(`docker rm -f ${containerName} 2>/dev/null`);
    } catch {}

    // Start new container
    const envFlags = this.anthropicApiKey
      ? `-e ANTHROPIC_API_KEY=${this.anthropicApiKey} -e DEFAULT_MODEL=${this.defaultModel}`
      : "";

    const cmd = [
      "docker run -d",
      `--name ${containerName}`,
      `-p ${hostPort}:${this.workerPort}`,
      `-v ${userDataDir}:/workspace`,
      envFlags,
      this.image,
    ]
      .filter(Boolean)
      .join(" ");

    const containerId = execSync(cmd).toString().trim().slice(0, 12);

    const endpoint: WorkerEndpoint = {
      url: `http://localhost:${hostPort}`,
      containerId,
    };

    this.containers.set(userId, endpoint);

    // Wait for container to be ready
    await this.waitForReady(endpoint, 30);

    return endpoint;
  }

  async releaseWorker(userId: string): Promise<void> {
    const containerName = `anywork-worker-${userId}`;
    try {
      execSync(`docker stop ${containerName} && docker rm ${containerName}`);
    } catch {}
    this.containers.delete(userId);
  }

  async isHealthy(endpoint: WorkerEndpoint): Promise<boolean> {
    try {
      const res = await fetch(`${endpoint.url}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async waitForReady(
    endpoint: WorkerEndpoint,
    timeoutSeconds: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      if (await this.isHealthy(endpoint)) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(
      `Worker container failed to become healthy within ${timeoutSeconds}s`
    );
  }
}
