/**
 * @fileoverview Registers Happy DOM as the global DOM implementation for component tests.
 * @module __tests__/happydom
 *
 * Loaded via bunfig.toml preload before test files that need a DOM (e.g. RTL component tests).
 * Must run before testing-library.ts so that render() has a document.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";

/** Base URL so relative fetch (e.g. /api/sessions) works; avoids "Invalid URL on document location 'about:blank'" in tests. */
GlobalRegistrator.register({ url: "http://localhost:3000" });
