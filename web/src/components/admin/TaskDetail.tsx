"use client";

import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check, XCircle, Server, Activity } from "lucide-react";
import { useAdminStore } from "@/stores/adminStore";
import { StatusBadge } from "./StatusBadge";
import { LogTimeline } from "./LogTimeline";

function formatTime(unix: number | null): string {
  if (unix == null) return "-";
  return new Date(unix * 1000).toLocaleString();
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button onClick={handleCopy} className="p-1 rounded hover:bg-[var(--bg-tertiary)] transition-colors" style={{ color: "var(--text-secondary)" }}>
      {copied ? <Check size={13} className="text-green-400" /> : <Copy size={13} />}
    </button>
  );
}

function getAccessCommand(driver: string, workerId: string, sessionId: string): string {
  if (driver === "k8s") {
    return `kubectl exec -it ${workerId} -n anywork -- /bin/bash`;
  }
  if (driver === "docker") {
    return `docker exec -it anywork-worker-${sessionId.slice(0, 8)} /bin/bash`;
  }
  // static
  return `docker exec -it anywork-worker-1 /bin/bash`;
}

const DRIVER_LABELS: Record<string, string> = {
  static: "Static (docker-compose)",
  docker: "Docker (per-session)",
  k8s: "Kubernetes Pod",
};

export function TaskDetail() {
  const { taskDetail, selectedTaskId, loadingDetail, cancelTask, workersOverview, loadWorkers } = useAdminStore();

  useEffect(() => {
    if (!workersOverview) loadWorkers();
  }, [workersOverview, loadWorkers]);

  if (!selectedTaskId) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: "var(--text-secondary)" }}>
        <span className="text-sm">Select a task to view details</span>
      </div>
    );
  }

  if (loadingDetail || !taskDetail) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: "var(--text-secondary)" }}>
        <span className="text-sm">Loading...</span>
      </div>
    );
  }

  const t = taskDetail;
  const isRunning = t.status === "running" || t.status === "pending" || t.status === "input_required";
  const driverType = workersOverview?.driver ?? "unknown";
  const matchedWorker = workersOverview?.workers.find(
    (w) => w.containerId === t.workerId || w.sessionId === t.sessionId,
  );

  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      {/* Header */}
      <div className="mb-4">
        <div className="flex items-center gap-3 mb-3">
          <StatusBadge status={t.status} />
          {isRunning && (
            <button
              onClick={() => cancelTask(t.id)}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <XCircle size={13} />
              Cancel
            </button>
          )}
        </div>

        {/* Stats cards */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          {[
            { label: "Cost", value: t.costUsd != null ? `$${t.costUsd.toFixed(2)}` : "-" },
            { label: "Turns", value: t.numTurns?.toString() ?? "-" },
            { label: "Duration", value: formatDuration(t.durationMs) },
          ].map((c) => (
            <div key={c.label} className="rounded-lg p-2 text-center" style={{ background: "var(--bg-primary)", border: "1px solid var(--border)" }}>
              <div className="text-[10px] uppercase tracking-wide mb-0.5" style={{ color: "var(--text-secondary)" }}>{c.label}</div>
              <div className="text-sm font-medium">{c.value}</div>
            </div>
          ))}
        </div>

        {/* Timeline */}
        <div className="flex items-center gap-4 text-[11px]" style={{ color: "var(--text-secondary)" }}>
          <span>Created: {formatTime(t.createdAt)}</span>
          <span>Started: {formatTime(t.startedAt)}</span>
          <span>Finished: {formatTime(t.finishedAt)}</span>
        </div>
      </div>

      {/* Worker / Scheduler Info */}
      <Section title="Worker">
        <div className="rounded-lg p-3" style={{ background: "var(--bg-primary)", border: "1px solid var(--border)" }}>
          {/* Driver + Worker ID row */}
          <div className="flex items-center gap-2 mb-2">
            <Server size={14} className="text-blue-400 flex-shrink-0" />
            <span className="text-xs font-medium">{DRIVER_LABELS[driverType] ?? driverType}</span>
            {t.workerId && (
              <code className="text-[11px] px-1.5 py-0.5 rounded ml-auto" style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>
                {t.workerId}
              </code>
            )}
          </div>

          {/* URL + Health */}
          {matchedWorker && (
            <div className="flex items-center gap-2 mb-2 text-xs" style={{ color: "var(--text-secondary)" }}>
              <span className="font-mono">{matchedWorker.url}</span>
              <span className="ml-auto flex items-center gap-1">
                <Activity size={11} />
                {matchedWorker.healthy === true && <span className="text-green-400">healthy</span>}
                {matchedWorker.healthy === false && <span className="text-red-400">unhealthy</span>}
                {matchedWorker.healthy === null && <span>unknown</span>}
              </span>
            </div>
          )}

          {!matchedWorker && t.workerId && (
            <div className="text-xs mb-2" style={{ color: "var(--text-secondary)" }}>
              Worker no longer active (may have been released)
            </div>
          )}

          {/* K8s details */}
          {driverType === "k8s" && workersOverview?.k8s && (
            <div className="flex items-center gap-3 text-[11px] mb-2" style={{ color: "var(--text-secondary)" }}>
              <span>ns: {workersOverview.k8s.namespace}</span>
              <span>storage: {workersOverview.k8s.workspaceStorage}</span>
              <span>idle TTL: {workersOverview.k8s.idleTtlSeconds}s</span>
            </div>
          )}

          {/* Access command */}
          {t.workerId && (
            <div className="flex items-center gap-2 p-2 rounded font-mono text-xs mt-1" style={{ background: "var(--bg-tertiary)" }}>
              <code className="flex-1 truncate">{getAccessCommand(driverType, t.workerId, t.sessionId)}</code>
              <CopyButton text={getAccessCommand(driverType, t.workerId, t.sessionId)} />
            </div>
          )}
        </div>
      </Section>

      {/* Message */}
      <Section title="Message">
        <p className="text-sm whitespace-pre-wrap">{t.message}</p>
      </Section>

      {/* Result */}
      {t.result && (
        <Section title="Result">
          <div className="markdown-content text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{t.result}</ReactMarkdown>
          </div>
        </Section>
      )}

      {/* Error */}
      {t.error && (
        <Section title="Error">
          <div className="p-3 rounded-lg text-sm text-red-400" style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}>
            <pre className="whitespace-pre-wrap break-all font-mono text-xs">{t.error}</pre>
          </div>
        </Section>
      )}

      {/* Execution Log */}
      <Section title="Execution Log">
        <LogTimeline taskId={t.id} isRunning={isRunning} />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="text-xs font-medium uppercase tracking-wide mb-2" style={{ color: "var(--text-secondary)" }}>
        {title}
      </div>
      {children}
    </div>
  );
}
