// Normalizes a path to forward-slash form and, on Windows, converts
// MSYS/Git Bash style paths (/c/foo) to native Windows paths (C:/foo).
export function normalizePath(p: string): string {
  const withSlashes = p.replace(/\\/g, '/');
  if (Deno.build.os !== 'windows') return withSlashes;
  const match = withSlashes.match(/^\/([a-zA-Z])(\/.*|$)/);
  if (!match) return withSlashes;
  return `${match[1].toUpperCase()}:${match[2] || '/'}`;
}
