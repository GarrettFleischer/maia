/**
 * @fileoverview Redirect to app shell with agents tab visible. Preserves deep links.
 * @module app/agents/page
 */

import { redirect } from "next/navigation";

export default function AgentsRedirect() {
  redirect("/?view=agents");
}
