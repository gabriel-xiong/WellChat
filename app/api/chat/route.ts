import { createClient } from '@supabase/supabase-js';
import { after } from 'next/server';
import { MatchDocument, rerankChunks } from '@/lib/retrieval';
import { getSuggestedAnswerCacheKey } from '@/lib/chat-suggestions';
import { classifyQuestion } from '@/lib/chat-analytics';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MIN_SIMILARITY_THRESHOLD = Number(process.env.MIN_SIMILARITY_THRESHOLD ?? '0.25');
const ESCALATION_CONTACT = process.env.ESCALATION_CONTACT || 'The Well directly';
const MAX_QUESTION_LENGTH = 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;
const SUGGESTED_ANSWER_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const SEMANTIC_CACHE_TTL_SECONDS = Number(process.env.SEMANTIC_CACHE_TTL_SECONDS ?? 7 * 24 * 60 * 60);
const SEMANTIC_CACHE_THRESHOLD = Number(process.env.SEMANTIC_CACHE_THRESHOLD ?? '0.94');
const DEDUPLICATION_LOCK_SECONDS = 45;
const DEDUPLICATION_RESULT_SECONDS = 30;
const DEDUPLICATION_WAIT_MS = 12_000;
const RATE_LIMIT_REDIS_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL)?.replace(/\/+$/, '');
const RATE_LIMIT_REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return {count, ttl}
`;
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

function createSupabaseClient() {
  return createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
}

let supabaseClient: ReturnType<typeof createSupabaseClient> | null = null;

const SYSTEM_PROMPT = `You are a website assistant for The Well Austin Community Church.
Your job is to help visitors find practical information from
approved church content.

Answer only from the provided context. If the answer is not
available, say you don't know based on the available website
information and suggest contacting The Well directly at
${ESCALATION_CONTACT}.

Always include a source link when answering.

Speak in first person as The Well — use 'we', 'our', and 'us' rather than 'they' or 'their'.

For shallow-indexed pages like community groups, sermons, stories,
and podcast, provide a brief description and link to the page
rather than attempting detailed answers.

For questions about what The Well believes, answer factually
from the provided content. Do not give personal spiritual advice,
make theological recommendations, or tell someone what they
should believe or do.

Do not act as a pastor, counselor, or spiritual authority. For
pastoral care, counseling, or sensitive personal situations,
route to a real person at ${ESCALATION_CONTACT}.

If someone expresses a mental health crisis or self-harm risk,
direct them to emergency services (911) or the 988 Suicide and
Crisis Lifeline immediately.

Do not invent service times, staff names, event details, or
church policies.`;

const FALLBACK_ANSWER = `I can't answer that based on what I know. Please contact us directly at ${ESCALATION_CONTACT}.`;
const CRISIS_ANSWER = `If you are in crisis or having thoughts of harming yourself, please call 911 or the 988 Suicide and Crisis Lifeline (call or text 988) immediately. You can also reach out to our team at ${ESCALATION_CONTACT}.`;
const PASTORAL_FALLBACK_ANSWER = `It sounds like you may be looking for personal support. We'd encourage you to reach out to our team directly — we'd love to connect you with someone who can help. Contact us at ${ESCALATION_CONTACT}.`;
const CRISIS_KEYWORDS = [
  'harm myself',
  'harming myself',
  'hurt myself',
  'kill myself',
  'suicide',
  'suicidal',
  'end my life',
  'take my own life',
  'self-harm',
  'self harm',
  'hurting myself',
  'want to die',
  "don't want to live",
  'dont want to live',
];
const PASTORAL_KEYWORDS = [
  'pastoral care',
  'spiritual advice',
  'pray for me',
  'need prayer',
  'need to talk',
  'need someone to talk to',
  'talk to someone',
  'struggling',
  'counseling',
  'personal',
  'going through something',
];
const TIME_SENSITIVE_KEYWORDS = [
  'today',
  'tomorrow',
  'tonight',
  'this week',
  'next week',
  'current',
  'latest',
  'upcoming',
  'event',
  'events',
  'calendar',
];

