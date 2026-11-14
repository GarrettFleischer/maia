/** Honest leaf: world arrives as the clipboard writer. */
export async function copyText(
  text: string,
  clipboard: { writeText(value: string): Promise<void> },
): Promise<'copied' | 'failed'> {
  try {
    await clipboard.writeText(text)
    return 'copied'
  } catch {
    return 'failed'
  }
}
