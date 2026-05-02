import { v } from "convex/values";
import { mutation } from "./_generated/server";

// Validator declares wrong table id — handler returns id<posts> but
// validator says id<users>. Real drift; analyzer must classify
// `ctx.db.insert("posts", ...)` as `idValue<posts>` to catch it.
export const createPost = mutation({
  args: { title: v.string() },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("posts", { title: args.title });
  },
});

// Clean: validator agrees with handler.
export const createPostOk = mutation({
  args: { title: v.string() },
  returns: v.id("posts"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("posts", { title: args.title });
  },
});
