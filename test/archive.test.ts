import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  version: string;
};

const SOURCE_DATE_EPOCH = 1_700_000_000;

type Entry = { name: string; epoch: number };

const readEntries = (archive: string): Entry[] => {
  const tar = gunzipSync(readFileSync(archive));
  const entries: Entry[] = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    const field = (start: number, length: number) =>
      header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const name = field(0, 100);
    if (name === "") break;
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const epoch = Number.parseInt(field(136, 12).trim() || "0", 8);
    const type = field(156, 1);
    if (type !== "x" && type !== "g" && type !== "L") entries.push({ name, epoch });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
};

const pack = (out: string, timeZone: string) => {
  const built = spawnSync(process.execPath, ["scripts/pack-release.ts", out], {
    cwd: root,
    env: { ...process.env, SOURCE_DATE_EPOCH: String(SOURCE_DATE_EPOCH), TZ: timeZone },
    encoding: "utf8",
  });
  expect(built.status).toBe(0);
  return join(out, `${pkg.name}-${pkg.version}.tgz`);
};

describe("release archive", () => {
  test("stamps every entry with the pinned SOURCE_DATE_EPOCH and packages metadata without secrets", () => {
    const out = mkdtempSync(join(tmpdir(), "magpie-capy-archive-test-"));
    try {
      const archive = pack(out, "UTC");
      const entries = readEntries(archive);
      expect(entries.length).toBeGreaterThan(10);
      for (const entry of entries) expect(entry.epoch).toBe(SOURCE_DATE_EPOCH);

      const names = entries.map((entry) => entry.name);
      expect(names[0]).toBe("magpie-capy/");
      expect(names.every((name) => name.startsWith("magpie-capy/"))).toBe(true);
      expect(names).toContain("magpie-capy/README.zh-CN.md");
      expect(names).toContain("magpie-capy/assets/capy-icon.svg");
      for (const forbidden of [".env", "plugin-auth", "node_modules", ".npmrc", "id_rsa"]) {
        expect(names.join("\n")).not.toContain(forbidden);
      }

      const manifest = JSON.parse(
        spawnSync("tar", ["-xOzf", archive, "magpie-capy/package.json"], { encoding: "utf8" }).stdout,
      ) as { version: string; license: string; magpie: { icon: string } };
      expect(manifest.version).toBe(pkg.version);
      expect(manifest.license).toBe("MIT");
      expect(manifest.magpie.icon.startsWith("data:image/svg+xml;base64,")).toBe(true);
      expect(readFileSync(archive).byteLength).toBeGreaterThan(10_000);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("keeps entry metadata identical across build timezones", () => {
    const out = mkdtempSync(join(tmpdir(), "magpie-capy-archive-tz-"));
    try {
      const zones = ["UTC", "Asia/Shanghai", "America/Los_Angeles"];
      const layouts = zones.map((zone) => {
        const dir = join(out, zone.replace("/", "-"));
        mkdirSync(dir, { recursive: true });
        return readEntries(pack(dir, zone));
      });
      for (const layout of layouts) expect(layout).toEqual(layouts[0]!);
      for (const { epoch } of layouts[0]!) expect(epoch).toBe(SOURCE_DATE_EPOCH);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
