import { truncateToWidth, visibleWidth } from "./runtime/tui.js";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Use the exact width implementation used by HengFlow's TUI renderer. */
export function displayWidth(text: string): number {
  return visibleWidth(text);
}

export function truncateDisplay(text: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(text, width, "…");
}

/** Final component boundary guard: no custom TUI line may exceed render(width). */
export function fitDisplayLines(lines: readonly string[], width: number): string[] {
  return lines.map((line) => truncateDisplay(line, Math.max(0, width)));
}

export function padDisplay(text: string, width: number): string {
  const compact = truncateDisplay(text, width);
  return `${compact}${" ".repeat(Math.max(0, width - displayWidth(compact)))}`;
}

export function alignDisplay(left: string, right: string, width: number, minimumGap = 2): string {
  if (width <= 0) return "";
  const rightWidth = displayWidth(right);
  if (rightWidth + minimumGap >= width) return truncateDisplay(left, width);
  const compactLeft = truncateDisplay(left, width - rightWidth - minimumGap);
  return `${compactLeft}${" ".repeat(Math.max(minimumGap, width - displayWidth(compactLeft) - rightWidth))}${right}`;
}
