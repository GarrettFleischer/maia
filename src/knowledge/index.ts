/**
 * @fileoverview Knowledge vault public exports.
 * @module knowledge
 */

export { createKnowledgeVault } from "./vault.js";
export { createWikilinkParser } from "./linker.js";
export { createNote, extractWikilinks, serializeFrontmatter, parseFrontmatter, serializeNote } from "./note.js";
