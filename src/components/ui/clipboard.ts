"use client";

/**
 * Copy text to the clipboard. `navigator.clipboard` only exists on secure origins (HTTPS or
 * localhost), so over plain HTTP this falls back to selecting a hidden textarea and
 * `document.execCommand("copy")`. Resolves false when neither works.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied or unavailable: try the fallback.
    }
  }
  const previous = document.activeElement as HTMLElement | null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  // Inside an open dialog, so its focus trap does not pull focus back before the copy.
  (previous?.closest("[role=dialog],[role=alertdialog]") ?? document.body).appendChild(area);
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    previous?.focus?.();
  }
}
