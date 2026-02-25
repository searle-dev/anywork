"use client";

import { useState } from "react";
import { useChatStore } from "@/stores/chatStore";
import { fetchSessionMessages } from "@/lib/api";
import { Plus, MessageSquare, Zap, Settings } from "lucide-react";
import { WorkspaceEditor } from "@/components/settings/WorkspaceEditor";

export function Sidebar() {
  const { sessions, activeSessionId, setActiveSession, setMessages } = useChatStore();
  const [editorOpen, setEditorOpen] = useState(false);

  const handleNewChat = () => {
    setActiveSession(null);
  };

  const handleSelectSession = async (sessionId: string) => {
    setActiveSession(sessionId);
    try {
      const { messages } = await fetchSessionMessages(sessionId);
      setMessages(
        messages.map((m, i) => ({
          id: `${sessionId}-${i}`,
          role: m.role as "user" | "assistant",
          content: m.content,
          timestamp: m.timestamp,
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
          <button
            key={session.id}
            onClick={() => handleSelectSession(session.id)}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm mb-0.5 transition-colors text-left truncate ${
              activeSessionId === session.id
                ? "bg-[var(--bg-tertiary)]"
                : "hover:bg-[var(--bg-tertiary)]"
            }`}
          >
            <MessageSquare size={14} style={{ color: "var(--text-secondary)", flexShrink: 0 }} />
            <span className="truncate">{session.title}</span>
          </button>
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
