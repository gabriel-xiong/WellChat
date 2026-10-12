import { createClient } from '@supabase/supabase-js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MatchDocument, rerankChunks } from '../lib/retrieval';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MIN_SIMILARITY_THRESHOLD = Number(process.env.MIN_SIMILARITY_THRESHOLD ?? '0.25');
const GENERATION_MODEL = process.env.RAG_EVAL_GENERATION_MODEL ?? 'gpt-4o-mini';
const JUDGE_MODEL = process.env.RAG_EVAL_JUDGE_MODEL ?? 'gpt-4o-mini';
const RETRIEVAL_K = Math.max(1, Number(process.env.RAG_EVAL_K ?? '5'));
const EVAL_LIMIT = Number(process.env.RAG_EVAL_LIMIT ?? '0');
const EMBEDDING_MODEL = 'text-embedding-3-small';

interface EvalQuestion {
  question: string;
  expectedSlugs: string[];
}

interface GenerationScores {
  faithfulness: number;
  answerRelevance: number;
  citationCorrectness: number;
  groundedness: number;
  rationale: string;
}

interface EvalResult {
  question: string;
  expectedSlugs: string[];
  retrieved: Array<{
    id: string;
    url: string;
    title: string | null;
    similarity: number;
    relevant: boolean;
  }>;
  answer: string;
  retrieval: {
    precisionAtK: number;
    recallAtK: number;
    reciprocalRank: number;
    ndcgAtK: number;
  };
  generation: GenerationScores;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

const SYSTEM_PROMPT = `You are a website assistant for The Well Austin Community Church.
Answer only from the provided context. If the answer is unavailable, say so and suggest contacting The Well directly.
Always include a Markdown source link when answering. Do not invent facts.`;

const EVAL_SET: EvalQuestion[] = [
  { question: 'What time are Sunday services?', expectedSlugs: ['/sundays'] },
  { question: 'Where is The Well Austin located?', expectedSlugs: ['/sundays'] },
  { question: 'What should I expect on Sunday?', expectedSlugs: ['/sundays'] },
  { question: 'Where should I park on Sunday?', expectedSlugs: ['/sundays'] },
  { question: 'Do you have anything for kids on Sundays?', expectedSlugs: ['/sundays', '/ministries'] },
  { question: 'How do I join a community group?', expectedSlugs: ['/community'] },
  { question: 'Are there groups across Austin?', expectedSlugs: ['/community'] },
  { question: 'How can I serve or volunteer?', expectedSlugs: ['/serve'] },
  { question: 'What volunteer teams can I join?', expectedSlugs: ['/serve'] },
  { question: 'How can I give to The Well?', expectedSlugs: ['/giving'] },
  { question: 'Can I donate stock or crypto?', expectedSlugs: ['/giving'] },
  { question: 'What ministries are available for kids?', expectedSlugs: ['/ministries'] },
  { question: 'What does The Well believe?', expectedSlugs: ['/beliefs'] },
  { question: 'What does the church believe about scripture?', expectedSlugs: ['/beliefs'] },
  { question: 'Who are the pastors or staff?', expectedSlugs: ['/team'] },
  { question: 'How do I contact the church team?', expectedSlugs: ['/team'] },
  { question: 'What events are coming up?', expectedSlugs: ['/events'] },
  { question: 'Where can I find sermons?', expectedSlugs: ['/sermons'] },
  { question: 'Where can I listen to the podcast?', expectedSlugs: ['/podcast'] },
  { question: 'What is the mission of The Well?', expectedSlugs: ['/mission'] },
  { question: 'Where can I read stories or testimonies?', expectedSlugs: ['/stories'] },
  { question: 'What is the church planting residency?', expectedSlugs: ['/planting'] },
  { question: 'How does The Well do international missions?', expectedSlugs: ['/missions'] },
  { question: 'What is the ministry residency program?', expectedSlugs: ['/residency'] },
  { question: 'Where can I see impact reports?', expectedSlugs: ['/impact'] },
];

function assertConfig(): void {
  if (!SUPABASE_URL) throw new Error('NEXT_PUBLIC_SUPABASE_URL is required.');
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required.');
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required.');
  if (!Number.isFinite(RETRIEVAL_K)) throw new Error('RAG_EVAL_K must be a number.');
  if (!Number.isFinite(EVAL_LIMIT) || EVAL_LIMIT < 0) throw new Error('RAG_EVAL_LIMIT must be zero or a positive number.');
}

function isRelevant(chunk: MatchDocument, expectedSlugs: string[]): boolean {
  return expectedSlugs.some((slug) => new URL(chunk.url).pathname.includes(slug));
}

function retrievalMetrics(chunks: MatchDocument[], expectedSlugs: string[]) {
  const topK = chunks.slice(0, RETRIEVAL_K);
  const relevance = topK.map((chunk) => isRelevant(chunk, expectedSlugs));
  const relevantCount = relevance.filter(Boolean).length;
  const foundSlugs = new Set(
    expectedSlugs.filter((slug) => topK.some((chunk) => new URL(chunk.url).pathname.includes(slug)))
  );
  const firstRelevantIndex = relevance.findIndex(Boolean);
  const creditedSlugs = new Set<string>();
  const rankedGains: number[] = topK.map((chunk) => {
    const path = new URL(chunk.url).pathname;
    const matchingSlug = expectedSlugs.find((slug) => path.includes(slug));
    if (!matchingSlug || creditedSlugs.has(matchingSlug)) return 0;
    creditedSlugs.add(matchingSlug);
    return 1;
  });
  const dcg = rankedGains.reduce((sum, gain, index) => (
    sum + gain / Math.log2(index + 2)
  ), 0);
  const idealRelevantCount = Math.min(RETRIEVAL_K, expectedSlugs.length);
  const idcg = Array.from({ length: idealRelevantCount }, (_, index) => 1 / Math.log2(index + 2))
    .reduce((sum, gain) => sum + gain, 0);

  return {
    precisionAtK: relevantCount / RETRIEVAL_K,
    recallAtK: foundSlugs.size / expectedSlugs.length,
    reciprocalRank: firstRelevantIndex === -1 ? 0 : 1 / (firstRelevantIndex + 1),
    ndcgAtK: idcg === 0 ? 0 : dcg / idcg,
  };
}

function buildContext(chunks: MatchDocument[]): string {
  return chunks.map((chunk, index) => `Source ${index + 1}\nTitle: ${chunk.title ?? 'Untitled'}\nURL: ${chunk.url}\nSection: ${chunk.section ?? 'page'}\nContent:\n${chunk.content}`)
    .join('\n\n---\n\n');
}

async function openAIRequest(body: Record<string, unknown>): Promise<ChatCompletionResponse> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${response.status} ${response.statusText} - ${await response.text()}`);
  }
  return response.json() as Promise<ChatCompletionResponse>;
}

async function embed(question: string): Promise<number[]> {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: question }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI embedding failed: ${response.status} ${response.statusText} - ${await response.text()}`);
  }
  const payload = await response.json() as { data?: Array<{ embedding?: number[] }> };
  const value = payload.data?.[0]?.embedding;
  if (!value) throw new Error('Embedding response did not contain an embedding.');
  return value;
}

