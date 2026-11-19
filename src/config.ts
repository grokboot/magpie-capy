import { CapyError } from "./errors.ts";

const MAX_API_KEY_LENGTH = 4096;
const FORBIDDEN_IN_KEY = /[\s\u0000-\u001f\u007f]/;

export type Environment = Record<string, string | undefined>;

export function normalizeApiKey(raw: string, source: string): string {
  const key = raw.trim();
  if (key.length === 0) {
    throw new CapyError(
      "configuration",
      `${source} is empty. Create an API key manually in Capy Settings > API and set it in the environment that starts Magpie.`,
    );
  }
  if (key.length > MAX_API_KEY_LENGTH || FORBIDDEN_IN_KEY.test(key)) {
    throw new CapyError(
      "configuration",
      `${source} is malformed (it is too long or contains whitespace/control characters). Replace it with a key copied from Capy Settings > API.`,
    );
  }
  return key;
}

export function readApiKey(env: Environment): string {
  const raw = env.CAPY_API_KEY;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new CapyError(
      "configuration",
      "No Capy API key is configured. In Magpie, open the Capy plugin row and choose “配置 Capy 组织 API Key”, or set CAPY_API_KEY in the environment that starts Magpie and restart it. A key is never accepted as a tool argument.",
    );
  }
  return normalizeApiKey(raw, "CAPY_API_KEY");
}

export function writesAllowed(env: Environment, option = false): boolean {
  return option === true || env.CAPY_ALLOW_WRITES === "true";
}

export function assertWritesEnabled(env: Environment, option = false): void {
  if (!writesAllowed(env, option)) {
    throw new CapyError(
      "writes_disabled",
      "Capy writes are disabled. Set CAPY_ALLOW_WRITES=true in Magpie's environment, or set the non-secret plugin option {\"allowWrites\":true}. Reads remain available without it. Writes can spend credits, run commands, or open pull requests.",
    );
  }
}

export function assertConfirmed(confirm: boolean): void {
  if (confirm !== true) {
    throw new CapyError(
      "confirmation_required",
      "This Capy write requires confirm:true for this exact invocation. confirm:true is a caller assertion, not a human-approval UI or an authorization boundary; the host/user must enforce approval. Writes can spend credits, run project commands, or open pull requests depending on the instructions and project settings.",
    );
  }
}
