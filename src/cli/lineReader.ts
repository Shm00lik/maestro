// Reads stdin one line at a time, on demand. Works with a terminal and with a pipe (tests pipe scripted answers):
// lines that arrive before anyone asks are queued, and a read can be cancelled without losing the next line.
import { createInterface, type Interface } from 'node:readline';
import type { Readable } from 'node:stream';

export const CANCELLED: unique symbol = Symbol('cancelled');
export type ReadResult = string | null | typeof CANCELLED;

export class LineReader {
  private rl: Interface;
  private queue: string[] = [];
  private ended = false;
  private waiter: ((v: ReadResult) => void) | null = null;

  constructor(input: Readable) {
    // terminal: false, so Ctrl+C reaches the process as SIGINT instead of being swallowed by readline.
    this.rl = createInterface({ input, terminal: false, crlfDelay: Infinity });
    this.rl.on('line', raw => {
      const line = raw.replace(/^﻿/, ''); // Windows PowerShell pipes start with a BOM
      if (this.waiter) { const w = this.waiter; this.waiter = null; w(line); }
      else this.queue.push(line);
    });
    this.rl.on('close', () => {
      this.ended = true;
      if (this.waiter) { const w = this.waiter; this.waiter = null; w(null); }
    });
  }

  /** The next line (without its line ending), null once stdin has ended, or CANCELLED when `cancel` fires first. */
  read(cancel?: Promise<void>): Promise<ReadResult> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.ended) return Promise.resolve(null);
    if (this.waiter) throw new Error('LineReader: only one read at a time');
    return new Promise<ReadResult>(res => {
      this.waiter = res;
      cancel?.then(() => {
        if (this.waiter === res) { this.waiter = null; res(CANCELLED); }
      });
    });
  }

  close(): void { this.rl.close(); }
}
