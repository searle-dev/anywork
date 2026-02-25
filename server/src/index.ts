import express from "express";
import cors from "cors";
import morgan from "morgan";
import { createServer } from "http";
import { WebSocketServer } from "ws";

import { config } from "./config";
import { getDb } from "./db/schema";
import sessionsRouter from "./routes/sessions";
import workspaceRouter from "./routes/workspace";
import { handleWebSocket } from "./ws/handler";

const app = express();

// Middleware
app.use(cors());
app.use(morgan("short"));
app.use(express.json());

// Simple auth middleware (dev mode: auto-assign default user)
app.use((req: any, _res, next) => {
  // TODO: JWT validation in production
  req.userId = "default";
  next();
});

// REST routes
app.use("/api/sessions", sessionsRouter);
app.use("/api/workspace", workspaceRouter);

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", version: "0.1.0" });
});

// Create HTTP server
const server = createServer(app);

// WebSocket server
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  handleWebSocket(ws, req);
});

// Initialize database
getDb();

// Start server
server.listen(config.port, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   AnyWork API Server v0.1.0          ║
  ║   http://localhost:${config.port}              ║
  ║   WebSocket: ws://localhost:${config.port}/ws  ║
  ║   Driver: ${config.containerDriver.padEnd(27)}║
  ╚══════════════════════════════════════╝
  `);
});
