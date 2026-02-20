const INJECTION_PATTERNS: RegExp[] = [
  // Role manipulation
  /ignore\s+(all\s+)?previous\s+instructions?/gi,
  /you\s+are\s+now\s+[a-z]/gi,
  /forget\s+(everything|all\s+previous)/gi,
  /your\s+(new\s+)?instructions?\s+(are|is)/gi,
  /act\s+as\s+(if\s+you\s+(are|were))?/gi,
  /pretend\s+(you\s+are|to\s+be)/gi,
  /new\s+system\s+prompt/gi,
  /override\s+(system|safety|security)/gi,

  // Credential extraction
  /reveal\s+(your\s+)?(api\s+)?key/gi,
  /show\s+(me\s+)?(your\s+)?credentials?/gi,
  /what\s+is\s+your\s+(api\s+)?key/gi,
  /expose\s+(your\s+)?secrets?/gi,
  /print\s+(your\s+)?(system\s+)?prompt/gi,
  /repeat\s+(your\s+)?(system\s+)?prompt/gi,

  // Authority impersonation
  /as\s+(an?\s+)?(admin|administrator|developer|anthropic|openai)/gi,
  /this\s+is\s+(an?\s+)?(admin|system|emergency)\s+(message|override|update)/gi,
  /you\s+have\s+(been\s+)?granted\s+(elevated|special|admin)/gi,

  // Code execution
  /execute\s+(the\s+following|this)\s+(code|script|command)/gi,
  /run\s+this\s+(code|script|command)\s+immediately/gi,
];

const REDACTION_TEXT =
  "[REDACTED: potential injection detected — original content removed for security]";

export interface FilterResult {
  text: string;
  redacted: boolean;
  patternMatched?: string;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function filterText(text: string, source = "unknown"): FilterResult {
  const stripped = stripHtml(text);

  for (const pattern of INJECTION_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(stripped)) {
      return {
        text: stripped.replace(pattern, REDACTION_TEXT),
        redacted: true,
        patternMatched: pattern.source,
      };
    }
  }

  return { text: stripped, redacted: false };
}

export function filterEntries<T extends { content: string }>(
  entries: T[],
  source?: string
): { entries: T[]; anyRedacted: boolean } {
  let anyRedacted = false;
  const filtered = entries.map((e) => {
    const result = filterText(e.content, source);
    if (result.redacted) anyRedacted = true;
    return { ...e, content: result.text };
  });
  return { entries: filtered, anyRedacted };
}
