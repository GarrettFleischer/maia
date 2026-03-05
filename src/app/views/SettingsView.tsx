"use client";

/**
 * @fileoverview Settings view wrapper: renders the settings page content without the header
 * so it can be shown/hidden inside the app shell without unmounting.
 * @module app/views/SettingsView
 */

import SettingsContent from "@/app/settings/SettingsContent";

/**
 * @brief Settings content for the app shell tab. Uses hideHeader so the shell provides the nav.
 * @returns Settings form and tabs (providers, models, context, agents, skills).
 */
export default function SettingsView() {
  return <SettingsContent hideHeader />;
}
