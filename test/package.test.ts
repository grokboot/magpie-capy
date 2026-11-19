import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  private: boolean;
  license: string;
  description: string;
  files: string[];
  dependencies?: Record<string, string>;
  magpie: {
    name: string;
    icon: string;
    options: { allowWrites: boolean };
    summary: { en: string; zh: string };
  };
};

describe("package UX metadata", () => {
  test("uses 0.2.1 with MIT, no runtime dependencies, and shipped docs/icon", () => {
    expect(pkg.version).toBe("0.2.1");
    expect(pkg.private).toBe(true);
    expect(pkg.license).toBe("MIT");
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.files).toEqual(expect.arrayContaining(["assets/", "docs/", "README.zh-CN.md"]));
    expect(readFileSync(new URL("../README.zh-CN.md", import.meta.url)).byteLength).toBeGreaterThan(0);
  });

  test("has a bounded offline data-URI icon identical to the attributed asset", () => {
    expect(pkg.magpie.icon.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(Buffer.byteLength(pkg.magpie.icon)).toBeLessThan(1_000_000);
    const encoded = pkg.magpie.icon.slice("data:image/svg+xml;base64,".length);
    const asset = readFileSync(new URL("../assets/capy-icon.svg", import.meta.url));
    expect(Buffer.from(encoded, "base64").equals(asset)).toBe(true);
  });

  test("exposes non-secret options example with writes off", () => {
    expect(pkg.magpie.options).toEqual({ allowWrites: false });
    expect(JSON.stringify(pkg.magpie.options)).not.toMatch(/key|secret|token/i);
  });

  test("uses Chinese task-tool naming and bounded bilingual summaries", () => {
    expect(pkg.magpie.name).toBe("Capy 任务工具");
    expect(Buffer.byteLength(pkg.magpie.name)).toBeLessThanOrEqual(80);
    expect(Buffer.byteLength(pkg.magpie.summary.en)).toBeLessThanOrEqual(300);
    expect(Buffer.byteLength(pkg.magpie.summary.zh)).toBeLessThanOrEqual(300);
    expect(pkg.magpie.summary.zh).toContain("API Key");
    expect(pkg.description).toContain("Capy");
    expect(pkg.description).toContain("任务");
  });
});
