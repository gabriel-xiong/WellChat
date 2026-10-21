export interface MatchDocument {
  id: string;
  url: string;
  title: string | null;
  section: string | null;
  content: string;
  depth: string | null;
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
  'looking',
  'resource',
  'resources',
  'sermon',
  'sermons',
  'tell',
  'well',
  'austin',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\//g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.includes(token));
}

export function selectLexicalSearchTerms(question: string, limit = 3): string[] {
  return [...new Set(tokenize(question).filter((token) => !GENERIC_SEARCH_WORDS.has(token)))].slice(0, limit);
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
  const questionTokens = tokenize(question);
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
    const collection = new URL(chunk.url).pathname.split('/').filter(Boolean)[0]?.replace(/s$/, '');
    return collection && subjectTerms.has(collection) ? 0.3 : 0;
  } catch {
    return 0;
  }
}

export function rerankChunks(question: string, chunks: MatchDocument[], limit = 5): MatchDocument[] {
  return [...chunks]
    .sort((left, right) => {
      const leftScore = left.similarity + lexicalBoost(question, left) + directCollectionBoost(question, left);
      const rightScore = right.similarity + lexicalBoost(question, right) + directCollectionBoost(question, right);
      return (rightScore + (right.lexicalMatch ? 0.25 : 0))
        - (leftScore + (left.lexicalMatch ? 0.25 : 0));
    })
    .slice(0, limit);
}
