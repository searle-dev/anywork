import express from "express";
import cors from "cors";
import morgan from "morgan";
import { createServer } from "http";
import { WebSocketServer } from "ws";

import { config } from "./config";
import { getDb } from "./db/schema";
import sessionsRouter from "./routes/sessions";
import tasksRouter from "./routes/tasks";
import channelRouter from "./routes/channel";
import workspaceRouter from "./routes/workspace";
import { handleWebSocket } from "./ws/handler";
import { registerChannel, webChatChannel } from "./channel";

const app = express();

// Middleware
app.use(cors());
app.use(morgan("short"));
app.use(express.json());

// Register channels
registerChannel(webChatChannel);

// REST routes
app.use("/api/sessions", sessionsRouter);
app.use("/api/tasks", tasksRouter);
app.use("/api/channel", channelRouter);
app.use("/api/workspace", workspaceRouter);

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", version: "0.2.0" });
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
  ║   AnyWork API Server v0.2.0          ║
  ║   http://localhost:${config.port}              ║
  ║   WebSocket: ws://localhost:${config.port}/ws  ║
  ║   Driver: ${config.containerDriver.padEnd(27)}║
  ╚══════════════════════════════════════╝
  `);
});
