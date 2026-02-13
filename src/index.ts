/**
 * @fileoverview Main entry point and CLI for the Maia AI assistant.
 * @module index
 *
 * @note This file handles CLI command parsing and bootstraps the application.
 * Available commands: start, chat, onboard, credentials, backup, restore,
 * schedule, watchdog, doctor.
 *
 * When building MaiaContext for start/chat, use createApplicationFileSystem
 * from ./core/compose-fs.js so that the file sandbox is applied when
 * config.security.sandbox.enabled is true.
 */

const args = process.argv.slice(2);
const command = args[0] ?? "help";

/**
 * @brief Prints usage information.
 */
function printHelp(): void {
  console.log(`
Maia - Personal AI Assistant

Usage: maia <command> [options]

Commands:
  start              Start gateway + watchdog + channels
  chat               Interactive CLI chat
  onboard            First-run setup wizard

  credentials add    Add an API key to the encrypted vault
  credentials list   List stored credential names
  credentials remove Remove a credential

  backup             Create encrypted backup archive
  restore            Restore from backup

  schedule list      List scheduled tasks
  schedule add       Add a reminder or recurring task
  schedule remove    Remove a scheduled task

  watchdog           Run watchdog standalone
  watchdog status    Show threat level and recent alerts
  doctor             One-shot health check

  --help, -h         Show this help message
  --version, -v      Show version
`);
}

/**
 * @brief Main CLI dispatcher.
 */
async function main(): Promise<void> {
  switch (command) {
    case "start":
      console.log("Starting Maia gateway + watchdog...");
      console.log("(Full gateway implementation pending - use 'maia chat' for CLI mode)");
      break;

    case "chat":
      console.log("Starting interactive CLI chat...");
      console.log("(Full CLI implementation pending)");
      break;

    case "onboard":
      console.log("Running first-run setup wizard...");
      console.log("(Full onboarding implementation pending)");
      break;

    case "credentials":
      console.log("Credential management...");
      console.log("(Full credential CLI pending)");
      break;

    case "backup":
      console.log("Creating encrypted backup...");
      console.log("(Full backup CLI pending)");
      break;

    case "restore":
      console.log("Restoring from backup...");
      console.log("(Full restore CLI pending)");
      break;

    case "schedule":
      console.log("Scheduled tasks...");
      console.log("(Full scheduler CLI pending)");
      break;

    case "watchdog":
      console.log("Watchdog daemon...");
      console.log("(Full watchdog CLI pending)");
      break;

    case "doctor":
      console.log("Running health diagnostics...");
      console.log("(Full doctor CLI pending)");
      break;

    case "--version":
    case "-v":
      console.log("maia v0.1.0");
      break;

    case "--help":
    case "-h":
    case "help":
    default:
      printHelp();
      break;
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
