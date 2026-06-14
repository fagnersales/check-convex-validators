import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  points: defineTable({ name: v.string(), sortKey: v.number() }),
  nodes: defineTable({ items: v.array(v.string()), weight: v.number() }),
});
