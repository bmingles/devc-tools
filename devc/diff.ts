// A minimal unified diff, for `--dry-run`. The files are small (tens of lines), so a plain
// O(n·m) LCS table is more than fast enough and keeps the output predictable.

interface Op {
  kind: " " | "-" | "+";
  text: string;
}

function lines(src: string): string[] {
  const out = src.split("\n");
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

function ops(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: " ", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "-", text: a[i] });
      i++;
    } else {
      out.push({ kind: "+", text: b[j] });
      j++;
    }
  }
  for (; i < n; i++) out.push({ kind: "-", text: a[i] });
  for (; j < m; j++) out.push({ kind: "+", text: b[j] });
  return out;
}

/** Unified diff with 3 lines of context; empty string when the inputs are identical. */
export function unifiedDiff(oldSrc: string, newSrc: string, path: string, context = 3): string {
  if (oldSrc === newSrc) return "";
  const a = lines(oldSrc);
  const b = lines(newSrc);
  const all = ops(a, b);

  // Group changed ops into hunks, padded with up to `context` unchanged lines either side.
  const changed = all.map((o) => o.kind !== " ");
  const keep = new Array(all.length).fill(false);
  for (let i = 0; i < all.length; i++) {
    if (!changed[i]) continue;
    for (let k = Math.max(0, i - context); k <= Math.min(all.length - 1, i + context); k++) {
      keep[k] = true;
    }
  }

  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let oldLine = 1;
  let newLine = 1;
  let i = 0;
  while (i < all.length) {
    if (!keep[i]) {
      if (all[i].kind !== "+") oldLine++;
      if (all[i].kind !== "-") newLine++;
      i++;
      continue;
    }
    const startOld = oldLine;
    const startNew = newLine;
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    while (i < all.length && keep[i]) {
      const op = all[i];
      body.push(`${op.kind}${op.text}`);
      if (op.kind !== "+") {
        oldLine++;
        oldCount++;
      }
      if (op.kind !== "-") {
        newLine++;
        newCount++;
      }
      i++;
    }
    out.push(`@@ -${startOld},${oldCount} +${startNew},${newCount} @@`);
    out.push(...body);
  }
  return out.join("\n") + "\n";
}
