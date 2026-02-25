"use client";
import { useState, useEffect } from "react";
import { X, Save } from "lucide-react";
import { getWorkspaceFile, updateWorkspaceFile } from "@/lib/api";

type FileTab = "soul" | "agents";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function WorkspaceEditor({ open, onClose }: Props) {
  const [tab, setTab] = useState<FileTab>("soul");
  const [contents, setContents] = useState<Record<FileTab, string>>({ soul: "", agents: "" });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    getWorkspaceFile("soul").then((c) => setContents((p) => ({ ...p, soul: c })));
    getWorkspaceFile("agents").then((c) => setContents((p) => ({ ...p, agents: c })));
  }, [open]);

  const handleSave = async () => {
    setSaving(true);
    await updateWorkspaceFile(tab, contents[tab]);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="w-full max-w-2xl mx-4 rounded-xl flex flex-col"
        style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", maxHeight: "80vh" }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <span className="font-semibold">Workspace Settings</span>
          <button onClick={onClose}><X size={18} /></button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-5 pt-4">
          {(["soul", "agents"] as FileTab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-md text-sm transition-colors ${
                tab === t ? "bg-[var(--bg-tertiary)]" : "hover:bg-[var(--bg-tertiary)]"
              }`}
            >
              {t === "soul" ? "SOUL.md" : "AGENTS.md"}
            </button>
          ))}
        </div>

        {/* Editor */}
        <div className="flex-1 px-5 py-3 overflow-auto">
          <textarea
            className="w-full h-72 p-3 rounded-lg font-mono text-sm resize-none outline-none"
            style={{
              background: "var(--bg-primary)",
              border: "1px solid var(--border)",
              color: "var(--text-primary)",
            }}
            value={contents[tab]}
            onChange={(e) => setContents((p) => ({ ...p, [tab]: e.target.value }))}
            spellCheck={false}
          />
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
            Changes apply to new conversations immediately.
          </span>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-60"
          >
            <Save size={14} />
            {saving ? "Saving..." : saved ? "Saved!" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
