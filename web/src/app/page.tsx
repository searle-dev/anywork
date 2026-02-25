"use client";

import { useEffect } from "react";
import { useChatStore } from "@/stores/chatStore";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { fetchSessions } from "@/lib/api";

export default function Home() {
  const { setSessions } = useChatStore();

  // Load sessions on mount
  useEffect(() => {
    fetchSessions()
      .then((data) => setSessions(data.sessions || []))
      .catch(console.error);
  }, [setSessions]);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <ChatPanel />
    </div>
  );
}
