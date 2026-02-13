/**
 * @fileoverview Token-aware text chunking for memory and context management.
 * @module memory/chunker
 *
 * @note Splits large texts into overlapping chunks that fit within
 * token limits while preserving semantic boundaries (paragraphs, sentences).
 */

/**
 * @brief Options for configuring the text chunker.
 */
export interface ChunkerOptions {
  /** Maximum tokens per chunk (approximate, uses chars/4 estimate) */
  maxTokensPerChunk: number;
  /** Number of overlapping tokens between consecutive chunks */
  overlapTokens: number;
}

/**
 * @brief A single chunk produced by the chunker.
 */
export interface TextChunk {
  /** The text content of this chunk */
  text: string;
  /** Estimated token count for this chunk */
  estimatedTokens: number;
  /** Zero-based index of this chunk in the sequence */
  index: number;
}

/**
 * @brief Text chunker interface.
 */
export interface TextChunker {
  /**
   * @brief Splits text into token-sized chunks with overlap.
   * @param text - Input text to chunk
   * @returns Array of TextChunk objects
   */
  chunk(text: string): TextChunk[];

  /**
   * @brief Estimates the token count of a text string.
   * @param text - Input text
   * @returns Approximate token count (chars / 4)
   */
  estimateTokens(text: string): number;
}

/**
 * @brief Default chunker options.
 */
const DEFAULT_OPTIONS: ChunkerOptions = {
  maxTokensPerChunk: 512,
  overlapTokens: 64,
};

/**
 * @brief Creates a token-aware text chunker.
 * @param options - Optional configuration overrides
 * @returns TextChunker instance
 *
 * @note Token estimation uses a simple chars/4 heuristic which is a
 * reasonable approximation for English text across most tokenizers.
 * The chunker prefers splitting at paragraph boundaries, then sentence
 * boundaries, then word boundaries.
 *
 * @example
 * const chunker = createTextChunker({ maxTokensPerChunk: 256, overlapTokens: 32 });
 * const chunks = chunker.chunk(longDocument);
 * // Each chunk has ~256 tokens with 32-token overlap between consecutive chunks
 */
export function createTextChunker(options?: Partial<ChunkerOptions>): TextChunker {
  const opts: ChunkerOptions = { ...DEFAULT_OPTIONS, ...options };
  const maxChars = opts.maxTokensPerChunk * 4;
  const overlapChars = opts.overlapTokens * 4;

  /**
   * @brief Estimates tokens from character count.
   * @param text - Input text
   * @returns Estimated token count
   */
  function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * @brief Finds the best split point in text near a target position.
   * @param text - Text to search for split point
   * @param target - Target character position
   * @returns Best split position (paragraph > sentence > word > target)
   */
  function findSplitPoint(text: string, target: number): number {
    // Prefer paragraph boundary
    const paragraphEnd = text.lastIndexOf("\n\n", target);
    if (paragraphEnd > target * 0.5) {
      return paragraphEnd + 2;
    }

    // Prefer sentence boundary
    const sentenceEnd = text.lastIndexOf(". ", target);
    if (sentenceEnd > target * 0.5) {
      return sentenceEnd + 2;
    }

    // Prefer word boundary
    const wordEnd = text.lastIndexOf(" ", target);
    if (wordEnd > target * 0.5) {
      return wordEnd + 1;
    }

    return target;
  }

  /**
   * @brief Splits text into overlapping chunks.
   * @param text - Input text
   * @returns Array of TextChunk objects
   */
  function chunk(text: string): TextChunk[] {
    if (!text || text.length === 0) {
      return [];
    }

    if (text.length <= maxChars) {
      return [
        {
          text,
          estimatedTokens: estimateTokens(text),
          index: 0,
        },
      ];
    }

    const chunks: TextChunk[] = [];
    let offset = 0;
    let index = 0;

    while (offset < text.length) {
      const end = Math.min(offset + maxChars, text.length);
      let chunkEnd: number;

      if (end >= text.length) {
        chunkEnd = text.length;
      } else {
        chunkEnd = findSplitPoint(text, end);
      }

      const chunkText = text.slice(offset, chunkEnd).trim();
      if (chunkText.length > 0) {
        chunks.push({
          text: chunkText,
          estimatedTokens: estimateTokens(chunkText),
          index,
        });
        index++;
      }

      // Advance with overlap
      const advance = chunkEnd - offset - overlapChars;
      if (advance <= 0) {
        // Prevent infinite loop: force advance
        offset = chunkEnd;
      } else {
        offset += advance;
      }
    }

    return chunks;
  }

  return { chunk, estimateTokens };
}
