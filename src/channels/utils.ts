/**
 * Split a long message into chunks that fit within a channel's character limit.
 * Tries to break on newlines, then spaces, before falling back to a hard split.
 */
export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline near the limit
    let splitIndex = remaining.lastIndexOf('\n', maxLength);
    if (splitIndex < maxLength * 0.5) {
      // No good newline break — split at a space
      splitIndex = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIndex < maxLength * 0.5) {
      // No good break point — hard split
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}
