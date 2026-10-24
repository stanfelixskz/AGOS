/* Light / dark theme. "system" follows the device setting. */

const KEY = "agos.theme";

export function getStoredTheme() {
  try {
    const value = globalThis.localStorage?.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function effectiveTheme(stored = getStoredTheme()) {
  if (stored === "light" || stored === "dark") return stored;
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(stored = getStoredTheme()) {
  const root = document.documentElement;
  if (stored === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", stored);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", effectiveTheme(stored) === "dark" ? "#0a111e" : "#f5f7fa");
  document.dispatchEvent(new CustomEvent("agos:theme", { detail: { theme: effectiveTheme(stored) } }));
}

export function toggleTheme() {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  try {
    globalThis.localStorage?.setItem(KEY, next);
  } catch {
    /* ignore blocked storage */
  }
  applyTheme(next);
  return next;
}

export function watchSystemTheme() {
  const query = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
  query?.addEventListener?.("change", () => {
    if (getStoredTheme() === "system") applyTheme("system");
  });
}
