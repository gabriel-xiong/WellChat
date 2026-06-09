import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MIN_SIMILARITY_THRESHOLD = Number(process.env.MIN_SIMILARITY_THRESHOLD ?? '0.25');
const ESCALATION_CONTACT = process.env.ESCALATION_CONTACT || 'The Well directly';
const MODEL = 'gpt-4o-mini';
const EMBEDDING_MODEL = 'text-embedding-3-small';
const TRIALS_PER_QUESTION = Number(process.env.BENCHMARK_TRIALS ?? '3');

const QUESTIONS = [
  'What time are Sunday services?',
  'Where is The Well Austin located?',
  'How can I join a community group?',
  'What does the church believe?',
  'How can I serve or volunteer?',
];

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

interface RetrievalResult {
  chunks: MatchDocument[];
  fallbackTriggered: boolean;
}

interface TrialResult {
  nonStreamingTotalMs: number;
  streamingFirstTokenMs: number;
  streamingTotalMs: number;
}

function assertEnv(): void {
  if (!SUPABASE_URL) throw new Error('NEXT_PUBLIC_SUPABASE_URL is required.');
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required.');
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required.');
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatMs(value: number): string {
  return `${Math.round(value)} ms`;
}

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

function rerankChunks(question: string, chunks: MatchDocument[], limit = 5): MatchDocument[] {
  return [...chunks]
    .sort((left, right) => {
      const leftScore = left.similarity + lexicalBoost(question, left);
      const rightScore = right.similarity + lexicalBoost(question, right);
      return rightScore - leftScore;
    })
    .slice(0, limit);
}

async function embedQuestion(question: string): Promise<number[]> {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: question }),
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

function buildUserMessage(question: string, chunks: MatchDocument[]): string {
  const currentDate = new Date().toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return `Today's date is ${currentDate}.

Question:
${question}

Retrieved context:
${buildContext(chunks)}

Answer using only the retrieved context. Include source URLs used in the answer.`;
}

async function retrieveChunks(question: string): Promise<RetrievalResult> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  const questionEmbedding = await embedQuestion(question);
  const { data, error } = await supabase.rpc('match_documents', {
    query_embedding: questionEmbedding,
    similarity_threshold: MIN_SIMILARITY_THRESHOLD,
    limit_count: 12,
  });

  if (error) throw new Error(`Supabase match_documents failed: ${error.message}`);

  const chunks = rerankChunks(question, (data ?? []) as MatchDocument[]);
  const topSimilarity = chunks[0]?.similarity ?? 0;
  return {
    chunks,
    fallbackTriggered: chunks.length === 0 || topSimilarity < MIN_SIMILARITY_THRESHOLD,
  };
}

