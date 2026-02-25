/**
 * @fileoverview Registers Happy DOM as the global DOM implementation for component tests.
 * @module __tests__/happydom
 *
 * Loaded via bunfig.toml preload before test files that need a DOM (e.g. RTL component tests).
 * Must run before testing-library.ts so that render() has a document.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
