import { describe, expect, it } from 'vitest';
import { createTerminalOut } from '../../src/cli/terminalOut.js';

describe('createTerminalOut', () => {
  it('prints plain lines when no prompt is open', () => {
    const w: string[] = [];
    const t = createTerminalOut(s => w.push(s));
    t.out('hi');
    expect(w.join('')).toBe('hi\n');
  });

  it('puts events above an open prompt and repeats only the short marker', () => {
    const w: string[] = [];
    let clock = 1000;
    const t = createTerminalOut(s => w.push(s), () => clock);
    t.showPrompt('Allow? [y] once: ');
    clock += 100; t.out('one');
    clock += 100; t.out('two');
    const text = w.join('');
    expect(text).toBe('Allow? [y] once: \none\n> \ntwo\n> ');
    expect(text.match(/Allow\?/g)).toHaveLength(1);
  });

  it('shows the full prompt again after 5 s, and stops once the prompt is done', () => {
    const w: string[] = [];
    let clock = 0;
    const t = createTerminalOut(s => w.push(s), () => clock);
    t.showPrompt('Q: ');
    clock = 6000; t.out('late');
    expect(w.join('')).toBe('Q: \nlate\nQ: ');
    t.promptDone();
    t.out('after');
    expect(w.join('').endsWith('after\n')).toBe(true);
  });
});
