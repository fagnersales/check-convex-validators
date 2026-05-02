import { v } from "convex/values";
import { query } from "./_generated/server";

export const getStore = query({
  args: { storeId: v.id("stores") },
  returns: v.union(
    v.object({
      _id: v.id("stores"),
      _creationTime: v.number(),
      name: v.string(),
      description: v.optional(v.string()),
      // missing cachedAvailableBalance — must still flag through const rebind
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const id = args.storeId;
    return await ctx.db.get(id);
  },
});
