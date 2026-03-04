import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// ── Backward compatibility: map old var names → new ANTHROPIC_* names ──────
const legacyMappings: [string, string][] = [
  ["API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  ["API_BASE_URL", "ANTHROPIC_BASE_URL"],
  ["MODEL", "ANTHROPIC_MODEL"],
];

for (const [oldName, newName] of legacyMappings) {
  const oldVal = process.env[oldName];
  if (oldVal !== undefined && !process.env[newName]) {
    process.env[newName] = oldVal;
    console.warn(
      `[config] DEPRECATED: ${oldName} is deprecated, use ${newName} instead. ` +
      `Auto-mapped for this run.`,
    );
  }
}

// ── Auto-collect all ANTHROPIC_* and CLAUDE_* env vars ─────────────────────
function collectLlmEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_"))) {
      env[key] = value;
    }
  }
  return env;
}

const llmEnv = collectLlmEnv();

export const config = {
  port: parseInt(process.env.SERVER_PORT || "3001", 10),
  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-me",

  // Worker
  workerPort: parseInt(process.env.WORKER_PORT || "8080", 10),
  workerImage: process.env.WORKER_IMAGE || "anywork-worker:latest",

  // Container driver: "docker" | "cloudrun" | "static" | "k8s"
  containerDriver: process.env.CONTAINER_DRIVER || "static",

  // Storage
  storageDriver: process.env.STORAGE_DRIVER || "local",
  localDataDir: process.env.LOCAL_DATA_DIR || "/data/users",

  // Static worker URL (for docker-compose where worker is a fixed service)
  staticWorkerUrl: process.env.STATIC_WORKER_URL || "http://worker:8080",

  // Database
  databaseUrl: process.env.DATABASE_URL || "sqlite:///data/anywork.db",

  // LLM env vars (auto-collected, passed to workers as-is)
  llmEnv,

  // Title generation (independent LLM call)
  title: {
    apiKey: process.env.TITLE_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "",
    apiBaseUrl: process.env.TITLE_API_BASE_URL || process.env.ANTHROPIC_BASE_URL || "",
    model: process.env.TITLE_MODEL || "openai/gpt-4o-mini",
  },

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

  /** HTTP proxy for worker pods to access external APIs (e.g. LLM endpoints) */
  workerHttpProxy: process.env.WORKER_HTTP_PROXY || "",
};
