import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  loans: defineTable({
    amount: v.number(),
    cancelledBy: v.optional(v.id("users")),
  }),
  users: defineTable({
    email: v.string(),
  }),
});
