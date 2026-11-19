import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const publicAuthor = "grokboot contributors";
const publicRepository = "github.com/grokboot/magpie-capy";
const forbidden = [
  "/workspace/",
  "/home/",
  "/opt/",
  "/cursor/",
  "-----BEGIN",
  "ghp_",
  "github_pat_",
];
const textExtensions = new Set([".md", ".ts", ".json", ".svg", ".yml", ".yaml", ".lock"]);
const skip = new Set([".git", "node_modules", "coverage"]);

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else out.push(path);
  }
  return out;
}

describe("publication hygiene", () => {
  test("public tree has no machine paths or obvious token markers", () => {
    const offenders: string[] = [];
    for (const path of files(root)) {
      const rel = relative(root, path);
      if (rel === "test/publication.test.ts") continue;
      if (!textExtensions.has(path.slice(path.lastIndexOf(".")))) continue;
      const text = readFileSync(path, "utf8");
      for (const marker of forbidden) {
        if (text.includes(marker)) offenders.push(`${rel}: ${marker}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("package points to the public repository and carries the public author", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      author: string;
      repository: { url: string };
      homepage: string;
      bugs: { url: string };
    };
    expect(pkg.author).toBe(publicAuthor);
    expect(pkg.author).not.toContain("@");
    expect(pkg.repository.url).toContain(publicRepository);
    expect(pkg.homepage).toContain(publicRepository);
    expect(pkg.bugs.url).toContain(`${publicRepository}/issues`);
  });
});
