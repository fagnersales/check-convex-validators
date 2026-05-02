import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  connections: defineTable({
    customerId: v.id("customers"),
    displayName: v.string(),
    username: v.string(),
    avatarUrl: v.string(),
    secret: v.string(),
  }),
});
