/**
 * @fileoverview Redirect to app shell with settings tab visible. Preserves deep links.
 * @module app/settings/page
 */

import { redirect } from "next/navigation";

export default function SettingsRedirect() {
  redirect("/?view=settings");
}
