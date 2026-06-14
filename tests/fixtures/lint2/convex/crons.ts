import { cronJobs } from "convex/server";
import { api, internal } from "./_generated/api";

const crons = cronJobs();

// CLEAN — internal target.
crons.interval("cleanup", { hours: 1 }, internal.tasks.cleanup, {});

// CRON_PUBLIC_FN — schedules a public api.* function.
crons.daily("report", { hourUTC: 0, minuteUTC: 0 }, api.tasks.report, {});

// DUPLICATE_CRON_ID — "cleanup" is registered twice.
crons.interval("cleanup", { hours: 2 }, internal.tasks.cleanup, {});

export default crons;
