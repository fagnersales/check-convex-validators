import { v } from "convex/values";
import { query } from "./_generated/server";
// WRONG_RUNTIME_IMPORT — this file has no "use node", but nodeStuff does.
import { NODE_SECRET } from "./nodeStuff";

export const usesNode = query({
  args: {},
  handler: async () => {
    return NODE_SECRET;
  },
});
