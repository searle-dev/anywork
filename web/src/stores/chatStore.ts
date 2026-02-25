"use client";

import { create } from "zustand";
import type { Session, ChatMessage } from "@/lib/types";

interface ChatState {
  // Sessions
  sessions: Session[];
  activeSessionId: string | null;

  // Messages for active session
  messages: ChatMessage[];

  // Streaming state
  isStreaming: boolean;
  streamingContent: string;

  // Actions
  setSessions: (sessions: Session[]) => void;
  setActiveSession: (id: string | null) => void;
  confirmSession: (id: string) => void;
  addSession: (session: Session) => void;
  addMessage: (msg: ChatMessage) => void;
  setStreaming: (val: boolean) => void;
  appendStreamContent: (text: string) => void;
  finalizeStream: () => void;
  setMessages: (msgs: ChatMessage[]) => void;
  updateSessionTitle: (id: string, title: string) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messages: [],
  isStreaming: false,
  streamingContent: "",

  setSessions: (sessions) => set({ sessions }),
  // User explicitly switches to a session → clear messages
  setActiveSession: (id) => set({ activeSessionId: id, messages: [], streamingContent: "" }),

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

  finalizeStream: () => {
    const { streamingContent, messages } = get();
    if (streamingContent) {
      const assistantMsg: ChatMessage = {
        id: `msg-${Date.now()}`,
        role: "assistant",
        content: streamingContent,
        timestamp: new Date().toISOString(),
      };
      set({
        messages: [...messages, assistantMsg],
        streamingContent: "",
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
}));
