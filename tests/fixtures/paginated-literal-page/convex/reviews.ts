import { v } from "convex/values";
import { query } from "./_generated/server";

// Validator declares paginated container whose `page` element is a small
// literal projection — NOT the full row. Handler matches: `result.page` is
// rowsOf<reviews>, mapped through Promise.all into a 3-field literal.
// Without page-override tracking, analyzer falsely complains that the
// validator is missing the schema's `secret` and `attachments` fields.
const reviewProjection = v.object({
  _id: v.id("reviews"),
  rating: v.optional(v.number()),
  attachmentUrls: v.array(v.union(v.string(), v.null())),
});

export const listReviews = query({
  args: { paginationOpts: v.any() },
  returns: v.object({
    page: v.array(reviewProjection),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db.query("reviews").paginate(args.paginationOpts);

    const pageWithUrls = await Promise.all(
      result.page.map(async (r) => {
        const attachmentUrls = await Promise.all(
          r.attachments.map((id) => ctx.storage.getUrl(id)),
        );
        return {
          _id: r._id,
          rating: r.rating,
          attachmentUrls,
        };
      }),
    );

    return { ...result, page: pageWithUrls };
  },
});
