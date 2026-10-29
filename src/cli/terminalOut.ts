// Line output that keeps an open prompt usable: event lines go above it, and the full prompt text is not repeated.
export const REPROMPT_MS = 5000;
export const PROMPT_MARKER = '> ';

export function createTerminalOut(write: (s: string) => void, now: () => number = Date.now) {
  let openPrompt: string | null = null;
  let shownAt = 0;
  return {
    out(line: string): void {
      if (openPrompt === null) { write(`${line}\n`); return; }
      // Only the short marker returns after an event line; the full prompt returns after a quiet 5 s.
      const full = now() - shownAt >= REPROMPT_MS;
      if (full) shownAt = now();
      write(`\n${line}\n${full ? openPrompt : PROMPT_MARKER}`);
    },
    showPrompt(text: string): void { openPrompt = text; shownAt = now(); write(text); },
    promptDone(): void { openPrompt = null; },
  };
}
