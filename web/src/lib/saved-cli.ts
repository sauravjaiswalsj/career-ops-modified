export const CONFIG_KEY = "career-ops:config";

/**
 * Broadcast that the saved CLI changed.
 *
 * The `storage` event fires only in OTHER tabs, never in the one that wrote —
 * so a component mounted in the layout (the assistant console) kept the value
 * it read at mount and reported "no CLI configured" while Config plainly showed
 * one selected. Anything that persists a CLI must announce it in-tab too.
 */
export const CLI_CHANGED_EVENT = "career-ops:cli-changed";

export function announceCliChange() {
  try {
    window.dispatchEvent(new CustomEvent(CLI_CHANGED_EVENT));
  } catch {
    /* SSR / no window */
  }
}

export function readSavedCliId(): string | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const id = raw ? JSON.parse(raw).cliId : "";
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

export function persistCliId(cliId: string) {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const prev = raw ? JSON.parse(raw) : {};
    localStorage.setItem(
      CONFIG_KEY,
      JSON.stringify({ ...prev, mode: prev.mode || "cli", cliId }),
    );
    announceCliChange();
  } catch {
    /* quota / private mode */
  }
}

export function pickSoleInstalled(
  clis: { id: string; installed?: boolean }[] | undefined,
): string | null {
  const installed = (clis || []).filter((c) => c.installed);
  return installed.length === 1 ? installed[0].id : null;
}

/** Saved Config cliId, or the only installed CLI (and persist that pick). */
export async function resolveCliId(): Promise<string | null> {
  const saved = readSavedCliId();
  if (saved) return saved;
  try {
    const r = await fetch("/api/clis");
    const d = (await r.json()) as { clis?: { id: string; installed?: boolean }[] };
    const sole = pickSoleInstalled(d.clis);
    if (!sole) return null;
    persistCliId(sole);
    return sole;
  } catch {
    return null;
  }
}
