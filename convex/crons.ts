import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// 03:00 UTC daily. Only crons.cron / crons.interval are used; the .daily()
// helpers are avoided per the Convex guidelines.
crons.cron("mark overdue invoices", "0 3 * * *", internal.invoicesCron.markOverdue, {});

export default crons;
