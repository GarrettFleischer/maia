/**
 * @fileoverview Dashboard entry point. Mounts the Preact app.
 * @module main
 */

import { render } from "preact";
import { App } from "./app.js";
import "./index.css";

render(<App />, document.getElementById("app")!);