async function runNonStreamingTrial(question: string): Promise<number> {
  const start = performance.now();
  const { chunks, fallbackTriggered } = await retrieveChunks(question);
  if (fallbackTriggered) throw new Error(`Retrieval fallback triggered for question: ${question}`);

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage(question, chunks) },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI non-streaming request failed: ${response.status} ${response.statusText} - ${body}`);
  }

  const payload = await response.json() as ChatCompletionResponse;
  if (!payload.choices?.[0]?.message?.content) {
    throw new Error('OpenAI non-streaming response did not include answer content.');
  }

  return performance.now() - start;
}

async function runStreamingTrial(question: string): Promise<{ firstTokenMs: number; totalMs: number }> {
  const start = performance.now();
  const { chunks, fallbackTriggered } = await retrieveChunks(question);
  if (fallbackTriggered) throw new Error(`Retrieval fallback triggered for question: ${question}`);

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
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
    throw new Error(`OpenAI streaming request failed: ${response.status} ${response.statusText} - ${body}`);
  }

  if (!response.body) throw new Error('OpenAI streaming response did not include a stream.');

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';
  let firstTokenMs: number | undefined;
  let streamedTextLength = 0;

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
        streamedTextLength += content.length;
        firstTokenMs ??= performance.now() - start;
      }
    }
  }

  if (!firstTokenMs || streamedTextLength === 0) {
    throw new Error('OpenAI streaming response did not include streamed text.');
  }

  return {
    firstTokenMs,
    totalMs: performance.now() - start,
  };
}

async function benchmarkQuestion(question: string): Promise<TrialResult[]> {
  const results: TrialResult[] = [];

  for (let trial = 1; trial <= TRIALS_PER_QUESTION; trial += 1) {
    process.stdout.write(`  trial ${trial}/${TRIALS_PER_QUESTION} non-streaming... `);
    const nonStreamingTotalMs = await runNonStreamingTrial(question);
    process.stdout.write(`${formatMs(nonStreamingTotalMs)}; streaming... `);
    const streaming = await runStreamingTrial(question);
    process.stdout.write(`ttft ${formatMs(streaming.firstTokenMs)}, total ${formatMs(streaming.totalMs)}\n`);

    results.push({
      nonStreamingTotalMs,
      streamingFirstTokenMs: streaming.firstTokenMs,
      streamingTotalMs: streaming.totalMs,
    });
  }

  return results;
}

function printTable(rows: Array<{
  question: string;
  nonStreamingTotalMs: number;
  streamingFirstTokenMs: number;
  streamingTotalMs: number;
  perceivedReduction: number;
}>): void {
  const headers = [
    'Question',
    'Non-stream avg',
    'Stream TTFT avg',
    'Stream total avg',
    'Perceived reduction',
  ];
  const tableRows = rows.map((row) => [
    row.question,
    formatMs(row.nonStreamingTotalMs),
    formatMs(row.streamingFirstTokenMs),
    formatMs(row.streamingTotalMs),
    `${row.perceivedReduction.toFixed(1)}%`,
  ]);
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...tableRows.map((row) => row[index].length)
  ));
  const formatRow = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index])).join(' | ');

  console.log('\nLatency summary');
  console.log(formatRow(headers));
  console.log(widths.map((width) => '-'.repeat(width)).join('-|-'));
  for (const row of tableRows) {
    console.log(formatRow(row));
  }
}

async function main(): Promise<void> {
  assertEnv();

  console.log(`Running latency benchmark with ${QUESTIONS.length} questions x ${TRIALS_PER_QUESTION} trials.`);
  console.log('Timing includes embedding, Supabase retrieval/reranking, and GPT response generation.\n');

  const summaryRows = [];

  for (const question of QUESTIONS) {
    console.log(`Question: ${question}`);
    const trials = await benchmarkQuestion(question);
    const nonStreamingTotalMs = average(trials.map((trial) => trial.nonStreamingTotalMs));
    const streamingFirstTokenMs = average(trials.map((trial) => trial.streamingFirstTokenMs));
    const streamingTotalMs = average(trials.map((trial) => trial.streamingTotalMs));
    const perceivedReduction = ((nonStreamingTotalMs - streamingFirstTokenMs) / nonStreamingTotalMs) * 100;

    summaryRows.push({
      question,
      nonStreamingTotalMs,
      streamingFirstTokenMs,
      streamingTotalMs,
      perceivedReduction,
    });
  }

  printTable(summaryRows);

  const overallNonStreamingTotalMs = average(summaryRows.map((row) => row.nonStreamingTotalMs));
  const overallStreamingFirstTokenMs = average(summaryRows.map((row) => row.streamingFirstTokenMs));
  const overallStreamingTotalMs = average(summaryRows.map((row) => row.streamingTotalMs));
  const overallPerceivedReduction = ((overallNonStreamingTotalMs - overallStreamingFirstTokenMs) / overallNonStreamingTotalMs) * 100;

  console.log('\nOverall averages');
  console.log(`Non-streaming total latency: ${formatMs(overallNonStreamingTotalMs)}`);
  console.log(`Streaming time-to-first-token: ${formatMs(overallStreamingFirstTokenMs)}`);
  console.log(`Streaming total latency: ${formatMs(overallStreamingTotalMs)}`);
  console.log(`Perceived latency reduction: ${overallPerceivedReduction.toFixed(1)}%`);
  console.log(`\nResume-ready: Reduced perceived response latency by ${overallPerceivedReduction.toFixed(1)}% by implementing streaming GPT-4o mini responses.`);
  console.log('\nCaveat: Results include live OpenAI and Supabase network variance; rerun during similar network conditions for apples-to-apples comparisons.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
