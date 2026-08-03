// Test scaffolding. Nothing here reads or writes anything inside this repo
// except the hand-written JSONC fixtures under `tests/fixtures/`.

/** Read a hand-written JSONC fixture. */
export async function fixture(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(`./fixtures/${name}`, import.meta.url));
}

/** Run `fn` with a fresh temp dir, removing it afterwards no matter what. */
export async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "devc-test-" });
  try {
    return await fn(await Deno.realPath(dir));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}
