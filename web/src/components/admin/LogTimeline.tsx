"use client";

import { useState, useEffect, useRef } from "react";
import type { TaskLog } from "@/lib/adminTypes";
import { useAdminStore } from "@/stores/adminStore";

const TYPE_STYLES: Record<string, { color: string; label: string }> = {
  text:        { color: "text-gray-400",   label: "text" },
  tool_call:   { color: "text-blue-400",   label: "tool_call" },
  tool_result: { color: "text-green-400",  label: "tool_result" },
  error:       { color: "text-red-400",    label: "error" },
  done:        { color: "text-emerald-400", label: "done" },
};

function LogEntry({ log }: { log: TaskLog }) {
  const [expanded, setExpanded] = useState(false);
  const style = TYPE_STYLES[log.type] ?? { color: "text-gray-400", label: log.type };

  const preview = log.type === "tool_call"
    ? (log.metadata?.tool_name as string || log.content.split("\n")[0].slice(0, 60))
    : log.type === "done"
      ? `${log.metadata?.cost_usd != null ? `$${(log.metadata.cost_usd as number).toFixed(2)}` : ""} ${log.metadata?.num_turns ? `${log.metadata.num_turns} turns` : ""}`.trim() || "done"
      : log.content.length > 80
        ? log.content.slice(0, 80) + "…"
        : log.content;

  return (
    <div className="flex gap-3 group">
      {/* Timeline dot + line */}
      <div className="flex flex-col items-center">
        <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${style.color.replace("text-", "bg-")}`} />
        <div className="w-px flex-1 bg-[var(--border)]" />
      </div>

      {/* Content */}
      <div className="flex-1 pb-3 min-w-0">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-left w-full"
        >
          <span className={`text-[11px] font-mono font-medium ${style.color}`}>{style.label}</span>
          <span className="text-xs truncate" style={{ color: "var(--text-secondary)" }}>{preview}</span>
        </button>
        {expanded && (
          <pre className="mt-1.5 text-xs font-mono whitespace-pre-wrap break-all p-2 rounded overflow-auto max-h-60"
               style={{ background: "var(--bg-primary)", color: "var(--text-primary)" }}>
            {log.content}
            {Object.keys(log.metadata).length > 0 && (
              <>
                {"\n\n"}--- metadata ---{"\n"}
                {JSON.stringify(log.metadata, null, 2)}
              </>
            )}
          </pre>
        )}
      </div>
    </div>
  );
}

export function LogTimeline({ taskId, isRunning }: { taskId: string; isRunning: boolean }) {
  const { taskLogs, refreshTaskLogs } = useAdminStore();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isRunning) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }

    intervalRef.current = setInterval(() => {
      const maxSeq = taskLogs.length > 0 ? taskLogs[taskLogs.length - 1].seq : 0;
      refreshTaskLogs(taskId, maxSeq);
    }, 2000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [taskId, isRunning, taskLogs, refreshTaskLogs]);

  if (taskLogs.length === 0) {
    return (
      <div className="text-sm py-4" style={{ color: "var(--text-secondary)" }}>
        {isRunning ? "Waiting for logs..." : "No execution logs"}
      </div>
    );
  }

  return (
    <div className="py-2">
      {taskLogs.map((log) => (
        <LogEntry key={`${taskId}-${log.seq}`} log={log} />
      ))}
      {isRunning && (
        <div className="flex gap-3 items-center">
          <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
          <span className="text-xs text-blue-400">Running...</span>
        </div>
      )}
    </div>
  );
}
