export type FallbackIntent = 'church_information_missing' | 'out_of_scope';

const CHURCH_INFORMATION_SIGNALS = [
  'church', 'the well', 'service', 'sermon', 'doctrine', 'belief', 'theolog',
  'bapt', 'communion', 'intinction', 'class', 'course', 'livestream', 'stream',
  'dedicat', 'membership', 'prayer', 'retreat', 'event', 'giving', 'donat',
  'volunteer', 'ministry', 'pastor', 'staff', 'team', 'group', 'form',
];

/**
 * Separates a question the church site could plausibly document from one this
 * assistant should never attempt to answer, even if retrieval happens to find
 * a semantically similar page.
 */
export function classifyFallbackIntent(question: string, category: string): FallbackIntent {
  if (category !== 'other') return 'church_information_missing';
  const normalized = question.toLowerCase();
  return CHURCH_INFORMATION_SIGNALS.some((signal) => normalized.includes(signal))
    ? 'church_information_missing'
    : 'out_of_scope';
}

export function buildInitialFallbackAnswer(question: string, category: string, contact: string): string {
  if (classifyFallbackIntent(question, category) === 'church_information_missing') {
    return `I couldn't find published information about that on The Well's website, so I don't want to guess. Please contact us directly at ${contact}.`;
  }
  return `I can help with information published by The Well Austin Community Church, such as services, events, beliefs, groups, sermons, and ways to get involved. For this question, you may want to check a general search or another source.`;
}
