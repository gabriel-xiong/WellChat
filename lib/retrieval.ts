export interface MatchDocument {
  id: string;
  url: string;
  title: string | null;
  section: string | null;
  content: string;
  depth: string | null;
  last_indexed_at: string | null;
  similarity: number;
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

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\//g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.includes(token));
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

export function rerankChunks(question: string, chunks: MatchDocument[], limit = 5): MatchDocument[] {
  return [...chunks]
    .sort((left, right) => {
      const leftScore = left.similarity + lexicalBoost(question, left);
      const rightScore = right.similarity + lexicalBoost(question, right);
      return rightScore - leftScore;
    })
    .slice(0, limit);
}
