"use client";

import { useState, useRef, useCallback, KeyboardEvent } from "react";
import { useChatStore } from "@/stores/chatStore";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Send, Square } from "lucide-react";

export function InputBar() {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { isStreaming, addMessage } = useChatStore();
  const { sendMessage, stopStreaming } = useWebSocket();

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;

    addMessage({
      id: `msg-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    });

    sendMessage(text);
    setInput("");

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input, isStreaming, addMessage, sendMessage]);

  const handleKeyDown = (e: KeyboardEvent) => {
    // Ignore Enter during IME composition (Chinese/Japanese/Korean input)
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  };

  return (
    <div className="border-t p-4" style={{ borderColor: "var(--border)" }}>
      <div
        className="max-w-3xl mx-auto flex items-end gap-2 rounded-xl px-4 py-3"
        style={{ background: "var(--bg-tertiary)" }}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Type your message... (Enter to send, Shift+Enter for new line)"
          rows={1}
          className="flex-1 bg-transparent resize-none outline-none text-sm placeholder:text-[var(--text-secondary)]"
          style={{ maxHeight: 200 }}
          disabled={isStreaming}
        />
        {isStreaming ? (
          <div className="relative w-9 h-9 flex items-center justify-center flex-shrink-0">
            <div className="absolute inset-0 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: "var(--accent)", borderTopColor: "transparent" }} />
            <button
              onClick={stopStreaming}
              className="z-10 flex items-center justify-center"
              style={{ color: "var(--accent)" }}
            >
              <Square size={14} fill="currentColor" />
            </button>
          </div>
        ) : (
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            className="p-2 rounded-lg transition-colors disabled:opacity-40"
            style={{ color: input.trim() ? "var(--accent)" : "var(--text-secondary)" }}
          >
            <Send size={18} />
          </button>
        )}
      </div>
      <p className="text-xs text-center mt-2" style={{ color: "var(--text-secondary)" }}>
        AnyWork runs agents in isolated containers. Your workspace persists between sessions.
      </p>
    </div>
  );
}
