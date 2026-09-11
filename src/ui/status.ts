/** The four sync states surfaced in both the desktop status bar and the (mobile-visible) ribbon icon. */
export type SyncStatus = "idle" | "syncing" | "live" | "offline";

/** Presentation for each state: a lucide icon name, a CSS state class, and a human label. Extracted so
 *  it's unit-testable and shared by both surfaces — a missing entry would crash `setIcon(el, undefined)`. */
export const STATUS_META: Record<SyncStatus, { icon: string; cls: string; label: string }> = {
	idle: { icon: "cloud-off", cls: "is-off", label: "not connected" },
	syncing: { icon: "refresh-cw", cls: "is-sync", label: "syncing…" },
	live: { icon: "check", cls: "is-live", label: "synced · live" },
	offline: { icon: "cloud-off", cls: "is-off", label: "offline · reconnecting…" },
};
