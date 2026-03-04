/**
 * Global test setup.
 *
 * - Set DB_DIR to a per-worker temp directory so each test file gets its own SQLite.
 * - Force static container driver pointed at a mock URL.
 * - Reset the DB singleton between test files (via dynamic import reset).
 */

import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { beforeAll, afterAll } from "vitest";

const tempDir = mkdtempSync(path.join(tmpdir(), "anywork-test-"));

process.env.DB_DIR = tempDir;
process.env.CONTAINER_DRIVER = "static";
process.env.STATIC_WORKER_URL = "http://mock-worker:8080";

beforeAll(() => {
  // Ensure DB is initialised before tests run
});

afterAll(() => {
  // Cleanup is handled by OS temp dir lifecycle
});
