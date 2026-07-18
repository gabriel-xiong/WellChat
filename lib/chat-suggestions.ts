export const CHAT_SUGGESTIONS = [
  "When are Sunday services?",
  "What does The Well believe?",
  "What events are happening this month?",
  "How can I join a community group?",
] as const;

const CACHE_KEYS = new Map<string, string>([
  ["when are sunday services?", "sunday-services"],
  ["what does the well believe?", "beliefs"],
  ["how can i join a community group?", "community-groups"],
]);

export function getSuggestedAnswerCacheKey(question: string): string | null {
  return CACHE_KEYS.get(question.trim().toLowerCase()) ?? null;
}
