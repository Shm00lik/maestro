/** Key used for the unique project path: lower-case, forward slashes, no trailing slash. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}
