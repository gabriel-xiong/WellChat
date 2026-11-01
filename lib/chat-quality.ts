const GENERATED_FALLBACK_PATTERNS = [
  /\bi (?:do not|don't) (?:have|know|see|find)\b/i,
  /\bi (?:cannot|can't) answer\b/i,
  /\bi'm sorry,? but (?:i|we) (?:do not|don't) have\b/i,
  /\bnot available in the provided (?:context|information)\b/i,
];

export function isGeneratedFallback(answer: string): boolean {
  return GENERATED_FALLBACK_PATTERNS.some((pattern) => pattern.test(answer));
}
