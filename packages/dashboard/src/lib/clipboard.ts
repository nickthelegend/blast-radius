/**
 * Copy text, and report honestly whether it worked.
 *
 * `navigator.clipboard.writeText` rejects for reasons the page cannot control —
 * the document is not focused, the permission is denied, the context is not
 * secure. Firing it with `void` did two bad things at once: the rejection
 * surfaced as an uncaught promise error in the console, and the caller set its
 * "copied" state anyway, so the interface claimed success on a copy that had
 * not happened.
 *
 * The fallback is the old `execCommand` path, which still works in exactly the
 * cases the async API refuses, and is the difference between "copy is broken"
 * and "copy works" on a page that has just been clicked into.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the synchronous path */
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    // Off-screen rather than hidden: a display:none element cannot be selected.
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.setAttribute('readonly', '');
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
