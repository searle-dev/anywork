"use client";

import { useCallback, useEffect, useRef } from "react";
import { useChatStore } from "@/stores/chatStore";
import type { ServerEvent } from "@/lib/types";
import { WS_URL } from "@/lib/api";

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<NodeJS.Timeout | null>(null);

  const {
    activeSessionId,
    appendStreamContent,
    appendToolCall,
    appendToolResult,
    finalizeStream,
    setStreaming,
    confirmSession,
    addSession,
    updateSessionTitle,
  } = useChatStore();

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[WS] Connected");
    };

    ws.onmessage = (event) => {
      const msg: ServerEvent = JSON.parse(event.data);

      switch (msg.type) {
        case "text":
          appendStreamContent(msg.content || "");
          break;

        case "tool_call":
          appendToolCall(msg.content || "");
          break;

        case "tool_result":
          appendToolResult(msg.content || "");
          break;

        case "error":
          appendStreamContent(`\n\n**Error:** ${msg.content}\n`);
          finalizeStream();
          break;

        case "done":
          finalizeStream();
          break;

        case "session_created":
          if (msg.session_id) {
            confirmSession(msg.session_id);
            addSession({
              id: msg.session_id,
              title: "New Chat",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
          }
          break;

        case "session_title":
          if (msg.session_id && msg.content) {
            updateSessionTitle(msg.session_id, msg.content);
          }
          break;

        case "pong":
          break;
      }
    };

    ws.onclose = () => {
      console.log("[WS] Disconnected, reconnecting in 3s...");
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = (err) => {
      console.error("[WS] Error:", err);
    };
  }, [appendStreamContent, appendToolCall, appendToolResult, finalizeStream, confirmSession, addSession, updateSessionTitle]);

  const sendMessage = useCallback(
    (message: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.error("[WS] Not connected");
        return;
      }

      setStreaming(true);

      ws.send(
        JSON.stringify({
          type: "chat",
          session_id: useChatStore.getState().activeSessionId,
          message,
        })
      );
    },
    [setStreaming]
  );

  // Connect on mount
  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  // Heartbeat
  useEffect(() => {
    const interval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "ping" }));
      }
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  return { sendMessage, isConnected: wsRef.current?.readyState === WebSocket.OPEN };
}
