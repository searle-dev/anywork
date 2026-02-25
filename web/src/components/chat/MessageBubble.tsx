"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "@/lib/types";
import { User, Bot } from "lucide-react";

interface Props {
  message: ChatMessage;
  isStreaming?: boolean;
}

export function MessageBubble({ message, isStreaming }: Props) {
  const isUser = message.role === "user";

  return (
    <div className={`flex gap-3 mb-4 ${isUser ? "justify-end" : ""}`}>
      {!isUser && (
        <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Bot size={16} className="text-blue-500" />
        </div>
      )}

      <div
        className={`rounded-xl px-4 py-3 max-w-[85%] ${
          isUser
            ? "bg-blue-600 text-white"
            : ""
        }`}
        style={!isUser ? { background: "var(--bg-tertiary)" } : {}}
      >
        {isUser ? (
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className={`markdown-content text-sm ${isStreaming ? "streaming-cursor" : ""}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {message.content}
            </ReactMarkdown>
          </div>
        )}
      </div>

      {isUser && (
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
          style={{ background: "var(--bg-tertiary)" }}
        >
          <User size={16} style={{ color: "var(--text-secondary)" }} />
        </div>
      )}
    </div>
  );
}
