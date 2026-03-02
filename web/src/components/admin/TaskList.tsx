"use client";

import { useAdminStore } from "@/stores/adminStore";
import { StatusBadge } from "./StatusBadge";

function formatDuration(ms: number | null): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(0)}s`;
}

function formatCost(usd: number | null): string {
  if (usd == null) return "-";
  return `$${usd.toFixed(2)}`;
}

export function TaskList() {
  const { tasks, selectedSessionId, selectedTaskId, loadingTasks, selectTask } = useAdminStore();

  if (!selectedSessionId) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: "var(--text-secondary)" }}>
        <span className="text-sm">Select a session</span>
      </div>
    );
  }

  if (loadingTasks) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: "var(--text-secondary)" }}>
        <span className="text-sm">Loading...</span>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: "var(--text-secondary)" }}>
        <span className="text-sm">No tasks</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 text-xs font-medium uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>
        Tasks ({tasks.length})
      </div>
      <div className="flex-1 overflow-y-auto px-2">
        {tasks.map((t) => (
          <div
            key={t.id}
            onClick={() => selectTask(t.id)}
            className={`px-3 py-2.5 rounded-lg mb-0.5 cursor-pointer transition-colors ${
              selectedTaskId === t.id ? "bg-[var(--bg-tertiary)]" : "hover:bg-[var(--bg-tertiary)]"
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <StatusBadge status={t.status} />
              <span className="text-sm truncate flex-1">{t.message.slice(0, 50)}{t.message.length > 50 ? "…" : ""}</span>
            </div>
            <div className="flex items-center gap-3 text-[11px]" style={{ color: "var(--text-secondary)" }}>
              <span>{formatDuration(t.durationMs)}</span>
              <span>{formatCost(t.costUsd)}</span>
              {t.workerId && <span className="truncate ml-auto max-w-[120px]">{t.workerId}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
