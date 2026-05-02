import { v } from "convex/values";
import { mutation } from "./_generated/server";

// Handler returns ctx.storage.generateUploadUrl() (a string Promise) but
// validator says number — should flag.
export const badUploadUrl = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

// Same handler with the correct validator — clean.
export const goodUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

// Handler returns JSON.stringify(...) — should classify as string.
export const badJson = mutation({
  args: {},
  returns: v.number(),
  handler: async () => {
    return JSON.stringify({ ok: true });
  },
});
