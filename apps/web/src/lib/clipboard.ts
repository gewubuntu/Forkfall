/** Copy to the clipboard; where that's blocked (some in-app browsers), show the text to copy by hand instead. */
export async function copyText(text: string, label = 'Copy this deck code:'): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    window.prompt(label, text);
    return false;
  }
}
