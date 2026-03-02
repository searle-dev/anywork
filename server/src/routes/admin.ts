import { Router } from "express";
import { config } from "../config";
import { getContainerDriver } from "../scheduler/container";

const router = Router();

// Get scheduler / worker overview
router.get("/workers", async (_req, res) => {
  const driver = getContainerDriver();
  const driverType = config.containerDriver; // static | docker | k8s

  // Collect known endpoints
  const endpoints: Array<{
    sessionId: string;
    containerId: string;
    url: string;
    healthy: boolean | null;
  }> = [];

  if (driver.listEndpoints) {
    const map = driver.listEndpoints();
    // Check health in parallel
    const checks = Array.from(map.entries()).map(async ([sessionId, ep]) => {
      let healthy: boolean | null = null;
      try {
        healthy = await driver.isHealthy(ep);
      } catch {
        healthy = false;
      }
      return { sessionId, containerId: ep.containerId, url: ep.url, healthy };
    });
    endpoints.push(...(await Promise.all(checks)));
  }

  res.json({
    driver: driverType,
    workerImage: config.workerImage,
    staticWorkerUrl: driverType === "static" ? config.staticWorkerUrl : undefined,
    k8s: driverType === "k8s" ? {
      namespace: config.k8s.namespace,
      workspaceStorage: config.k8s.workspaceStorage,
      idleTtlSeconds: config.k8s.idleTtlSeconds,
    } : undefined,
    workers: endpoints,
  });
});

export default router;
