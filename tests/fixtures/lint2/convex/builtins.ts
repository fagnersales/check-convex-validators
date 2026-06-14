// No "use node" directive, yet this file imports Node builtins → flagged.
import * as fs from "node:fs"; // NODE_BUILTIN_WITHOUT_USE_NODE
import path from "path"; // NODE_BUILTIN_WITHOUT_USE_NODE
import type { Stats } from "node:fs"; // type-only — NOT flagged (erased)
import { internalAction } from "./_generated/server";

export const usesNode = internalAction({
  args: {},
  handler: async () => {
    const _s: Stats | null = null;
    return `${typeof fs}-${path.sep}-${_s}`;
  },
});
