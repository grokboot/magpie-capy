import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "..");

describe("release archive", () => {
  test("uses a real build timestamp and packages UX metadata without secrets", () => {
    const out = mkdtempSync(join(tmpdir(), "magpie-capy-archive-test-"));
    try {
      const built = spawnSync("bun", ["scripts/pack-release.ts", out], {
        cwd: root,
        env: { ...process.env, SOURCE_DATE_EPOCH: "1700000000", TZ: "Asia/Shanghai" },
        encoding: "utf8",
      });
      expect(built.status).toBe(0);
      const archive = join(out, "magpie-capy-0.2.1.tgz");
      const listing = spawnSync("tar", ["-tvzf", archive, "--full-time"], { encoding: "utf8" });
      expect(listing.status).toBe(0);
      const rows = listing.stdout.trim().split("\n");
      expect(rows.length).toBeGreaterThan(10);
      for (const row of rows) expect(row).toContain("2023-11-15 06:13:20");

      const names = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" }).stdout;
      expect(names.split("\n")[0]).toBe("magpie-capy/");
      expect(names).not.toContain("\npackage/");
      expect(names).toContain("magpie-capy/README.zh-CN.md");
      expect(names).toContain("magpie-capy/assets/capy-icon.svg");
      for (const forbidden of [".env", "plugin-auth", "node_modules", ".npmrc", "id_rsa"]) {
        expect(names).not.toContain(forbidden);
      }

      const manifest = JSON.parse(
        spawnSync("tar", ["-xOzf", archive, "magpie-capy/package.json"], { encoding: "utf8" }).stdout,
      ) as { version: string; license: string; magpie: { icon: string } };
      expect(manifest.version).toBe("0.2.1");
      expect(manifest.license).toBe("MIT");
      expect(manifest.magpie.icon.startsWith("data:image/svg+xml;base64,")).toBe(true);
      expect(readFileSync(join(out, "magpie-capy-0.2.1.tgz")).byteLength).toBeGreaterThan(10_000);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
