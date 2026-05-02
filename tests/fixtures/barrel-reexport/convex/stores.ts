import { v } from "convex/values";
import { query } from "./_generated/server";
import { storeReturnValidator } from "./validators";

export const getStore = query({
  args: { storeId: v.id("stores") },
  returns: v.union(storeReturnValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.storeId);
  },
});
