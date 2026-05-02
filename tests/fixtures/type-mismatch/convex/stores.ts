import { v } from "convex/values";
import { query } from "./_generated/server";

// Validator drift: schema string → validator number,
// schema id<users> → validator id<stores>,
// schema array<string> → validator array<number>,
// schema union<3 literals> → validator union<2 literals> (missing "closed").
export const getStore = query({
  args: { storeId: v.id("stores") },
  returns: v.union(
    v.object({
      _id: v.id("stores"),
      _creationTime: v.number(),
      name: v.number(),
      ownerId: v.id("stores"),
      tags: v.array(v.number()),
      status: v.union(v.literal("active"), v.literal("paused")),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.storeId);
  },
});
