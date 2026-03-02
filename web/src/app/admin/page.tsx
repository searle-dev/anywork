"use client";

import { useEffect } from "react";
import Link from "next/link";
import { ArrowLeft, LayoutDashboard, Server } from "lucide-react";
import { useAdminStore } from "@/stores/adminStore";
import { SessionList } from "@/components/admin/SessionList";
import { TaskList } from "@/components/admin/TaskList";
import { TaskDetail } from "@/components/admin/TaskDetail";

export default function AdminPage() {
  const loadSessions = useAdminStore((s) => s.loadSessions);
  const loadWorkers = useAdminStore((s) => s.loadWorkers);
  const workersOverview = useAdminStore((s) => s.workersOverview);

  useEffect(() => {
    loadSessions();
    loadWorkers();
  }, [loadSessions, loadWorkers]);

  return (
    <div className="h-screen flex flex-col" style={{ background: "var(--bg-primary)" }}>
      {/* Top nav */}
      <header className="flex items-center gap-3 px-4 h-12 flex-shrink-0" style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-secondary)" }}>
        <Link href="/" className="flex items-center gap-2 text-sm hover:opacity-80 transition-opacity" style={{ color: "var(--text-secondary)" }}>
          <ArrowLeft size={16} />
          Back
        </Link>
        <div className="flex items-center gap-2 ml-2">
          <LayoutDashboard size={16} className="text-blue-500" />
          <span className="font-semibold text-sm">AnyWork Admin</span>
        </div>
        {workersOverview && (
          <div className="ml-auto flex items-center gap-2 text-xs" style={{ color: "var(--text-secondary)" }}>
            <Server size={13} />
            <span>Driver: <strong className="text-[var(--text-primary)]">{workersOverview.driver}</strong></span>
            <span>&middot;</span>
            <span>Workers: <strong className="text-[var(--text-primary)]">{workersOverview.workers.length}</strong></span>
            {workersOverview.workers.length > 0 && (
              <>
                <span>&middot;</span>
                <span className={workersOverview.workers.every(w => w.healthy) ? "text-green-400" : "text-yellow-400"}>
                  {workersOverview.workers.filter(w => w.healthy).length}/{workersOverview.workers.length} healthy
                </span>
              </>
            )}
          </div>
        )}
      </header>

      {/* Three-panel layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sessions panel */}
        <div className="flex-shrink-0 overflow-hidden" style={{ width: 280, borderRight: "1px solid var(--border)", background: "var(--bg-secondary)" }}>
          <SessionList />
        </div>

        {/* Tasks panel */}
        <div className="flex-shrink-0 overflow-hidden" style={{ width: 360, borderRight: "1px solid var(--border)" }}>
          <TaskList />
        </div>

        {/* Detail panel */}
        <div className="flex-1 overflow-hidden" style={{ background: "var(--bg-secondary)" }}>
          <TaskDetail />
        </div>
      </div>
    </div>
  );
}
