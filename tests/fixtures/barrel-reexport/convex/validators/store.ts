import { v } from "convex/values";

// drifted: schema added cachedBalance, validator wasn't updated
export const storeReturnValidator = v.object({
  _id: v.id("stores"),
  _creationTime: v.number(),
  name: v.string(),
});
