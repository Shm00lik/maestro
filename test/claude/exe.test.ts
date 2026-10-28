import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { ClaudeNotFound, resolveClaudeCommand, resolveClaudeExe } from '../../src/claude/exe.js';

const SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
].join('\r\n');
const CMD = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd';
const EXPECTED = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';

const saved = { exe: process.env.MAESTRO_CLAUDE_EXE, args: process.env.MAESTRO_CLAUDE_EXE_ARGS };
afterEach(() => {
  for (const [k, v] of [['MAESTRO_CLAUDE_EXE', saved.exe], ['MAESTRO_CLAUDE_EXE_ARGS', saved.args]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe('resolveClaudeExe', () => {
  it('reads the exe path from the claude.cmd shim with %dp0% substituted', () => {
    delete process.env.MAESTRO_CLAUDE_EXE;
    const exe = resolveClaudeExe({
      whereOutput: c => (c === 'claude' ? ['C:\\Users\\me\\AppData\\Roaming\\npm\\claude', CMD] : []),
      readFile: p => { expect(p).toBe(CMD); return SHIM; },
      exists: p => p === EXPECTED,
    });
    expect(exe).toBe(EXPECTED);
  });

  it('falls back to where claude.exe', () => {
    delete process.env.MAESTRO_CLAUDE_EXE;
    const direct = 'D:\\tools\\claude.exe';
    const exe = resolveClaudeExe({
      whereOutput: c => (c === 'claude.exe' ? [direct] : []),
      readFile: () => { throw new Error('no read'); },
      exists: p => p === direct,
    });
    expect(exe).toBe(direct);
  });

  it('throws ClaudeNotFound with an install hint', () => {
    delete process.env.MAESTRO_CLAUDE_EXE;
    const call = (): string => resolveClaudeExe({ whereOutput: () => [], exists: () => false });
    expect(call).toThrow(ClaudeNotFound);
    expect(call).toThrow(/npm i -g @anthropic-ai\/claude-code/);
  });

  it('honours the override', () => {
    process.env.MAESTRO_CLAUDE_EXE = 'C:\\env\\claude.exe';
    const unused = (): string[] => { throw new Error('unused'); };
    expect(resolveClaudeExe({ override: 'C:\\x\\claude.exe', whereOutput: unused })).toBe('C:\\x\\claude.exe');
    expect(resolveClaudeExe({ whereOutput: unused })).toBe('C:\\env\\claude.exe');
  });

  const hasClaude = process.platform === 'win32' && spawnSync('where', ['claude'], { windowsHide: true }).status === 0;
  it.runIf(hasClaude)('resolves an existing claude.exe on this machine', () => {
    delete process.env.MAESTRO_CLAUDE_EXE;
    expect(resolveClaudeExe()).toMatch(/claude\.exe$/i);
  });
});

describe('resolveClaudeCommand', () => {
  it('parses MAESTRO_CLAUDE_EXE_ARGS and defaults to []', () => {
    process.env.MAESTRO_CLAUDE_EXE = process.execPath;
    delete process.env.MAESTRO_CLAUDE_EXE_ARGS;
    expect(resolveClaudeCommand()).toEqual({ exe: process.execPath, prefixArgs: [] });
    process.env.MAESTRO_CLAUDE_EXE_ARGS = '["--import","tsx","a.ts"]';
    expect(resolveClaudeCommand().prefixArgs).toEqual(['--import', 'tsx', 'a.ts']);
  });

  it('throws a clear error on invalid args JSON', () => {
    process.env.MAESTRO_CLAUDE_EXE = process.execPath;
    process.env.MAESTRO_CLAUDE_EXE_ARGS = 'not json';
    expect(() => resolveClaudeCommand()).toThrow(/MAESTRO_CLAUDE_EXE_ARGS/);
    process.env.MAESTRO_CLAUDE_EXE_ARGS = '{"a":1}';
    expect(() => resolveClaudeCommand()).toThrow(/JSON array/);
  });
});
