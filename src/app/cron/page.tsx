/**
 * @fileoverview Redirect to app shell with schedule (cron) tab visible. Preserves deep links.
 * @module app/cron/page
 */

import { redirect } from "next/navigation";

export default function CronRedirect() {
  redirect("/?view=cron");
}
