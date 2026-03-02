"use client";

import { useAdminStore } from "@/stores/adminStore";
import { ChannelBadge } from "./StatusBadge";

function timeAgo(unix: number): string {
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function SessionList() {
  const { sessions, selectedSessionId, loadingSessions, selectSession } = useAdminStore();

  if (loadingSessions) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: "var(--text-secondary)" }}>
        <span className="text-sm">Loading...</span>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: "var(--text-secondary)" }}>
        <span className="text-sm">No sessions</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 text-xs font-medium uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>
        Sessions ({sessions.length})
      </div>
      <div className="flex-1 overflow-y-auto px-2">
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => selectSession(s.id)}
            className={`px-3 py-2.5 rounded-lg mb-0.5 cursor-pointer transition-colors ${
              selectedSessionId === s.id ? "bg-[var(--bg-tertiary)]" : "hover:bg-[var(--bg-tertiary)]"
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <ChannelBadge type={s.channel_type} />
              <span className="text-sm truncate flex-1">{s.title}</span>
            </div>
            <div className="flex items-center gap-2 text-[11px]" style={{ color: "var(--text-secondary)" }}>
              <span>{s.task_count} task{s.task_count !== 1 ? "s" : ""}</span>
              <span>&middot;</span>
              <span>{timeAgo(s.last_active)}</span>
              {s.active_task_count > 0 && (
                <span className="text-blue-400 ml-auto">{s.active_task_count} active</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
