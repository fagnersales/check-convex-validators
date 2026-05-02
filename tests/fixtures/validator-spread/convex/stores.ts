import { v } from "convex/values";
import { query } from "./_generated/server";
import { storeReturnA, storeReturnB } from "./validators";

export const getStoreA = query({
  args: { storeId: v.id("stores") },
  returns: v.union(storeReturnA, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.storeId);
  },
});

export const getStoreB = query({
  args: { storeId: v.id("stores") },
  returns: v.union(storeReturnB, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.storeId);
  },
});
