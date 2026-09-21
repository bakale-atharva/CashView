import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Only crons.cron / crons.interval are used; the .daily() helpers are avoided
// per the Convex guidelines. Times are UTC.

// 02:00: turn due recurring templates into draft invoices.
crons.cron(
  "generate recurring invoices",
  "0 2 * * *",
  internal.recurringCron.generateDue,
  {},
);

// 03:00: mark open invoices overdue. After generation, so a draft made at
// 02:00 is never touched (only sent and viewed invoices can become overdue).
crons.cron("mark overdue invoices", "0 3 * * *", internal.invoicesCron.markOverdue, {});

export default crons;
