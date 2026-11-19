import { createCapyAuth } from "./src/auth.ts";
import {
  createCapyToolsPlugin,
  type PluginInput,
  type PluginOptions,
} from "./src/tools.ts";

export const CapyTools = async (input?: PluginInput, options?: PluginOptions) => {
  const auth = createCapyAuth({
    accountKey: () =>
      typeof input?.magpie?.account === "function" ? input.magpie.account("capy") : "",
  });
  const toolHooks = await createCapyToolsPlugin({
    hostApiKey: auth.hostApiKey,
    hostApiKeyError: auth.hostApiKeyError,
  })(input, options);
  return { ...toolHooks, ...auth.hooks };
};
