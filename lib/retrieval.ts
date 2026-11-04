export type RetrievalOrigin = 'vector' | 'lexical' | 'authoritative';

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
  lexicalScore?: number;
  vectorRank?: number;
  lexicalRank?: number;
  authoritativeRank?: number;
  finalScore?: number;
  retrievalConfidence?: number;
  retrievalOrigins?: RetrievalOrigin[];
}

export interface RetrievalDiagnostic {
  id: string;
  url: string;
  origins: RetrievalOrigin[];
  vectorRank: number | null;
  vectorSimilarity: number | null;
  lexicalRank: number | null;
  lexicalScore: number;
  authoritativeRank: number | null;
  reciprocalRankScore: number;
  confidence: number;
  selected: boolean;
}

export interface RetrievalResult {
  chunks: MatchDocument[];
  confidence: number;
  diagnostics: RetrievalDiagnostic[];
}

const STOP_WORDS = new Set([
  'about', 'after', 'and', 'are', 'can', 'does', 'for', 'from', 'how', 'is', 'me', 'of', 'on', 'the',
  'to', 'us', 'what', 'when', 'where', 'with', 'you',
]);

const GENERIC_SEARCH_WORDS = new Set([
  'any', 'available', 'church', 'find', 'have', 'info', 'information', 'happening', 'looking', 'month',
  'resource', 'resources', 'sermon', 'sermons', 'tell', 'this', 'week', 'well', 'austin',
]);

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const;

const DOMAIN_TERMS = [
  'beliefs', 'community', 'events', 'giving', 'jobs', 'lament', 'ministries', 'mission', 'missions', 'podcast',
  'resources', 'retreat', 'sermons', 'serve', 'staff', 'sundays', 'worship',
];

const SYNONYMS: Record<string, string[]> = {
  career: ['jobs'],
  careers: ['jobs'],
  donate: ['giving'],
  donation: ['giving'],
  donations: ['giving'],
  employment: ['jobs'],
  job: ['jobs'],
  livestream: ['online', 'sundays'],
  livestreaming: ['online', 'sundays'],
  message: ['sermons'],
  messages: ['sermons'],
  smallgroup: ['community'],
  sorrow: ['lament'],
  testimony: ['stories'],
  testimonies: ['stories'],
  volunteer: ['serve'],
  volunteering: ['serve'],
};

const EVENT_INTENT_PATTERN = /\b(events?|happening|calendar|upcoming)\b|\b(?:this|next)\s+(?:month|week)\b/i;
const TEMPORAL_QUESTION_PATTERN = /\b(?:when|what\s+time|date|dates|schedule|this\s+month|this\s+week|next\s+month|next\s+week)\b/i;
const DATE_OR_TIME_PATTERN = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s*\d{1,2}\b|\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)\b/i;
const RRF_K = 60;
const AUTHORITATIVE_RRF_WEIGHT = 3;

function rawTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\//g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function correctDomainToken(token: string): string {
  if (DOMAIN_TERMS.includes(token)) return token;
  let best = token;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of DOMAIN_TERMS) {
    const distance = editDistance(token, candidate);
    const allowed = token.length >= 6 ? 2 : 1;
    if (distance <= allowed && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

export function getDomainCorrections(question: string): Array<{ from: string; to: string }> {
  return rawTokens(question)
    .map((token) => ({ from: token, to: correctDomainToken(token) }))
    .filter((correction) => correction.from !== correction.to);
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

export function normalizeRetrievalQuery(question: string): string {
  const focusedTerms = selectLexicalSearchTerms(question);
  return (focusedTerms.length ? focusedTerms : rawTokens(question).map(correctDomainToken)).join(' OR ');
}

export function selectLexicalSearchTerms(question: string, limit = 8, referenceDate = new Date()): string[] {
  const corrected = rawTokens(question).map(correctDomainToken);
  const intentTerms = EVENT_INTENT_PATTERN.test(question) ? ['events'] : [];
  const subjectTerms = corrected.filter((token) => !GENERIC_SEARCH_WORDS.has(token));
  const synonymTerms = subjectTerms.flatMap((token) => SYNONYMS[token] ?? []);
  return [...new Set([...intentTerms, ...subjectTerms, ...synonymTerms, ...monthTerms(question, referenceDate)])]
    .slice(0, limit);
}

function fieldContains(field: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}${term.length > 3 ? 's?' : ''}\\b`, 'i').test(field);
}

export function calculateLexicalScore(question: string, chunk: MatchDocument): number {
  const terms = selectLexicalSearchTerms(question);
  if (!terms.length) return 0;
  const path = new URL(chunk.url).pathname.replace(/[-_/]+/g, ' ');
  const fields = [
    { value: chunk.title || '', weight: 0.9 },
    { value: path, weight: 0.85 },
    { value: chunk.section || '', weight: 0.7 },
    { value: chunk.content.slice(0, 2_000), weight: 0.35 },
  ];
  const matched = terms.reduce((total, term) => {
    const best = Math.max(0, ...fields.filter((field) => fieldContains(field.value, term)).map((field) => field.weight));
    return total + best;
  }, 0);
  const coverage = matched / terms.length;
  const meaningfulPhrase = terms.filter((term) => term.length > 3).join(' ');
  const titleOrPath = `${chunk.title || ''} ${path}`.toLowerCase();
  const phraseBonus = meaningfulPhrase.length > 3 && titleOrPath.includes(meaningfulPhrase) ? 0.1 : 0;
  const firstPathSegment = new URL(chunk.url).pathname.split('/').filter(Boolean)[0]?.replace(/s$/, '') ?? '';
  const collectionBonus = terms.some((term) => firstPathSegment === term.replace(/s$/, '')) ? 0.15 : 0;
  return Math.min(1, coverage + phraseBonus + collectionBonus);
}

export function calculateTemporalEvidenceScore(question: string, chunk: MatchDocument): number {
  if (!TEMPORAL_QUESTION_PATTERN.test(question)) return 0;
  const evidence = `${chunk.section || ''} ${chunk.content}`;
  let score = DATE_OR_TIME_PATTERN.test(evidence) ? 1 : 0;
  const requestedMonths = monthTerms(question, new Date());
  if (requestedMonths.some((term) => new RegExp(`\\b${term}\\b`, 'i').test(evidence))) score += 0.5;
  return score;
}

function compareLexicalEvidence(question: string, left: MatchDocument, right: MatchDocument): number {
  const lexicalDifference = (right.lexicalScore ?? 0) - (left.lexicalScore ?? 0);
  if (lexicalDifference !== 0) return lexicalDifference;
  return calculateTemporalEvidenceScore(question, right) - calculateTemporalEvidenceScore(question, left);
}

function uniqueById(candidates: MatchDocument[]): MatchDocument[] {
  return [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
}

function normalizedVectorConfidence(similarity: number | null): number {
  if (similarity === null) return 0;
  return Math.max(0, Math.min(1, (similarity - 0.25) / 0.3));
}

function candidateConfidence(candidate: MatchDocument, origins: RetrievalOrigin[]): number {
  const vector = normalizedVectorConfidence(origins.includes('vector') ? candidate.similarity : null);
  const lexical = origins.includes('lexical') ? candidate.lexicalScore ?? 0 : 0;
  const authoritative = origins.includes('authoritative') ? 0.9 : 0;
  const corroboration = origins.length >= 2 ? 0.08 : 0;
  return Math.min(1, Math.max(vector, lexical, authoritative) + corroboration);
}

export function fuseRetrievalCandidates(
  question: string,
  vectorCandidates: MatchDocument[],
  lexicalCandidates: MatchDocument[],
  authoritativeCandidates: MatchDocument[] = [],
  limit = 5,
  maxChunksPerUrl = 2
): RetrievalResult {
  const vector = uniqueById(vectorCandidates).map((candidate, index) => ({ ...candidate, vectorRank: index + 1 }));
  const lexical = uniqueById(lexicalCandidates)
    .map((candidate) => ({
      ...candidate,
      lexicalMatch: true,
      lexicalScore: candidate.lexicalScore ?? calculateLexicalScore(question, candidate),
    }))
    .filter((candidate) => (candidate.lexicalScore ?? 0) > 0)
    .sort((left, right) => compareLexicalEvidence(question, left, right))
    .map((candidate, index) => ({ ...candidate, lexicalRank: index + 1 }));
  const authoritative = uniqueById(authoritativeCandidates)
    .map((candidate) => ({
      ...candidate,
      lexicalScore: candidate.lexicalScore ?? calculateLexicalScore(question, candidate),
    }))
    .sort((left, right) => compareLexicalEvidence(question, left, right))
    .map((candidate, index) => ({ ...candidate, authoritativeRank: index + 1 }));

  const merged = new Map<string, MatchDocument>();
  const add = (candidate: MatchDocument, origin: RetrievalOrigin, rank: number, weight: number) => {
    const existing = merged.get(candidate.id) ?? { ...candidate, finalScore: 0, retrievalOrigins: [] };
    const origins = new Set(existing.retrievalOrigins ?? []);
    origins.add(origin);
    existing.retrievalOrigins = [...origins];
    existing.finalScore = (existing.finalScore ?? 0) + weight / (RRF_K + rank);
    if (origin === 'vector') {
      existing.vectorRank = rank;
      existing.similarity = candidate.similarity;
    }
    if (origin === 'lexical') {
      existing.lexicalRank = rank;
      existing.lexicalScore = candidate.lexicalScore;
      existing.lexicalMatch = true;
    }
    if (origin === 'authoritative') existing.authoritativeRank = rank;
    merged.set(candidate.id, existing);
  };

  vector.forEach((candidate, index) => add(candidate, 'vector', index + 1, 1));
  lexical.forEach((candidate, index) => add(candidate, 'lexical', index + 1, 1.1));
  authoritative.forEach((candidate, index) => add(candidate, 'authoritative', index + 1, AUTHORITATIVE_RRF_WEIGHT));

  const ranked = [...merged.values()]
    .map((candidate) => ({
      ...candidate,
      retrievalConfidence: candidateConfidence(candidate, candidate.retrievalOrigins ?? []),
    }))
    .sort((left, right) => (right.finalScore ?? 0) - (left.finalScore ?? 0));

  const selected: MatchDocument[] = [];
  const perUrl = new Map<string, number>();
  for (const candidate of ranked) {
    if ((perUrl.get(candidate.url) ?? 0) >= maxChunksPerUrl) continue;
    selected.push(candidate);
    perUrl.set(candidate.url, (perUrl.get(candidate.url) ?? 0) + 1);
    if (selected.length === limit) break;
  }

  const selectedIds = new Set(selected.map((candidate) => candidate.id));
  const diagnostics = ranked.map((candidate): RetrievalDiagnostic => ({
    id: candidate.id,
    url: candidate.url,
    origins: candidate.retrievalOrigins ?? [],
    vectorRank: candidate.vectorRank ?? null,
    vectorSimilarity: candidate.retrievalOrigins?.includes('vector') ? candidate.similarity : null,
    lexicalRank: candidate.lexicalRank ?? null,
    lexicalScore: candidate.lexicalScore ?? 0,
    authoritativeRank: candidate.authoritativeRank ?? null,
    reciprocalRankScore: candidate.finalScore ?? 0,
    confidence: candidate.retrievalConfidence ?? 0,
    selected: selectedIds.has(candidate.id),
  }));

  return {
    chunks: selected,
    confidence: selected[0]?.retrievalConfidence ?? 0,
    diagnostics,
  };
}

export function mergeRetrievalCandidates(
  vectorCandidates: MatchDocument[],
  lexicalCandidates: MatchDocument[]
): MatchDocument[] {
  const merged = new Map(vectorCandidates.map((candidate) => [candidate.id, { ...candidate }]));
  for (const candidate of lexicalCandidates) {
    const existing = merged.get(candidate.id);
    if (existing) Object.assign(existing, candidate, { similarity: existing.similarity, lexicalMatch: true });
    else merged.set(candidate.id, { ...candidate, lexicalMatch: true });
  }
  return [...merged.values()];
}

export function rerankChunks(question: string, chunks: MatchDocument[], limit = 5): MatchDocument[] {
  const vector = [...chunks].sort((left, right) => right.similarity - left.similarity);
  const lexical = chunks.filter((candidate) => candidate.lexicalMatch || calculateLexicalScore(question, candidate) > 0);
  return fuseRetrievalCandidates(question, vector, lexical, [], limit).chunks;
}
