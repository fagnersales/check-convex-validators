import { v } from "convex/values";

// Pattern A: plain object spread
export const baseStoreFields = {
  _id: v.id("stores"),
  _creationTime: v.number(),
  name: v.string(),
  description: v.optional(v.string()),
};

// Pattern B: v.object(...).fields spread base
export const baseStoreValidator = v.object({
  _id: v.id("stores"),
  _creationTime: v.number(),
  name: v.string(),
  description: v.optional(v.string()),
});

// Used by getStoreA — clean spread, balance added explicitly
export const storeReturnA = v.object({
  ...baseStoreFields,
  balance: v.number(),
});

// Used by getStoreB — clean spread via .fields
export const storeReturnB = v.object({
  ...baseStoreValidator.fields,
  balance: v.number(),
});
