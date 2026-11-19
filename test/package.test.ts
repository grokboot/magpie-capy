import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  private?: boolean;
  publishConfig?: { access?: string };
  keywords: string[];
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
  test("uses a released semver with MIT, no runtime dependencies, and shipped docs/icon", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.private).toBeUndefined();
    expect(pkg.publishConfig).toEqual({ access: "public" });
    expect(pkg.license).toBe("MIT");
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.files).toEqual(expect.arrayContaining(["assets/", "docs/", "README.zh-CN.md"]));
    expect(readFileSync(new URL("../README.zh-CN.md", import.meta.url)).byteLength).toBeGreaterThan(0);
  });

  test("carries only truthful npm keywords", () => {
    expect(pkg.keywords).toEqual(["magpie", "capy", "task-agent", "api-key", "models", "usage"]);
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

  test("uses the Capy brand name and bounded bilingual summaries", () => {
    expect(pkg.magpie.name).toBe("Capy");
    expect(Buffer.byteLength(pkg.magpie.name)).toBeLessThanOrEqual(80);
    expect(Buffer.byteLength(pkg.magpie.summary.en)).toBeLessThanOrEqual(300);
    expect(Buffer.byteLength(pkg.magpie.summary.zh)).toBeLessThanOrEqual(300);
    expect(pkg.magpie.summary.zh).toContain("API Key");
    expect(pkg.magpie.summary.zh).toContain("OAuth/OIDC");
    expect(pkg.magpie.summary.en).toContain("OAuth/OIDC");
    expect(pkg.magpie.summary.en).toContain("writes off");
    expect(pkg.description).toContain("Capy");
    expect(pkg.description).toContain("任务");
  });
});
