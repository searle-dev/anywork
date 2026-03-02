"use client";

import { create } from "zustand";
import type { AdminSession, AdminTask, TaskLog, WorkersOverview } from "@/lib/adminTypes";
import {
  fetchAdminSessions,
  fetchSessionTasks,
  fetchTaskDetail,
  fetchTaskLogs,
  cancelTask as apiCancelTask,
  fetchWorkers,
} from "@/lib/adminApi";

interface AdminState {
  sessions: AdminSession[];
  selectedSessionId: string | null;
  tasks: AdminTask[];
  selectedTaskId: string | null;
  taskDetail: AdminTask | null;
  taskLogs: TaskLog[];
  workersOverview: WorkersOverview | null;
  loadingSessions: boolean;
  loadingTasks: boolean;
  loadingDetail: boolean;

  loadSessions: () => Promise<void>;
  loadWorkers: () => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  selectTask: (id: string) => Promise<void>;
  refreshTaskLogs: (taskId: string, afterSeq?: number) => Promise<void>;
  cancelTask: (taskId: string) => Promise<void>;
}

export const useAdminStore = create<AdminState>((set, get) => ({
  sessions: [],
  selectedSessionId: null,
  tasks: [],
  selectedTaskId: null,
  taskDetail: null,
  taskLogs: [],
  workersOverview: null,
  loadingSessions: false,
  loadingTasks: false,
  loadingDetail: false,

  loadSessions: async () => {
    set({ loadingSessions: true });
    try {
      const sessions = await fetchAdminSessions();
      set({ sessions });
    } finally {
      set({ loadingSessions: false });
    }
  },

  loadWorkers: async () => {
    try {
      const data = await fetchWorkers();
      set({ workersOverview: data });
    } catch {
      // Workers API may not be available
    }
  },

  selectSession: async (id) => {
    set({ selectedSessionId: id, tasks: [], selectedTaskId: null, taskDetail: null, taskLogs: [], loadingTasks: true });
    try {
      const tasks = await fetchSessionTasks(id);
      set({ tasks });
    } finally {
      set({ loadingTasks: false });
    }
  },

  selectTask: async (id) => {
    set({ selectedTaskId: id, taskDetail: null, taskLogs: [], loadingDetail: true });
    try {
      const [detail, logsData] = await Promise.all([
        fetchTaskDetail(id),
        fetchTaskLogs(id),
      ]);
      set({ taskDetail: detail, taskLogs: logsData.logs });
    } finally {
      set({ loadingDetail: false });
    }
  },

  refreshTaskLogs: async (taskId, afterSeq = 0) => {
    const { taskLogs } = get();
    const data = await fetchTaskLogs(taskId, afterSeq);
    if (data.logs.length > 0) {
      set({ taskLogs: [...taskLogs, ...data.logs] });
    }
  },

  cancelTask: async (taskId) => {
    await apiCancelTask(taskId);
    const { taskDetail } = get();
    if (taskDetail?.id === taskId) {
      set({ taskDetail: { ...taskDetail, status: "canceled" } });
    }
  },
}));