async function retrieve(question: string): Promise<MatchDocument[]> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data, error } = await supabase.rpc('match_documents', {
    query_embedding: await embed(question),
    similarity_threshold: MIN_SIMILARITY_THRESHOLD,
    limit_count: 12,
  });
  if (error) throw new Error(`Supabase match_documents failed: ${error.message}`);
  return rerankChunks(question, (data ?? []) as MatchDocument[], RETRIEVAL_K);
}

async function generateAnswer(question: string, chunks: MatchDocument[]): Promise<string> {
  if (chunks.length === 0) return "I don't know based on the available website information. Please contact The Well directly.";
  const result = await openAIRequest({
    model: GENERATION_MODEL,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Question:\n${question}\n\nRetrieved context:\n${buildContext(chunks)}\n\nAnswer using only this context.` },
    ],
  });
  const answer = result.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error('Generation response was empty.');
  return answer;
}

async function judgeAnswer(question: string, answer: string, chunks: MatchDocument[]): Promise<GenerationScores> {
  const result = await openAIRequest({
    model: JUDGE_MODEL,
    temperature: 0,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'rag_generation_scores',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            faithfulness: { type: 'number', minimum: 0, maximum: 1 },
            answerRelevance: { type: 'number', minimum: 0, maximum: 1 },
            citationCorrectness: { type: 'number', minimum: 0, maximum: 1 },
            groundedness: { type: 'number', minimum: 0, maximum: 1 },
            rationale: { type: 'string' },
          },
          required: ['faithfulness', 'answerRelevance', 'citationCorrectness', 'groundedness', 'rationale'],
        },
      },
    },
    messages: [
      {
        role: 'system',
        content: `You are a strict RAG evaluator. Score each metric from 0 to 1.
Faithfulness: proportion of the answer's externally verifiable claims supported by the retrieved context.
Answer relevance: how directly and completely the answer addresses the question, without rewarding unsupported detail.
Citation correctness: whether cited URLs are present in the retrieved context and support the claims attributed to them. If factual claims need citations but none are present, score 0.
Groundedness: holistic degree to which the answer stays within the retrieved evidence, including appropriate uncertainty when evidence is missing.
Do not use outside knowledge. Keep the rationale under 60 words.`,
      },
      {
        role: 'user',
        content: `Question:\n${question}\n\nAnswer:\n${answer}\n\nRetrieved context:\n${buildContext(chunks) || '(none)'}`,
      },
    ],
  });
  const content = result.choices?.[0]?.message?.content;
  if (!content) throw new Error('Judge response was empty.');
  return JSON.parse(content) as GenerationScores;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function summarize(results: EvalResult[]): void {
  const goodRetrieval = results.filter((result) => result.retrieval.recallAtK === 1);
  const generationSummary = (items: EvalResult[]) => ({
    faithfulness: mean(items.map((item) => item.generation.faithfulness)),
    answerRelevance: mean(items.map((item) => item.generation.answerRelevance)),
    citationCorrectness: mean(items.map((item) => item.generation.citationCorrectness)),
    groundedness: mean(items.map((item) => item.generation.groundedness)),
  });
  const allGeneration = generationSummary(results);
  const conditionedGeneration = generationSummary(goodRetrieval);

  console.log('\nRetrieval metrics');
  console.table({
    [`Precision@${RETRIEVAL_K}`]: percent(mean(results.map((item) => item.retrieval.precisionAtK))),
    [`Recall@${RETRIEVAL_K}`]: percent(mean(results.map((item) => item.retrieval.recallAtK))),
    MRR: mean(results.map((item) => item.retrieval.reciprocalRank)).toFixed(3),
    [`nDCG@${RETRIEVAL_K}`]: mean(results.map((item) => item.retrieval.ndcgAtK)).toFixed(3),
  });

  console.log('\nGeneration metrics');
  console.table({
    faithfulness: percent(allGeneration.faithfulness),
    answer_relevance: percent(allGeneration.answerRelevance),
    citation_correctness: percent(allGeneration.citationCorrectness),
    groundedness: percent(allGeneration.groundedness),
  });

  console.log(`\nGeneration quality when Recall@${RETRIEVAL_K} = 100% (${goodRetrieval.length}/${results.length} cases)`);
  console.table({
    faithfulness: percent(conditionedGeneration.faithfulness),
    answer_relevance: percent(conditionedGeneration.answerRelevance),
    citation_correctness: percent(conditionedGeneration.citationCorrectness),
    groundedness: percent(conditionedGeneration.groundedness),
  });

  const failures = goodRetrieval.filter((item) => (
    Math.min(
      item.generation.faithfulness,
      item.generation.answerRelevance,
      item.generation.citationCorrectness,
      item.generation.groundedness,
    ) < 0.8
  ));
  console.log(`\nGood retrieval / weak generation cases (<80% on any generation metric): ${failures.length}`);
  for (const failure of failures) {
    console.log(`- ${failure.question}: ${failure.generation.rationale}`);
  }
}

async function main(): Promise<void> {
  assertConfig();
  const questions = EVAL_LIMIT > 0 ? EVAL_SET.slice(0, EVAL_LIMIT) : EVAL_SET;
  console.log(`Running end-to-end RAG evaluation on ${questions.length} questions at K=${RETRIEVAL_K}.`);
  console.log(`Generation model: ${GENERATION_MODEL}; judge model: ${JUDGE_MODEL}.`);

  const results: EvalResult[] = [];
  for (const [index, item] of questions.entries()) {
    process.stdout.write(`[${index + 1}/${questions.length}] ${item.question} ... `);
    const chunks = await retrieve(item.question);
    const answer = await generateAnswer(item.question, chunks);
    const generation = await judgeAnswer(item.question, answer, chunks);
    const retrieval = retrievalMetrics(chunks, item.expectedSlugs);
    results.push({
      question: item.question,
      expectedSlugs: item.expectedSlugs,
      retrieved: chunks.map((chunk) => ({
        id: chunk.id,
        url: chunk.url,
        title: chunk.title,
        similarity: chunk.similarity,
        relevant: isRelevant(chunk, item.expectedSlugs),
      })),
      answer,
      retrieval,
      generation,
    });
    process.stdout.write(`recall ${percent(retrieval.recallAtK)}, groundedness ${percent(generation.groundedness)}\n`);
  }

  summarize(results);
  const outputDirectory = join(process.cwd(), 'tmp', 'rag-evals');
  await mkdir(outputDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = join(outputDirectory, `rag-eval-${timestamp}.json`);
  await writeFile(outputPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    config: {
      retrievalK: RETRIEVAL_K,
      similarityThreshold: MIN_SIMILARITY_THRESHOLD,
      embeddingModel: EMBEDDING_MODEL,
      generationModel: GENERATION_MODEL,
      judgeModel: JUDGE_MODEL,
    },
    results,
  }, null, 2));
  console.log(`\nSaved detailed results to ${outputPath}`);
  console.log('Note: retrieval relevance uses expected URL slugs as a proxy; generation scores are model-judged and should be calibrated against human ratings.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