const APPROVED_RESOURCE_LINKS = [
  { title: 'Sundays With Us', url: 'https://thewellaustin.com/sundays', keywords: ['sunday', 'service', 'worship', 'visit', 'location', 'parking'] },
  { title: 'Community Groups', url: 'https://thewellaustin.com/community', keywords: ['community', 'group', 'connect'] },
  { title: 'Serve', url: 'https://thewellaustin.com/serve', keywords: ['serve', 'volunteer', 'team'] },
  { title: 'Giving', url: 'https://thewellaustin.com/giving', keywords: ['give', 'giving', 'donate', 'stock', 'crypto'] },
  { title: 'Ministries', url: 'https://thewellaustin.com/ministries', keywords: ['ministry', 'kids', 'children', 'youth'] },
  { title: 'What We Believe', url: 'https://thewellaustin.com/beliefs', keywords: ['believe', 'belief', 'scripture', 'doctrine', 'faith'] },
  { title: 'Our Team', url: 'https://thewellaustin.com/team', keywords: ['team', 'staff', 'pastor', 'contact'] },
  { title: 'Events', url: 'https://thewellaustin.com/events', keywords: ['event', 'calendar', 'upcoming'] },
  { title: 'Sermons', url: 'https://thewellaustin.com/sermons', keywords: ['sermon', 'message', 'teaching'] },
  { title: 'Podcast', url: 'https://thewellaustin.com/podcast', keywords: ['podcast'] },
  { title: 'Mission and Vision', url: 'https://thewellaustin.com/mission', keywords: ['mission', 'vision', 'values'] },
  { title: 'International Missions', url: 'https://thewellaustin.com/missions', keywords: ['international', 'missions', 'trip'] },
] as const;

