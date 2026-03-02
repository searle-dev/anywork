import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

export const config = {
  port: parseInt(process.env.SERVER_PORT || "3001", 10),
  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-me",

  // Worker
  workerPort: parseInt(process.env.WORKER_PORT || "8080", 10),
  workerImage: process.env.WORKER_IMAGE || "anywork-worker:latest",
  defaultModel: process.env.DEFAULT_MODEL || "claude-sonnet-4-20250514",

  // Container driver: "docker" | "cloudrun" | "static" | "k8s"
  containerDriver: process.env.CONTAINER_DRIVER || "static",

  // Storage
  storageDriver: process.env.STORAGE_DRIVER || "local",
  localDataDir: process.env.LOCAL_DATA_DIR || "/data/users",

  // Static worker URL (for docker-compose where worker is a fixed service)
  staticWorkerUrl: process.env.STATIC_WORKER_URL || "http://worker:8080",

  // Database
  databaseUrl: process.env.DATABASE_URL || "sqlite:///data/anywork.db",

  // LLM keys (passed to worker)
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  apiKey: process.env.API_KEY || process.env.ANTHROPIC_API_KEY || "",
  apiBaseUrl: process.env.API_BASE_URL || "",

  // LLM for title generation (reads same .env as worker)
  llmApiKey: process.env.API_KEY || process.env.ANTHROPIC_API_KEY || "",
  llmApiBaseUrl: process.env.API_BASE_URL || "",
  titleModel: process.env.TITLE_MODEL || "openai/gpt-4o-mini",

  // ── Kubernetes driver settings ────────────────────────────────────────────
  k8s: {
    /** Namespace where worker pods are created */
    namespace: process.env.K8S_NAMESPACE || "anywork",
    /**
     * Workspace storage mode:
     *   "emptydir" – ephemeral per-session (no persistence across restarts)
     *   "pvc"      – per-user PersistentVolumeClaim (persistent workspace)
     */
    workspaceStorage: (process.env.K8S_WORKSPACE_STORAGE || "emptydir") as
      | "emptydir"
      | "pvc",
    /** StorageClass for PVCs (used only when workspaceStorage="pvc") */
    pvcStorageClass: process.env.K8S_PVC_STORAGE_CLASS || "standard",
    /** Pod resource requests/limits */
    resources: {
      cpuRequest: process.env.K8S_CPU_REQUEST || "250m",
      cpuLimit: process.env.K8S_CPU_LIMIT || "2000m",
      memoryRequest: process.env.K8S_MEMORY_REQUEST || "512Mi",
      memoryLimit: process.env.K8S_MEMORY_LIMIT || "2Gi",
    },
    /** Seconds a pod can be idle before auto-cleanup (0 = disabled) */
    idleTtlSeconds: parseInt(process.env.K8S_IDLE_TTL_SECONDS || "1800", 10),
  },
};
