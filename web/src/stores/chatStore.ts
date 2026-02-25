"use client";

import { create } from "zustand";
import type { Session, ChatMessage, ToolCall } from "@/lib/types";

interface ChatState {
  // Sessions
  sessions: Session[];
  activeSessionId: string | null;

  // Messages for active session
  messages: ChatMessage[];

  // Streaming state
  isStreaming: boolean;
  streamingContent: string;
  pendingToolCalls: ToolCall[];

  // Actions
  setSessions: (sessions: Session[]) => void;
  setActiveSession: (id: string | null) => void;
  confirmSession: (id: string) => void;
  addSession: (session: Session) => void;
  addMessage: (msg: ChatMessage) => void;
  setStreaming: (val: boolean) => void;
  appendStreamContent: (text: string) => void;
  appendToolCall: (content: string) => void;
  appendToolResult: (content: string) => void;
  finalizeStream: () => void;
  setMessages: (msgs: ChatMessage[]) => void;
  updateSessionTitle: (id: string, title: string) => void;
  removeSession: (id: string) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messages: [],
  isStreaming: false,
  streamingContent: "",
  pendingToolCalls: [],

  setSessions: (sessions) => set({ sessions }),
  // User explicitly switches to a session → clear messages
  setActiveSession: (id) => set({ activeSessionId: id, messages: [], streamingContent: "", pendingToolCalls: [] }),

  // Server confirmed a new session ID for current chat → just update ID, keep messages
  confirmSession: (id) => set({ activeSessionId: id }),
  addSession: (session) =>
    set((s) => ({
      sessions: s.sessions.some((x) => x.id === session.id)
        ? s.sessions
        : [session, ...s.sessions],
    })),

  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),

  setMessages: (msgs) => set({ messages: msgs }),

  setStreaming: (val) => set({ isStreaming: val, streamingContent: val ? "" : get().streamingContent }),

  appendStreamContent: (text) =>
    set((s) => ({ streamingContent: s.streamingContent + text })),

  appendToolCall: (content) =>
    set((s) => ({
      pendingToolCalls: [
        ...s.pendingToolCalls,
        { name: content, status: "running" as const },
      ],
    })),

  appendToolResult: (content) =>
    set((s) => {
      const calls = [...s.pendingToolCalls];
      const last = calls.findLastIndex((t) => t.status === "running");
      if (last !== -1) calls[last] = { ...calls[last], status: "done" as const, output: content };
      return { pendingToolCalls: calls };
    }),

  finalizeStream: () => {
    const { streamingContent, pendingToolCalls, messages } = get();
    if (streamingContent || pendingToolCalls.length > 0) {
      const completedToolCalls = pendingToolCalls.map((tc) =>
        tc.status === "running" ? { ...tc, status: "done" as const } : tc
      );
      const assistantMsg: ChatMessage = {
        id: `msg-${Date.now()}`,
        role: "assistant",
        content: streamingContent,
        timestamp: new Date().toISOString(),
        toolCalls: completedToolCalls.length > 0 ? completedToolCalls : undefined,
      };
      set({
        messages: [...messages, assistantMsg],
        streamingContent: "",
        pendingToolCalls: [],
        isStreaming: false,
      });
    } else {
      set({ isStreaming: false });
    }
  },

  updateSessionTitle: (id, title) =>
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === id ? { ...sess, title } : sess
      ),
    })),

  removeSession: (id) =>
    set((s) => ({
      sessions: s.sessions.filter((sess) => sess.id !== id),
      ...(s.activeSessionId === id
        ? { activeSessionId: null, messages: [], streamingContent: "", pendingToolCalls: [] }
        : {}),
    })),
}));
