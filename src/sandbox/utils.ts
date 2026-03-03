/**
 * Truncate text to a byte-length limit, preserving valid UTF-8 boundaries.
 */
export function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf-8') <= limit) {
    return { text, truncated: false };
  }
  // Truncate by slicing bytes then finding last valid char boundary
  const buf = Buffer.from(text, 'utf-8').subarray(0, limit);
  const truncated = buf.toString('utf-8');
  return { text: truncated + '\n... [output truncated at 10KB]', truncated: true };
}
