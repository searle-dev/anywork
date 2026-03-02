/**
 * Container manager - factory for container drivers.
 */

import { config } from "../config";
import { ContainerDriver } from "./drivers/interface";
import { StaticDriver } from "./drivers/static";
import { DockerDriver } from "./drivers/docker";
import { K8sDriver } from "./drivers/k8s";

let driver: ContainerDriver | null = null;

export function getContainerDriver(): ContainerDriver {
  if (driver) return driver;

  switch (config.containerDriver) {
    case "static":
      driver = new StaticDriver(config.staticWorkerUrl);
      break;

    case "docker":
      driver = new DockerDriver({
        image: config.workerImage,
        dataDir: config.localDataDir,
        workerPort: config.workerPort,
        anthropicApiKey: config.anthropicApiKey,
        defaultModel: config.defaultModel,
      });
      break;

    case "k8s":
      driver = new K8sDriver({
        namespace: config.k8s.namespace,
        workerImage: config.workerImage,
        workerEnv: {
          ANTHROPIC_API_KEY: config.anthropicApiKey,
          API_KEY: config.apiKey,
          API_BASE_URL: config.apiBaseUrl,
          MODEL: config.defaultModel,
        },
        workspaceStorage: config.k8s.workspaceStorage,
        pvcStorageClass: config.k8s.pvcStorageClass,
        resources: config.k8s.resources,
        idleTtlSeconds: config.k8s.idleTtlSeconds,
      });
      break;

    default:
      throw new Error(`Unknown container driver: ${config.containerDriver}`);
  }

  return driver;
}
