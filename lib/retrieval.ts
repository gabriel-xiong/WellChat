export interface MatchDocument {
  id: string;
  url: string;
  title: string | null;
  section: string | null;
  content: string;
  depth: string | null;
  content_type?: string | null;
  last_indexed_at: string | null;
  similarity: number;
  lexicalMatch?: boolean;
}

const STOP_WORDS = [
  'about',
  'after',
  'and',
  'are',
  'can',
  'does',
  'for',
  'from',
  'how',
  'is',
  'me',
  'of',
  'on',
  'the',
  'to',
  'us',
  'what',
  'when',
  'where',
  'with',
  'you',
];

const GENERIC_SEARCH_WORDS = new Set([
  'any',
  'available',
  'church',
  'find',
  'have',
  'info',
  'information',
  'happening',
  'looking',
  'month',
  'resource',
  'resources',
  'sermon',
  'sermons',
  'tell',
  'this',
  'week',
  'well',
  'austin',
]);

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

const EVENT_INTENT_PATTERN = /\b(events?|happening|calendar|upcoming)\b|\b(?:this|next)\s+(?:month|week)\b/i;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\//g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.includes(token));
}

function monthTerms(question: string, referenceDate: Date): string[] {
  const normalized = question.toLowerCase();
  let monthIndex = MONTHS.findIndex((month) => new RegExp(`\\b${month}\\b`).test(normalized));

  if (monthIndex < 0 && /\bthis\s+month\b/i.test(question)) {
    const monthName = new Intl.DateTimeFormat('en-US', {
      month: 'long',
      timeZone: 'America/Chicago',
    }).format(referenceDate).toLowerCase();
    monthIndex = MONTHS.indexOf(monthName as typeof MONTHS[number]);
  } else if (monthIndex < 0 && /\bnext\s+month\b/i.test(question)) {
    const parts = new Intl.DateTimeFormat('en-US', {
      month: 'numeric',
      timeZone: 'America/Chicago',
    }).formatToParts(referenceDate);
    const month = Number(parts.find((part) => part.type === 'month')?.value ?? 1);
    monthIndex = month % 12;
  }

  if (monthIndex < 0) return [];
  const month = MONTHS[monthIndex];
  return [month, month.slice(0, 3)];
}

export function selectLexicalSearchTerms(question: string, limit = 4, referenceDate = new Date()): string[] {
  const intentTerms = EVENT_INTENT_PATTERN.test(question) ? ['events'] : [];
  const subjectTerms = tokenize(question).filter((token) => !GENERIC_SEARCH_WORDS.has(token));
  return [...new Set([...intentTerms, ...subjectTerms, ...monthTerms(question, referenceDate)])].slice(0, limit);
}

export function mergeRetrievalCandidates(
  vectorCandidates: MatchDocument[],
  lexicalCandidates: MatchDocument[]
): MatchDocument[] {
  const merged = new Map(vectorCandidates.map((candidate) => [candidate.id, { ...candidate }]));
  for (const candidate of lexicalCandidates) {
    const existing = merged.get(candidate.id);
    if (existing) existing.lexicalMatch = true;
    else merged.set(candidate.id, { ...candidate, lexicalMatch: true });
  }
  return [...merged.values()];
}

function lexicalBoost(question: string, chunk: MatchDocument): number {
  const questionTokens = [...new Set([...tokenize(question), ...selectLexicalSearchTerms(question, 8)])];
  const urlTokens = tokenize(chunk.url);
  const titleTokens = tokenize(chunk.title || '');
  const sectionTokens = tokenize(chunk.section || '');
  const contentTokens = tokenize(chunk.content.slice(0, 500));
  const urlTitleSectionTokens = new Set([...urlTokens, ...titleTokens, ...sectionTokens]);
  const contentTokenSet = new Set(contentTokens);

  return questionTokens.reduce((score, token) => {
    if (urlTitleSectionTokens.has(token)) return score + 0.08;
    if (contentTokenSet.has(token)) return score + 0.04;
    return score;
  }, 0);
}

function directCollectionBoost(question: string, chunk: MatchDocument): number {
  const subjectTerms = new Set(selectLexicalSearchTerms(question).map((token) => token.replace(/s$/, '')));
  try {
    const pathSegments = new URL(chunk.url).pathname.split('/').filter(Boolean);
    const collection = pathSegments[0]?.replace(/s$/, '');
    const matchesCollection = collection && subjectTerms.has(collection);
    const matchesEventType = EVENT_INTENT_PATTERN.test(question)
      && (chunk.content_type === 'event' || chunk.content_type === 'retreat');
    const collectionIndex = EVENT_INTENT_PATTERN.test(question)
      && pathSegments.length === 1
      && collection === 'event';
    return (matchesCollection || matchesEventType ? 0.3 : 0) + (collectionIndex ? 0.2 : 0);
  } catch {
    return 0;
  }
}

function temporalEvidenceBoost(question: string, chunk: MatchDocument): number {
  const evidence = `${chunk.section || ''} ${chunk.content.slice(0, 800)}`.toLowerCase();
  const requestedMonth = monthTerms(question, new Date());
  const hasRequestedMonth = requestedMonth.some((term) => new RegExp(`\\b${term}\\b`).test(evidence));
  const asksForTime = /\b(?:when|time|times|date|schedule|month|week|today|tomorrow)\b/i.test(question);
  const hasClockTime = /\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)\b/i.test(evidence);
  return (hasRequestedMonth ? 0.2 : 0) + (asksForTime && hasClockTime ? 0.12 : 0);
}

export function rerankChunks(question: string, chunks: MatchDocument[], limit = 5): MatchDocument[] {
  return [...chunks]
    .sort((left, right) => {
      const leftScore = left.similarity + lexicalBoost(question, left) + directCollectionBoost(question, left)
        + temporalEvidenceBoost(question, left);
      const rightScore = right.similarity + lexicalBoost(question, right) + directCollectionBoost(question, right)
        + temporalEvidenceBoost(question, right);
      return (rightScore + (right.lexicalMatch ? 0.25 : 0))
        - (leftScore + (left.lexicalMatch ? 0.25 : 0));
    })
    .slice(0, limit);
}