interface ChatRequestBody {
  question?: unknown;
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

interface Source {
  title: string;
  url: string;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

interface DeduplicationLease {
  lockKey: string;
  resultKey: string;
  token: string;
}

interface SemanticCacheMatch {
  id: string;
  question: string;
  answer: string;
  retrieved_chunk_ids: string[] | null;
  retrieved_urls: string[] | null;
  retrieved_titles: string[] | null;
  similarity: number;
}

interface RetrievedTrace {
  chunkIds: string[];
  urls: string[];
  titles: string[];
  similarities: number[];
}

interface LocalRateBucket {
  count: number;
  resetAt: number;
}

const localRateBuckets = new Map<string, LocalRateBucket>();

function assertEnv(): void {
  if (!SUPABASE_URL) throw new Error('NEXT_PUBLIC_SUPABASE_URL is required.');
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required.');
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required.');
}

function includesKeyword(question: string, keywords: string[]): boolean {
  const normalizedQuestion = question.toLowerCase();
  return keywords.some((keyword) => normalizedQuestion.includes(keyword));
}

function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  return forwardedFor?.split(',')[0]?.trim() || 'unknown';
}

function checkLocalRateLimit(ip: string): RateLimitResult {
  const now = Date.now();
  const current = localRateBuckets.get(ip);
  const bucket = !current || current.resetAt <= now
    ? { count: 1, resetAt: now + RATE_LIMIT_WINDOW_SECONDS * 1000 }
    : { count: current.count + 1, resetAt: current.resetAt };
  localRateBuckets.set(ip, bucket);

  if (localRateBuckets.size > 1000) {
    for (const [key, value] of localRateBuckets) {
      if (value.resetAt <= now) localRateBuckets.delete(key);
    }
  }

  return {
    allowed: bucket.count <= RATE_LIMIT_MAX_REQUESTS,
    remaining: Math.max(RATE_LIMIT_MAX_REQUESTS - bucket.count, 0),
    resetAt: bucket.resetAt,
  };
}

async function redisCommand<T>(command: Array<string | number>): Promise<T> {
  if (!RATE_LIMIT_REDIS_URL) throw new Error('KV_REST_API_URL or UPSTASH_REDIS_REST_URL is required.');
  if (!RATE_LIMIT_REDIS_TOKEN) throw new Error('KV_REST_API_TOKEN or UPSTASH_REDIS_REST_TOKEN is required.');

  const response = await fetch(RATE_LIMIT_REDIS_URL!, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RATE_LIMIT_REDIS_TOKEN!}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
    cache: 'no-store',
    signal: AbortSignal.timeout(3_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Rate limit store request failed: ${response.status} ${response.statusText} - ${body}`);
  }

  const payload = await response.json() as { result?: T; error?: string };
  if (payload.error) throw new Error(`Rate limit store error: ${payload.error}`);
  return payload.result as T;
}

async function checkRateLimit(ip: string): Promise<RateLimitResult> {
  const key = `rate-limit:chat:${ip}`;
  const [count, ttl] = await redisCommand<[number, number]>([
    'EVAL',
    RATE_LIMIT_SCRIPT,
    1,
    key,
    RATE_LIMIT_WINDOW_SECONDS,
  ]);
  const resetAt = Date.now() + Math.max(ttl, 0) * 1000;

  return {
    allowed: count <= RATE_LIMIT_MAX_REQUESTS,
    remaining: Math.max(RATE_LIMIT_MAX_REQUESTS - count, 0),
    resetAt,
  };
}

async function checkRateLimitResilient(ip: string): Promise<RateLimitResult> {
  if (!RATE_LIMIT_REDIS_URL || !RATE_LIMIT_REDIS_TOKEN) return checkLocalRateLimit(ip);

  try {
    return await checkRateLimit(ip);
  } catch (error) {
    console.error('Distributed rate limiter unavailable; using local fallback:', error);
    return checkLocalRateLimit(ip);
  }
}

async function getCachedAnswer(cacheKey: string): Promise<string | null> {
  return redisCommand<string | null>(['GET', `chat-answer:${cacheKey}`]);
}

async function setCachedAnswer(cacheKey: string, answer: string): Promise<void> {
  await redisCommand<string>([
    'SET',
    `chat-answer:${cacheKey}`,
    answer,
    'EX',
    SUGGESTED_ANSWER_CACHE_TTL_SECONDS,
  ]);
}

async function hashQuestion(question: string): Promise<string> {
  const normalized = question.toLowerCase().replace(/\s+/g, ' ').trim();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function acquireDeduplicationLease(question: string): Promise<DeduplicationLease | null> {
  if (!RATE_LIMIT_REDIS_URL || !RATE_LIMIT_REDIS_TOKEN) return null;
  const hash = await hashQuestion(question);
  const lease: DeduplicationLease = {
    lockKey: `chat-inflight:${hash}`,
    resultKey: `chat-inflight-result:${hash}`,
    token: crypto.randomUUID(),
  };
  const result = await redisCommand<string | null>([
    'SET',
    lease.lockKey,
    lease.token,
    'NX',
    'EX',
    DEDUPLICATION_LOCK_SECONDS,
  ]);
  return result === 'OK' ? lease : null;
}

async function waitForDeduplicatedAnswer(question: string): Promise<string | null> {
  if (!RATE_LIMIT_REDIS_URL || !RATE_LIMIT_REDIS_TOKEN) return null;
  const hash = await hashQuestion(question);
  const resultKey = `chat-inflight-result:${hash}`;
  const deadline = Date.now() + DEDUPLICATION_WAIT_MS;
  let pollDelayMs = 200;

  while (Date.now() < deadline) {
    const answer = await redisCommand<string | null>(['GET', resultKey]);
    if (answer) return answer;
    await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
    pollDelayMs = Math.min(Math.round(pollDelayMs * 1.5), 1_000);
  }

  return null;
}

async function publishDeduplicatedAnswer(lease: DeduplicationLease | null, answer: string): Promise<void> {
  if (!lease) return;
  await Promise.allSettled([
    redisCommand<string>(['SET', lease.resultKey, answer, 'EX', DEDUPLICATION_RESULT_SECONDS]),
    redisCommand<number>(['EVAL', RELEASE_LOCK_SCRIPT, 1, lease.lockKey, lease.token]),
  ]);
}

async function releaseDeduplicationLease(lease: DeduplicationLease | null): Promise<void> {
  if (!lease) return;
  try {
    await redisCommand<number>(['EVAL', RELEASE_LOCK_SCRIPT, 1, lease.lockKey, lease.token]);
  } catch (error) {
    console.error('Failed to release request deduplication lock:', error);
  }
}

function getSupabaseClient() {
  if (!supabaseClient) {
    supabaseClient = createSupabaseClient();
  }

  return supabaseClient;
}

function isSemanticCacheEligible(question: string): boolean {
  if (includesKeyword(question, CRISIS_KEYWORDS)) return false;
  if (includesKeyword(question, PASTORAL_KEYWORDS)) return false;
  if (includesKeyword(question, TIME_SENSITIVE_KEYWORDS)) return false;
  if (/\b(i|i'm|i’ve|my|mine|me)\b/i.test(question)) return false;
  return question.length >= 8;
}

async function getActiveCorpusVersion(): Promise<string | null> {
  const { data, error } = await getSupabaseClient()
    .from('rag_corpus_state')
    .select('active_version')
    .eq('singleton', true)
    .maybeSingle();
  if (error) {
    console.warn('Semantic cache disabled because corpus state is unavailable:', error.message);
    return null;
  }
  return typeof data?.active_version === 'string' ? data.active_version : null;
}

async function findSemanticCachedAnswer(
  question: string,
  embedding: number[],
  corpusVersion: string
): Promise<SemanticCacheMatch | null> {
  const { data, error } = await getSupabaseClient().rpc('match_semantic_answer_cache', {
    query_embedding: embedding,
    requested_corpus_version: corpusVersion,
    match_threshold: SEMANTIC_CACHE_THRESHOLD,
  });
  if (error) {
    console.warn('Semantic cache lookup skipped:', error.message);
    return null;
  }
  const match = ((data as SemanticCacheMatch[] | null) ?? [])
    .find((candidate) => isSemanticMatchSafe(question, candidate.question)) ?? null;
  if (match) {
    void getSupabaseClient().rpc('record_semantic_cache_hit', { cache_id: match.id });
  }
  return match;
}

function isSemanticMatchSafe(question: string, cachedQuestion: string): boolean {
  const numberTokens = (value: string) => [...value.matchAll(/\b\d+(?::\d+)?\b/g)].map((match) => match[0]).sort();
  const hasNegation = (value: string) => /\b(no|not|never|without|can't|cannot|don't|doesn't|isn't|aren't)\b/i.test(value);
  const leftNumbers = numberTokens(question);
  const rightNumbers = numberTokens(cachedQuestion);
  return hasNegation(question) === hasNegation(cachedQuestion)
    && JSON.stringify(leftNumbers) === JSON.stringify(rightNumbers)
    && classifyQuestion(question) === classifyQuestion(cachedQuestion);
}

async function storeSemanticCachedAnswer(entry: {
  question: string;
  embedding: number[];
  answer: string;
  corpusVersion: string;
  chunks: MatchDocument[];
}): Promise<void> {
  const sources = extractMarkdownSources(entry.answer);
  const retrievedUrls = new Set(entry.chunks.map((chunk) => chunk.url.replace(/\/+$/, '')));
  const citationsAreGrounded = sources.length > 0
    && sources.every((source) => retrievedUrls.has(source.url.replace(/\/+$/, '')));
  if (!citationsAreGrounded) return;

  const expiresAt = new Date(Date.now() + SEMANTIC_CACHE_TTL_SECONDS * 1000).toISOString();
  const { error } = await getSupabaseClient().from('semantic_answer_cache').insert({
    question: entry.question,
    question_embedding: entry.embedding,
    answer: entry.answer,
    retrieved_chunk_ids: entry.chunks.map((chunk) => chunk.id),
    retrieved_urls: entry.chunks.map((chunk) => chunk.url),
    retrieved_titles: entry.chunks.map((chunk) => chunk.title || 'Untitled Page'),
    corpus_version: entry.corpusVersion,
    expires_at: expiresAt,
  });
  if (error) console.warn('Failed to store semantic cache entry:', error.message);
}

function traceFromChunks(chunks: MatchDocument[]): RetrievedTrace {
  return {
    chunkIds: chunks.map((chunk) => chunk.id),
    urls: chunks.map((chunk) => chunk.url),
    titles: chunks.map((chunk) => chunk.title || 'Untitled Page'),
    similarities: chunks.map((chunk) => chunk.similarity),
  };
}

function selectFallbackSources(question: string, chunks: MatchDocument[] = []): Source[] {
  const uniqueSources = new Map<string, Source>();
  for (const chunk of chunks) {
    if (!uniqueSources.has(chunk.url)) {
      uniqueSources.set(chunk.url, { title: chunk.title || 'The Well Austin resource', url: chunk.url });
    }
    if (uniqueSources.size >= 3) return Array.from(uniqueSources.values());
  }

  const normalized = question.toLowerCase();
  for (const resource of APPROVED_RESOURCE_LINKS) {
    if (resource.keywords.some((keyword) => normalized.includes(keyword))) {
      uniqueSources.set(resource.url, { title: resource.title, url: resource.url });
    }
    if (uniqueSources.size >= 3) break;
  }

  if (!uniqueSources.size) {
    for (const resource of [APPROVED_RESOURCE_LINKS[0], APPROVED_RESOURCE_LINKS[1], APPROVED_RESOURCE_LINKS[6]]) {
      uniqueSources.set(resource.url, { title: resource.title, url: resource.url });
    }
  }
  return Array.from(uniqueSources.values());
}

function buildDegradedAnswer(question: string, chunks: MatchDocument[] = []): { answer: string; sources: Source[] } {
  const sources = selectFallbackSources(question, chunks);
  const links = sources.map((source) => `- [${source.title}](${source.url})`).join('\n');
  return {
    answer: `I'm having trouble generating a full answer right now, but these approved pages may help:\n\n${links}\n\nFor direct help, please contact us at ${ESCALATION_CONTACT}.`,
    sources,
  };
}

function degradedResponse(
  question: string,
  queryId: string,
  reason: string,
  chunks: MatchDocument[] = []
): Response {
  const fallback = buildDegradedAnswer(question, chunks);
  return Response.json(
    {
      answer: fallback.answer,
      sources: fallback.sources,
      fallback_triggered: true,
      query_id: queryId,
    },
    {
      headers: {
        'Cache-Control': 'no-store',
        'X-Chat-Degraded': reason,
        'X-Query-Id': queryId,
      },
    }
  );
}

async function embedQuestion(question: string): Promise<number[]> {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: question }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI embedding request failed: ${response.status} ${response.statusText} - ${body}`);
  }

  const payload = await response.json() as EmbeddingResponse;
  const embedding = payload.data?.[0]?.embedding;
  if (!embedding) throw new Error('OpenAI embedding response did not include an embedding.');
  return embedding;
}

function buildContext(chunks: MatchDocument[]): string {
  return chunks.map((chunk, index) => {
    const title = chunk.title || 'Untitled Page';
    const section = chunk.section || 'page';
    const indexedAt = chunk.last_indexed_at ? `\nLast indexed at: ${chunk.last_indexed_at}` : '';
    return `Source ${index + 1}
Title: ${title}
URL: ${chunk.url}
Section: ${section}
Depth: ${chunk.depth || 'unknown'}${indexedAt}
Content:
${chunk.content}`;
  }).join('\n\n---\n\n');
}

function extractMarkdownSources(answer: string): Source[] {
  const sources = new Map<string, Source>();

  for (const match of answer.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    const title = match[1]?.trim();
    const url = match[2]?.trim();
    if (title && url && !sources.has(url)) {
      sources.set(url, { title, url });
    }
  }

  return Array.from(sources.values());
}

function buildUserMessage(question: string, chunks: MatchDocument[]): string {
  const context = buildContext(chunks);
  const currentDate = new Date().toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return `Today's date is ${currentDate}.

Question:
${question}

Retrieved context:
${context}

Answer using only the retrieved context. Include source URLs used in the answer.`;
}

function cachedAnswerResponse(answer: string, queryId: string, logQuery: (answer: string) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(answer));
      controller.close();

      try {
        await logQuery(answer);
      } catch (error) {
        console.error('Failed to log cached chat query:', error);
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Chat-Cache': 'HIT',
      'X-Query-Id': queryId,
    },
  });
}

async function streamAnswer(
  question: string,
  chunks: MatchDocument[],
  queryId: string,
  completeAnswer: (answer: string, degraded?: boolean) => Promise<void>
): Promise<Response> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage(question, chunks) },
      ],
      temperature: 0.2,
      stream: true,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI chat request failed: ${response.status} ${response.statusText} - ${body}`);
  }

  if (!response.body) throw new Error('OpenAI chat response did not include a stream.');

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = response.body.getReader();
  let answer = '';

  const stream = new ReadableStream({
    async start(controller) {
      try {
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine.startsWith('data: ')) continue;

            const data = trimmedLine.slice(6);
            if (data === '[DONE]') continue;

            const payload = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
            const content = payload.choices?.[0]?.delta?.content;
            if (content) {
              answer += content;
              controller.enqueue(encoder.encode(content));
            }
          }
        }

        controller.close();

        try {
          await completeAnswer(answer.trim() || FALLBACK_ANSWER, false);
        } catch (error) {
          console.error('Failed to finalize streamed chat query:', error);
        }
      } catch (error) {
        console.error('Generation stream failed; returning approved resources:', error);
        const degraded = buildDegradedAnswer(question, chunks).answer;
        const suffix = answer.trim()
          ? `\n\nThe generated response was interrupted. You can still use these approved resources:\n\n${selectFallbackSources(question, chunks).map((source) => `- [${source.title}](${source.url})`).join('\n')}`
          : degraded;
        controller.enqueue(encoder.encode(suffix));
        controller.close();
        try {
          await completeAnswer(`${answer}${suffix}`.trim(), true);
        } catch (completionError) {
          console.error('Failed to finalize degraded chat query:', completionError);
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Chat-Cache': 'MISS',
      'X-Query-Id': queryId,
    },
  });
}

