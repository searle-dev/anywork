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

  // Container driver: "docker" | "cloudrun" | "static"
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

  // LLM for title generation (reads same .env as worker)
  llmApiKey: process.env.API_KEY || process.env.ANTHROPIC_API_KEY || "",
  llmApiBaseUrl: process.env.API_BASE_URL || "",
  titleModel: process.env.TITLE_MODEL || "openai/gpt-4o-mini",
};
