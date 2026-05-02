import { v } from "convex/values";
import { query } from "./_generated/server";

// `return []` early-exit must not trip CARDINALITY_MISMATCH against
// `v.array(...)` validator. (Empty array is compatible with any array.)
export const list = query({
  args: { skip: v.boolean() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    if (args.skip) return [];
    return ["hello"];
  },
});
