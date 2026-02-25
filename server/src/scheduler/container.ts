/**
 * Container manager - factory for container drivers.
 */

import { config } from "../config";
import { ContainerDriver } from "./drivers/interface";
import { StaticDriver } from "./drivers/static";
import { DockerDriver } from "./drivers/docker";

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

    // case "cloudrun":
    //   driver = new CloudRunDriver({ ... });  // Phase 2
    //   break;

    default:
      throw new Error(`Unknown container driver: ${config.containerDriver}`);
  }

  return driver;
}
