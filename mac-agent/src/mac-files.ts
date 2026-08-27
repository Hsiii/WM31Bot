import { readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

const MAX_RESULTS = 20;
const MAX_VISITED_ENTRIES = 25_000;

export type MacFileMatch = {
  path: string;
  filename: string;
  size: number;
  modifiedAt: string;
};

function inside(root: string, candidate: string) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

function searchTerms(query: string) {
  return query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
}

export class MacFileSearch {
  private constructor(private readonly roots: string[]) {}

  static async create(configuredRoots: string[]) {
    const roots = (
      await Promise.all(
        configuredRoots.map((root) =>
          realpath(resolve(root)).catch(() => undefined),
        ),
      )
    ).filter((root): root is string => Boolean(root));
    if (!roots.length)
      throw new Error("No configured file-search root exists.");
    return new MacFileSearch([...new Set(roots)]);
  }

  allowedRoots() {
    return [...this.roots];
  }

  async search({
    query,
    root,
    extension,
    limit = 10,
  }: {
    query: string;
    root?: string;
    extension?: string;
    limit?: number;
  }): Promise<MacFileMatch[]> {
    const terms = searchTerms(query);
    if (!terms.length) throw new Error("Search query is required.");
    const maximum = Math.min(Math.max(Math.trunc(limit), 1), MAX_RESULTS);
    const selectedRoots = root
      ? this.roots.filter((allowedRoot) => allowedRoot === resolve(root))
      : this.roots;
    if (!selectedRoots.length) throw new Error("Search root is not allowed.");
    const normalizedExtension = extension
      ? `.${extension.replace(/^\./u, "").toLocaleLowerCase()}`
      : undefined;
    const matches: MacFileMatch[] = [];
    const directories = [...selectedRoots];
    let visited = 0;

    while (directories.length && matches.length < maximum) {
      const directory = directories.shift()!;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        if (++visited > MAX_VISITED_ENTRIES || matches.length >= maximum) {
          return matches;
        }
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (!selectedRoots.some((allowedRoot) => inside(allowedRoot, path))) {
          continue;
        }
        if (entry.isDirectory()) {
          directories.push(path);
          continue;
        }
        if (!entry.isFile()) continue;
        const filename = entry.name.toLocaleLowerCase();
        if (!terms.every((term) => filename.includes(term))) continue;
        if (
          normalizedExtension &&
          extname(filename).toLocaleLowerCase() !== normalizedExtension
        ) {
          continue;
        }
        const info = await stat(path);
        matches.push({
          path,
          filename: entry.name,
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        });
      }
    }

    return matches;
  }
}

export const macFileSearchLimits = {
  results: MAX_RESULTS,
  visitedEntries: MAX_VISITED_ENTRIES,
};
