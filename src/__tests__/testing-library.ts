/**
 * @fileoverview Configures React Testing Library and jest-dom matchers for component tests.
 * @module __tests__/testing-library
 *
 * Load after happydom.ts so that render() has a DOM. Registers cleanup and expect matchers.
 */

import { afterEach, expect } from "bun:test";
import { cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";

expect.extend(matchers);
afterEach(() => cleanup());
