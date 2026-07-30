// Agent skill folders: the immediate subdirectories of `skillsRoot`, each individually
// mountable into the container's skills dir.

import { join } from "jsr:@std/path@^1";
import { pathIsExpressible } from "./scan.ts";

export interface Skill {
  name: string;
  /** Absolute host path. */
  path: string;
  warnings: string[];
}

/** Immediate subdirectories of `skillsRoot`, sorted, dot-dirs skipped. */
export async function listSkills(skillsRoot: string): Promise<Skill[]> {
  const out: Skill[] = [];
  try {
    for await (const entry of Deno.readDir(skillsRoot)) {
      if (entry.name.startsWith(".")) continue;
      const path = join(skillsRoot, entry.name);
      if (!entry.isDirectory) {
        if (!entry.isSymlink) continue;
        const stat = await Deno.stat(path).catch(() => null);
        if (!stat?.isDirectory) continue;
      }
      const warnings: string[] = [];
      if (!pathIsExpressible(path)) {
        warnings.push("path contains a comma or equals sign; cannot be expressed as a mount string");
      }
      out.push({ name: entry.name, path, warnings });
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Enabled skills, in `listSkills` order, dropping ones that cannot be expressed. */
export function enabledSkills(skills: Skill[], enabled: Set<string>): Skill[] {
  return skills.filter((s) => enabled.has(s.name) && s.warnings.length === 0);
}
