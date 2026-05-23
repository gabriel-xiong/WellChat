import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MIN_SIMILARITY_THRESHOLD = Number(process.env.MIN_SIMILARITY_THRESHOLD ?? '0.75');
const ESCALATION_CONTACT = process.env.ESCALATION_CONTACT || 'The Well directly';

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

const FALLBACK_ANSWER = `I can't answer that based on what I know. Please contact us directly at at ${ESCALATION_CONTACT}.`;
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

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface MatchDocument {
  id: string;
  url: string;
  title: string | null;
  section: string | null;
  content: string;
  depth: string | null;
  last_indexed_at: string | null;
  similarity: number;
}

interface Source {
  title: string;
  url: string;
}

function assertEnv(): void {
  if (!SUPABASE_URL) throw new Error('NEXT_PUBLIC_SUPABASE_URL is required.');
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required.');
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required.');
}

function includesKeyword(question: string, keywords: string[]): boolean {
  const normalizedQuestion = question.toLowerCase();
  return keywords.some((keyword) => normalizedQuestion.includes(keyword));
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

async function generateAnswer(question: string, chunks: MatchDocument[]): Promise<string> {
  const context = buildContext(chunks);
  const currentDate = new Date().toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
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
        {
          role: 'user',
          content: `Today's date is ${currentDate}.

Question:
${question}

Retrieved context:
${context}

Answer using only the retrieved context. Include source URLs used in the answer.`,
        },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI chat request failed: ${response.status} ${response.statusText} - ${body}`);
  }

  const payload = await response.json() as ChatCompletionResponse;
  return payload.choices?.[0]?.message?.content?.trim() || FALLBACK_ANSWER;
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as ChatRequestBody;
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) {
      return Response.json({ error: 'question is required' }, { status: 400 });
    }

    if (includesKeyword(question, CRISIS_KEYWORDS)) {
      return Response.json({ answer: CRISIS_ANSWER, sources: [], fallback_triggered: true });
    }

    assertEnv();

    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false },
    });
    const questionEmbedding = await embedQuestion(question);
    const { data, error } = await supabase.rpc('match_documents', {
      query_embedding: questionEmbedding,
      similarity_threshold: MIN_SIMILARITY_THRESHOLD,
      limit_count: 5,
    });

    if (error) throw new Error(`Supabase match_documents failed: ${error.message}`);

    const chunks = (data ?? []) as MatchDocument[];
    const topSimilarity = chunks[0]?.similarity ?? 0;
    const fallbackTriggered = chunks.length === 0 || topSimilarity < MIN_SIMILARITY_THRESHOLD;
    const answer = fallbackTriggered && includesKeyword(question, PASTORAL_KEYWORDS)
      ? PASTORAL_FALLBACK_ANSWER
      : fallbackTriggered
        ? FALLBACK_ANSWER
        : await generateAnswer(question, chunks);
    const sources = fallbackTriggered ? [] : extractMarkdownSources(answer);

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

    return Response.json({ answer, sources, fallback_triggered: fallbackTriggered });
  } catch (error) {
    console.error(error);
    return Response.json(
      { error: 'Unable to process chat request.' },
      { status: 500 }
    );
  }
}
