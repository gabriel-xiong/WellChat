import { createClient } from '@supabase/supabase-js';
import { MatchDocument, rerankChunks } from '@/lib/retrieval';
import { getSuggestedAnswerCacheKey } from '@/lib/chat-suggestions';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MIN_SIMILARITY_THRESHOLD = Number(process.env.MIN_SIMILARITY_THRESHOLD ?? '0.25');
const ESCALATION_CONTACT = process.env.ESCALATION_CONTACT || 'The Well directly';
const MAX_QUESTION_LENGTH = 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;
const SUGGESTED_ANSWER_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
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
  'hurt myself',
  'kill myself',
  'suicide',
  'end my life',
  'self-harm',
  'hurting myself',
  'want to die',
];
const PASTORAL_KEYWORDS = [
  'spiritual advice',
  'pray for me',
  'need to talk',
  'need someone to talk to',
  'struggling',
  'counseling',
  'personal',
  'going through something',
];

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

function assertEnv(): void {
  if (!SUPABASE_URL) throw new Error('NEXT_PUBLIC_SUPABASE_URL is required.');
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required.');
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required.');
  if (!RATE_LIMIT_REDIS_URL) throw new Error('KV_REST_API_URL or UPSTASH_REDIS_REST_URL is required.');
  if (!RATE_LIMIT_REDIS_TOKEN) throw new Error('KV_REST_API_TOKEN or UPSTASH_REDIS_REST_TOKEN is required.');
}

function includesKeyword(question: string, keywords: string[]): boolean {
  const normalizedQuestion = question.toLowerCase();
  return keywords.some((keyword) => normalizedQuestion.includes(keyword));
}

function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  return forwardedFor?.split(',')[0]?.trim() || 'unknown';
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

function getSupabaseClient() {
  if (!supabaseClient) {
    supabaseClient = createSupabaseClient();
  }

  return supabaseClient;
}

async function embedQuestion(question: string): Promise<number[]> {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: question }),
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

function cachedAnswerResponse(answer: string, logQuery: (answer: string) => Promise<void>): Response {
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
    },
  });
}

async function streamAnswer(
  question: string,
  chunks: MatchDocument[],
  completeAnswer: (answer: string) => Promise<void>
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
          await completeAnswer(answer.trim() || FALLBACK_ANSWER);
        } catch (error) {
          console.error('Failed to finalize streamed chat query:', error);
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Chat-Cache': 'MISS',
    },
  });
}

export async function POST(request: Request) {
  try {
    const clientIp = getClientIp(request);
    const rateLimit = await checkRateLimit(clientIp);
    if (!rateLimit.allowed) {
      const retryAfterSeconds = Math.max(Math.ceil((rateLimit.resetAt - Date.now()) / 1000), 1);

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
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) {
      return Response.json({ error: 'question is required' }, { status: 400 });
    }

    if (question.length > MAX_QUESTION_LENGTH) {
      return Response.json(
        { error: `question must be ${MAX_QUESTION_LENGTH} characters or fewer` },
        { status: 400 }
      );
    }

    if (includesKeyword(question, CRISIS_KEYWORDS)) {
      return Response.json({ answer: CRISIS_ANSWER, sources: [], fallback_triggered: true });
    }

    assertEnv();

    const supabase = getSupabaseClient();
    const suggestedAnswerCacheKey = getSuggestedAnswerCacheKey(question);
    const cachedAnswer = suggestedAnswerCacheKey
      ? await getCachedAnswer(suggestedAnswerCacheKey)
      : null;

    if (cachedAnswer) {
      const logCachedQuery = async (answer: string) => {
        const { error: logError } = await supabase.from('query_logs').insert({
          question,
          retrieved_chunk_ids: [],
          retrieved_urls: [],
          retrieved_titles: [],
          similarity_scores: [],
          answer,
          fallback_triggered: false,
        });

        if (logError) {
          console.error('Failed to log cached chat query:', logError.message);
        }
      };

      return cachedAnswerResponse(cachedAnswer, logCachedQuery);
    }

    const questionEmbedding = await embedQuestion(question);
    const { data, error } = await supabase.rpc('match_documents', {
      query_embedding: questionEmbedding,
      similarity_threshold: MIN_SIMILARITY_THRESHOLD,
      limit_count: 12,
    });

    if (error) throw new Error(`Supabase match_documents failed: ${error.message}`);

    const chunks = rerankChunks(question, (data ?? []) as MatchDocument[]);

    const topSimilarity = chunks[0]?.similarity ?? 0;
    const fallbackTriggered = chunks.length === 0 || topSimilarity < MIN_SIMILARITY_THRESHOLD;
    const logQuery = async (answer: string) => {
      const { error: logError } = await supabase.from('query_logs').insert({
        question,
        retrieved_chunk_ids: chunks.map((chunk) => chunk.id),
        retrieved_urls: chunks.map((chunk) => chunk.url),
        retrieved_titles: chunks.map((chunk) => chunk.title || 'Untitled Page'),
        similarity_scores: chunks.map((chunk) => chunk.similarity),
        answer,
        fallback_triggered: fallbackTriggered,
      });

      if (logError) {
        console.error('Failed to log chat query:', logError.message);
      }
    };

    if (!fallbackTriggered) {
      const completeAnswer = async (answer: string) => {
        const tasks: Promise<unknown>[] = [logQuery(answer)];
        if (suggestedAnswerCacheKey) {
          tasks.push(setCachedAnswer(suggestedAnswerCacheKey, answer));
        }

        const results = await Promise.allSettled(tasks);
        for (const result of results) {
          if (result.status === 'rejected') {
            console.error('Failed to finalize chat answer:', result.reason);
          }
        }
      };

      return streamAnswer(question, chunks, completeAnswer);
    }

    const answer = includesKeyword(question, PASTORAL_KEYWORDS) ? PASTORAL_FALLBACK_ANSWER : FALLBACK_ANSWER;
    const sources = extractMarkdownSources(answer);

    await logQuery(answer);

    return Response.json({ answer, sources, fallback_triggered: fallbackTriggered });
  } catch (error) {
    console.error(error);
    return Response.json(
      { error: 'Unable to process chat request.' },
      { status: 500 }
    );
  }
}
