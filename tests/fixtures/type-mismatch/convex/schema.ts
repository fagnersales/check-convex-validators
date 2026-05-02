import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  stores: defineTable({
    name: v.string(),
    ownerId: v.id("users"),
    tags: v.array(v.string()),
    status: v.union(v.literal("active"), v.literal("paused"), v.literal("closed")),
  }),
  users: defineTable({ email: v.string() }),
});
