import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  agents: defineTable({
    name: v.string(),
    ownerId: v.id("users"),
    inventory: v.array(v.object({ itemId: v.id("items"), qty: v.number() })),
  }).index("by_owner", ["ownerId"]),
  items: defineTable({ name: v.string(), basePrice: v.number() }),
  users: defineTable({ email: v.string() }),
});
