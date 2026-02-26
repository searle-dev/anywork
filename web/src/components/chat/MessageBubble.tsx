"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ToolCall } from "@/lib/types";
import { User, Bot, ChevronDown, ChevronRight, Terminal } from "lucide-react";

interface Props {
  message: ChatMessage;
  isStreaming?: boolean;
}

function ToolCallBlock({ tc }: { tc: ToolCall }) {
  const [open, setOpen] = useState(false);

  const name = tc.name ?? "";
  const summary = name.split("\n")[0].slice(0, 60) + (name.length > 60 ? "…" : "");

  return (
    <div className="rounded-lg overflow-hidden text-xs my-1"
         style={{ border: "1px solid var(--border)", background: "var(--bg-primary)" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-tertiary)] transition-colors"
        style={{ color: "var(--text-secondary)" }}
      >
        <Terminal size={12} className="flex-shrink-0" />
        <span className="flex-1 font-mono truncate">{summary}</span>
        {tc.status === "running" && (
          <span className="text-yellow-500 text-[10px]">running</span>
        )}
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>

      {open && (
        <div style={{ borderTop: "1px solid var(--border)" }}>
          <div className="px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide mb-1" style={{ color: "var(--text-secondary)" }}>Input</p>
            <pre className="whitespace-pre-wrap break-all font-mono text-xs overflow-auto max-h-48"
                 style={{ color: "var(--text-primary)" }}>{name}</pre>
          </div>
          {tc.output !== undefined && (
            <div className="px-3 py-2" style={{ borderTop: "1px solid var(--border)" }}>
              <p className="text-[10px] uppercase tracking-wide mb-1" style={{ color: "var(--text-secondary)" }}>Output</p>
              <pre className="whitespace-pre-wrap break-all font-mono text-xs overflow-auto max-h-48"
                   style={{ color: "var(--text-primary)" }}>{tc.output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
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
        className={`rounded-xl px-4 py-3 max-w-[85%] ${isUser ? "bg-blue-600 text-white" : ""}`}
        style={!isUser ? { background: "var(--bg-tertiary)" } : {}}
      >
        {isUser ? (
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>
        ) : (
          <>
            {message.toolCalls && message.toolCalls.length > 0 && (
              <div className="mb-2">
                {message.toolCalls.map((tc, i) => (
                  <ToolCallBlock key={i} tc={tc} />
                ))}
              </div>
            )}
            {message.content && (
              <div className={`markdown-content text-sm ${isStreaming ? "streaming-cursor" : ""}`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {message.content}
                </ReactMarkdown>
              </div>
            )}
          </>
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
