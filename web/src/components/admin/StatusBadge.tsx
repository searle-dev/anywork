"use client";

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string; animate?: boolean }> = {
  pending:        { bg: "bg-yellow-500/15", text: "text-yellow-400", label: "pending" },
  running:        { bg: "bg-blue-500/15",   text: "text-blue-400",   label: "running", animate: true },
  input_required: { bg: "bg-purple-500/15", text: "text-purple-400", label: "input" },
  completed:      { bg: "bg-green-500/15",  text: "text-green-400",  label: "completed" },
  failed:         { bg: "bg-red-500/15",    text: "text-red-400",    label: "failed" },
  canceled:       { bg: "bg-gray-500/15",   text: "text-gray-400",   label: "canceled" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.pending;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${s.bg} ${s.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.text.replace("text-", "bg-")} ${s.animate ? "animate-pulse" : ""}`} />
      {s.label}
    </span>
  );
}

const CHANNEL_STYLES: Record<string, { bg: string; text: string }> = {
  webchat: { bg: "bg-blue-500/15", text: "text-blue-400" },
  github:  { bg: "bg-purple-500/15", text: "text-purple-400" },
  slack:   { bg: "bg-green-500/15", text: "text-green-400" },
};

export function ChannelBadge({ type }: { type: string }) {
  const s = CHANNEL_STYLES[type] ?? { bg: "bg-gray-500/15", text: "text-gray-400" };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${s.bg} ${s.text}`}>
      {type}
    </span>
  );
}
