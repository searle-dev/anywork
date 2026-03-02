"use client";

import { useEffect } from "react";
import Link from "next/link";
import { ArrowLeft, LayoutDashboard } from "lucide-react";
import { useAdminStore } from "@/stores/adminStore";
import { SessionList } from "@/components/admin/SessionList";
import { TaskList } from "@/components/admin/TaskList";
import { TaskDetail } from "@/components/admin/TaskDetail";

export default function AdminPage() {
  const loadSessions = useAdminStore((s) => s.loadSessions);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

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
