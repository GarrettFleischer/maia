/**
 * @fileoverview Renders markdown text as sanitized HTML.
 * @module components/MarkdownContent
 *
 * @brief Uses marked for parsing and DOMPurify for sanitization to prevent XSS.
 */

import { marked } from "marked";
import DOMPurify from "dompurify";

interface MarkdownContentProps {
  /** Raw markdown string to render */
  content: string;
  /** Optional class for the wrapper div */
  class?: string;
}

/**
 * @brief Renders markdown as HTML with safe sanitization.
 * @param props - content and optional class
 * @returns Preact element
 */
export function MarkdownContent({ content, class: className }: MarkdownContentProps) {
  if (!content || typeof content !== "string") {
    return null;
  }
  const rawHtml = marked.parse(content, { async: false });
  const sanitized = DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: [
      "p", "br", "strong", "em", "code", "pre", "ul", "ol", "li",
      "a", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6",
    ],
    ALLOWED_ATTR: ["href", "target", "rel"],
  });
  return (
    <div
      class={className}
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
}