export async function POST(request: Request) {
  let deduplicationLease: DeduplicationLease | null = null;
  let question = '';
  let queryId = '';
  let category = 'general';

  try {
    const clientIp = getClientIp(request);
    const rateLimit = await checkRateLimitResilient(clientIp);
    if (!rateLimit.allowed) {
      const retryAfterSeconds = Math.max(Math.ceil((rateLimit.resetAt - Date.now()) / 1000), 1);

      after(() => logChatEvent('rate_limited'));

      return Response.json(
        { error: 'Too many requests. Please try again later.' },
        {
          status: 429,
          headers: {
            'Retry-After': String(retryAfterSeconds),
            'X-RateLimit-Limit': String(RATE_LIMIT_MAX_REQUESTS),
            'X-RateLimit-Remaining': String(rateLimit.remaining),
            'X-RateLimit-Reset': String(Math.ceil(rateLimit.resetAt / 1000)),
          },
        }
      );
    }

    const body = await request.json() as ChatRequestBody;
    question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) {
      return Response.json({ error: 'question is required' }, { status: 400 });
    }

    if (question.length > MAX_QUESTION_LENGTH) {
      return Response.json(
        { error: `question must be ${MAX_QUESTION_LENGTH} characters or fewer` },
        { status: 400 }
      );
    }

    queryId = crypto.randomUUID();
    category = classifyQuestion(question);

    if (includesKeyword(question, CRISIS_KEYWORDS)) {
      after(() => logStandaloneQuery({
        id: queryId,
        question,
        answer: CRISIS_ANSWER,
        category: 'crisis',
      }));
      return Response.json({ answer: CRISIS_ANSWER, sources: [], fallback_triggered: true, query_id: queryId });
    }

    assertEnv();

    const supabase = getSupabaseClient();
    const baseSuggestedAnswerCacheKey = getSuggestedAnswerCacheKey(question);
    const semanticCacheEligible = isSemanticCacheEligible(question);
    let corpusVersion = baseSuggestedAnswerCacheKey && semanticCacheEligible
      ? await getActiveCorpusVersion()
      : null;
    const suggestedAnswerCacheKey = baseSuggestedAnswerCacheKey
      ? `${baseSuggestedAnswerCacheKey}:${corpusVersion ?? 'legacy'}`
      : null;
    let cachedAnswer: string | null = null;
    if (suggestedAnswerCacheKey) {
      try {
        cachedAnswer = await getCachedAnswer(suggestedAnswerCacheKey);
      } catch (error) {
        console.error('Exact answer cache unavailable; continuing without it:', error);
      }
    }

    if (cachedAnswer) {
      const logCachedQuery = async (answer: string) => {
        const { error: logError } = await supabase.from('query_logs').insert({
          id: queryId,
          question,
          retrieved_chunk_ids: [],
          retrieved_urls: [],
          retrieved_titles: [],
          similarity_scores: [],
          answer,
          fallback_triggered: false,
          category,
          cache_hit: true,
        });

        if (logError) {
          console.error('Failed to log cached chat query:', logError.message);
        }
      };

      return cachedAnswerResponse(cachedAnswer, queryId, logCachedQuery);
    }

    if (RATE_LIMIT_REDIS_URL && RATE_LIMIT_REDIS_TOKEN) {
      try {
        deduplicationLease = await acquireDeduplicationLease(question);
        if (!deduplicationLease) {
          const sharedAnswer = await waitForDeduplicatedAnswer(question);
          if (sharedAnswer) {
            const logDeduplicatedQuery = async (answer: string) => {
              const { error: logError } = await supabase.from('query_logs').insert({
                id: queryId,
                question,
                retrieved_chunk_ids: [],
                retrieved_urls: [],
                retrieved_titles: [],
                similarity_scores: [],
                answer,
                fallback_triggered: false,
                category,
                cache_hit: true,
              });
              if (logError) console.error('Failed to log deduplicated query:', logError.message);
            };
            return cachedAnswerResponse(sharedAnswer, queryId, logDeduplicatedQuery);
          }
          deduplicationLease = await acquireDeduplicationLease(question);
        }
      } catch (error) {
        console.error('Request deduplication unavailable; continuing independently:', error);
        deduplicationLease = null;
      }
    }

    let questionEmbedding: number[];
    try {
      questionEmbedding = await embedQuestion(question);
    } catch (error) {
      console.error('Embedding unavailable; returning approved resources:', error);
      const fallback = buildDegradedAnswer(question);
      await Promise.allSettled([
        logStandaloneQuery({ id: queryId, question, answer: fallback.answer, category }),
        publishDeduplicatedAnswer(deduplicationLease, fallback.answer),
      ]);
      return degradedResponse(question, queryId, 'embedding_unavailable');
    }

    if (semanticCacheEligible && !corpusVersion) {
      corpusVersion = await getActiveCorpusVersion();
    }
    if (semanticCacheEligible && corpusVersion) {
      const semanticMatch = await findSemanticCachedAnswer(question, questionEmbedding, corpusVersion);
      if (semanticMatch) {
        const logSemanticCachedQuery = async (answer: string) => {
          const { error: logError } = await supabase.from('query_logs').insert({
            id: queryId,
            question,
            retrieved_chunk_ids: semanticMatch.retrieved_chunk_ids ?? [],
            retrieved_urls: semanticMatch.retrieved_urls ?? [],
            retrieved_titles: semanticMatch.retrieved_titles ?? [],
            similarity_scores: [],
            answer,
            fallback_triggered: false,
            category,
            cache_hit: true,
          });
          if (logError) console.error('Failed to log semantic cache hit:', logError.message);
        };
        await publishDeduplicatedAnswer(deduplicationLease, semanticMatch.answer);
        return cachedAnswerResponse(semanticMatch.answer, queryId, logSemanticCachedQuery);
      }
    }

    let data: unknown;
    try {
      const retrieval = await supabase.rpc('match_documents', {
        query_embedding: questionEmbedding,
        similarity_threshold: MIN_SIMILARITY_THRESHOLD,
        limit_count: 12,
      });
      if (retrieval.error) throw new Error(`Supabase match_documents failed: ${retrieval.error.message}`);
      data = retrieval.data;
    } catch (error) {
      console.error('Retrieval unavailable; returning approved resources:', error);
      const fallback = buildDegradedAnswer(question);
      await Promise.allSettled([
        logStandaloneQuery({ id: queryId, question, answer: fallback.answer, category }),
        publishDeduplicatedAnswer(deduplicationLease, fallback.answer),
      ]);
      return degradedResponse(question, queryId, 'retrieval_unavailable');
    }

    const chunks = rerankChunks(question, (data ?? []) as MatchDocument[]);

    const topSimilarity = chunks[0]?.similarity ?? 0;
    const fallbackTriggered = chunks.length === 0 || topSimilarity < MIN_SIMILARITY_THRESHOLD;
    const trace = traceFromChunks(chunks);
    const logQuery = async (answer: string, degraded = fallbackTriggered) => {
      const { error: logError } = await supabase.from('query_logs').insert({
        id: queryId,
        question,
        retrieved_chunk_ids: trace.chunkIds,
        retrieved_urls: trace.urls,
        retrieved_titles: trace.titles,
        similarity_scores: trace.similarities,
        answer,
        fallback_triggered: degraded,
        category,
        cache_hit: false,
      });

      if (logError) {
        console.error('Failed to log chat query:', logError.message);
      }
    };

    if (!fallbackTriggered) {
      const completeAnswer = async (answer: string, degraded = false) => {
        const tasks: Promise<unknown>[] = [
          logQuery(answer, degraded),
          publishDeduplicatedAnswer(deduplicationLease, answer),
        ];
        if (!degraded && suggestedAnswerCacheKey) {
          tasks.push(setCachedAnswer(suggestedAnswerCacheKey, answer));
        }
        if (!degraded && semanticCacheEligible && corpusVersion) {
          tasks.push(storeSemanticCachedAnswer({
            question,
            embedding: questionEmbedding,
            answer,
            corpusVersion,
            chunks,
          }));
        }

        const results = await Promise.allSettled(tasks);
        for (const result of results) {
          if (result.status === 'rejected') {
            console.error('Failed to finalize chat answer:', result.reason);
          }
        }
      };

      try {
        return await streamAnswer(question, chunks, queryId, completeAnswer);
      } catch (error) {
        console.error('Generation unavailable; returning retrieved resources:', error);
        const fallback = buildDegradedAnswer(question, chunks);
        await Promise.allSettled([
          logQuery(fallback.answer, true),
          publishDeduplicatedAnswer(deduplicationLease, fallback.answer),
        ]);
        return degradedResponse(question, queryId, 'generation_unavailable', chunks);
      }
    }

    const answer = includesKeyword(question, PASTORAL_KEYWORDS) ? PASTORAL_FALLBACK_ANSWER : FALLBACK_ANSWER;
    const sources = extractMarkdownSources(answer);

    await Promise.allSettled([
      logQuery(answer),
      publishDeduplicatedAnswer(deduplicationLease, answer),
    ]);

    return Response.json({ answer, sources, fallback_triggered: fallbackTriggered, query_id: queryId });
  } catch (error) {
    console.error(error);
    await releaseDeduplicationLease(deduplicationLease);
    after(() => logChatEvent('api_error'));
    if (question && queryId) {
      return degradedResponse(question, queryId, 'pipeline_unavailable');
    }
    return Response.json(
      { error: 'Unable to process chat request.' },
      { status: 500 }
    );
  }
}

async function logStandaloneQuery(entry: {
  id: string;
  question: string;
  answer: string;
  category: string;
}): Promise<void> {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
    const { error } = await getSupabaseClient().from('query_logs').insert({
      ...entry,
      retrieved_chunk_ids: [],
      retrieved_urls: [],
      retrieved_titles: [],
      similarity_scores: [],
      fallback_triggered: true,
      cache_hit: false,
    });
    if (error) console.error('Failed to log guarded chat query:', error.message);
  } catch (error) {
    console.error('Failed to log guarded chat query:', error);
  }
}

async function logChatEvent(eventType: 'rate_limited' | 'api_error', metadata: Record<string, unknown> = {}): Promise<void> {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
    const { error } = await getSupabaseClient().from('chat_events').insert({ event_type: eventType, metadata });
    if (error) console.error(`Failed to log ${eventType} event:`, error.message);
  } catch (error) {
    console.error(`Failed to log ${eventType} event:`, error);
  }
}
