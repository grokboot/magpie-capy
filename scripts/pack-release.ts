import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const outputDirectory = resolve(process.argv[2] ?? ".");
const packageRoot = resolve(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  name: string;
  version: string;
};
const now = Math.floor(Date.now() / 1000);
const sourceDate = process.env.SOURCE_DATE_EPOCH;
const epoch = sourceDate === undefined ? now : Number(sourceDate);
if (!Number.isInteger(epoch) || epoch < 0 || epoch > now + 60) {
  console.error("SOURCE_DATE_EPOCH must be a non-negative integer no later than the current clock");
  process.exit(1);
}

const temp = mkdtempSync(join(tmpdir(), "magpie-capy-pack-"));
const npmDir = join(temp, "npm");
const root = join(temp, "root");
const run = (command: string, args: string[], cwd = packageRoot, env = process.env) => {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
};

try {
  run("mkdir", ["-p", npmDir, root]);
  const packed = run("npm", ["pack", "--pack-destination", npmDir]).trim().split("\n").at(-1)!;
  run("tar", ["-xzf", join(npmDir, packed), "-C", root]);
  run("mv", [join(root, "package"), join(root, pkg.name)]);
  const output = join(outputDirectory, `${pkg.name}-${pkg.version}.tgz`);
  run("tar", ["--mtime", `@${epoch}`, "--owner=0", "--group=0", "--numeric-owner", "-czf", output, "-C", root, pkg.name]);
  const digest = createHash("sha256").update(readFileSync(output)).digest("hex");
  const shown = new Date(epoch * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  console.log(JSON.stringify({ output, sha256: digest, epoch, buildTimeAsiaShanghai: shown, source: sourceDate === undefined ? "current-clock" : "SOURCE_DATE_EPOCH" }, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
