export function isInstalledDisplay(matchesStandalone: boolean, navigatorStandalone: boolean): boolean {
  return matchesStandalone || navigatorStandalone
}

export function installSettingsLine(installed: boolean): string {
  return installed ? 'Installed' : 'In Chrome: Menu → Install app / Add to Home screen.'
}
