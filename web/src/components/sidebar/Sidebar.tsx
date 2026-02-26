"use client";

import { useState } from "react";
import { useChatStore } from "@/stores/chatStore";
import { fetchSessionMessages, deleteSession } from "@/lib/api";
import { Plus, MessageSquare, Zap, Settings, Trash2 } from "lucide-react";
import { WorkspaceEditor } from "@/components/settings/WorkspaceEditor";

export function Sidebar() {
  const { sessions, activeSessionId, isStreaming, setActiveSession, setMessages, removeSession } = useChatStore();
  const [editorOpen, setEditorOpen] = useState(false);

  const handleNewChat = () => {
    setActiveSession(null);
  };

  const handleDeleteSession = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    removeSession(sessionId);
    await deleteSession(sessionId);
  };

  const handleSelectSession = async (sessionId: string) => {
    // Don't interrupt an active stream in the current session
    if (sessionId === activeSessionId && isStreaming) return;

    setActiveSession(sessionId);
    try {
      const { messages } = await fetchSessionMessages(sessionId);
      // Guard against race: only update if still on this session and not mid-stream
      const state = useChatStore.getState();
      if (state.activeSessionId !== sessionId || state.isStreaming) return;
      setMessages(
        messages.map((m, i) => ({
          id: `${sessionId}-${i}`,
          role: m.role as "user" | "assistant",
          content: m.content,
          timestamp: m.timestamp,
          toolCalls: m.tool_calls?.map((tc) => ({
            name: tc.name,
            status: tc.status as "running" | "done" | "error",
          })),
        }))
      );
    } catch {
      // messages remain empty if fetch fails
    }
  };

  return (
    <aside className="w-64 flex-shrink-0 border-r flex flex-col"
      style={{ borderColor: "var(--border)", background: "var(--bg-secondary)" }}>

      {/* Header */}
      <div className="p-4 flex items-center gap-2">
        <Zap size={20} className="text-blue-500" />
        <span className="font-semibold text-lg">AnyWork</span>
      </div>

      {/* New Chat button */}
      <div className="px-3 pb-3">
        <button
          onClick={handleNewChat}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors hover:bg-[var(--bg-tertiary)]"
          style={{ border: "1px solid var(--border)" }}
        >
          <Plus size={16} />
          New Chat
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2">
        {sessions.map((session) => (
          <div
            key={session.id}
            className={`group relative flex items-center gap-2 px-3 py-2 rounded-lg text-sm mb-0.5 transition-colors cursor-pointer ${
              activeSessionId === session.id
                ? "bg-[var(--bg-tertiary)]"
                : "hover:bg-[var(--bg-tertiary)]"
            }`}
            onClick={() => handleSelectSession(session.id)}
          >
            <MessageSquare size={14} style={{ color: "var(--text-secondary)", flexShrink: 0 }} />
            <span className="flex-1 truncate">{session.title}</span>
            <button
              onClick={(e) => handleDeleteSession(e, session.id)}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:text-red-400 flex-shrink-0"
              style={{ color: "var(--text-secondary)" }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="p-3 text-xs flex items-center justify-between"
           style={{ color: "var(--text-secondary)" }}>
        <span>Open Source &middot; MIT License</span>
        <button onClick={() => setEditorOpen(true)}
          className="hover:text-[var(--text-primary)] transition-colors">
          <Settings size={14} />
        </button>
      </div>
      <WorkspaceEditor open={editorOpen} onClose={() => setEditorOpen(false)} />
    </aside>
  );
}
