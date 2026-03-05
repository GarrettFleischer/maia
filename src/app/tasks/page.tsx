/**
 * @fileoverview Redirect to app shell with tasks tab visible. Preserves deep links.
 * @module app/tasks/page
 */

import { redirect } from "next/navigation";

export default function TasksRedirect() {
  redirect("/?view=tasks");
}
