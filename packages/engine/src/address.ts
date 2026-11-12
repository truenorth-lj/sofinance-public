/** First 4 and last 4 characters, with an ellipsis. Strings of 8 or fewer are shown in full. */
export function shortAddress(address: string): string {
  const text = address.trim();
  return text.length > 8 ? `${text.slice(0, 4)}…${text.slice(-4)}` : text;
}
