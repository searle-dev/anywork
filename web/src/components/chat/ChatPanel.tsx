"use client";

import { useRef, useEffect } from "react";
import { useChatStore } from "@/stores/chatStore";
import { MessageBubble } from "./MessageBubble";
import { InputBar } from "./InputBar";
import { Zap } from "lucide-react";

export function ChatPanel() {
  const { messages, isStreaming, streamingContent, activeSessionId } = useChatStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamingContent]);

  const isEmpty = messages.length === 0 && !isStreaming;

  return (
    <main className="flex-1 flex flex-col min-w-0">
      {/* Header bar */}
      <header
        className="h-12 flex items-center px-4 border-b flex-shrink-0"
        style={{ borderColor: "var(--border)", background: "var(--bg-secondary)" }}
      >
        <span className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
          {activeSessionId ? "Chat" : "New Chat"}
        </span>
      </header>

      {/* Messages area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <div className="w-16 h-16 rounded-2xl bg-blue-500/10 flex items-center justify-center">
              <Zap size={32} className="text-blue-500" />
            </div>
            <h2 className="text-xl font-semibold">AnyWork</h2>
            <p className="text-sm max-w-md text-center" style={{ color: "var(--text-secondary)" }}>
              Your AI agent runs in a secure container with its own workspace.
              Ask anything — coding, writing, analysis, file operations, and more.
            </p>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto py-4 px-4">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
            {isStreaming && streamingContent && (
              <MessageBubble
                message={{
                  id: "streaming",
                  role: "assistant",
                  content: streamingContent,
                  timestamp: new Date().toISOString(),
                }}
                isStreaming
              />
            )}
          </div>
        )}
      </div>

      {/* Input bar */}
      <InputBar />
    </main>
  );
}
