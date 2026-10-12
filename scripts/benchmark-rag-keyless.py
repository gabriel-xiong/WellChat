import json
import math
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests
import torch
import torch.nn.functional as F
from transformers import AutoModel, AutoModelForSequenceClassification, AutoTokenizer

ENDPOINT = os.getenv("RAG_EVAL_ENDPOINT", "https://the-well-rag-agent.vercel.app/api/chat")
K = int(os.getenv("RAG_EVAL_K", "5"))
NLI_MODEL = "cross-encoder/nli-deberta-v3-small"
SEMANTIC_MODEL = "sentence-transformers/all-MiniLM-L6-v2"

EVAL_SET = [
    ("What time are Sunday services?", ["/sundays"]),
    ("Where is The Well Austin located?", ["/sundays"]),
    ("What should I expect on Sunday?", ["/sundays"]),
    ("Where should I park on Sunday?", ["/sundays"]),
    ("Do you have anything for kids on Sundays?", ["/sundays", "/ministries"]),
    ("How do I join a community group?", ["/community"]),
    ("Are there groups across Austin?", ["/community"]),
    ("How can I serve or volunteer?", ["/serve"]),
    ("What volunteer teams can I join?", ["/serve"]),
    ("How can I give to The Well?", ["/giving"]),
    ("Can I donate stock or crypto?", ["/giving"]),
    ("What ministries are available for kids?", ["/ministries"]),
    ("What does The Well believe?", ["/beliefs"]),
    ("What does the church believe about scripture?", ["/beliefs"]),
    ("Who are the pastors or staff?", ["/team"]),
    ("How do I contact the church team?", ["/team"]),
    ("What events are coming up?", ["/events"]),
    ("Where can I find sermons?", ["/sermons"]),
    ("Where can I listen to the podcast?", ["/podcast"]),
    ("What is the mission of The Well?", ["/mission"]),
    ("Where can I read stories or testimonies?", ["/stories"]),
    ("What is the church planting residency?", ["/planting"]),
    ("How does The Well do international missions?", ["/missions"]),
    ("What is the ministry residency program?", ["/residency"]),
    ("Where can I see impact reports?", ["/impact"]),
]


def load_env(path: Path) -> dict[str, str]:
    values = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


ENV = load_env(Path(".env.local"))
SUPABASE_URL = ENV["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = ENV["SUPABASE_SERVICE_ROLE_KEY"]
DB_HEADERS = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}


def db_get(table: str, params: dict) -> list[dict]:
    response = requests.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=DB_HEADERS, params=params, timeout=30)
    response.raise_for_status()
    return response.json()


def call_chat(question: str) -> tuple[str, str]:
    while True:
        response = requests.post(ENDPOINT, json={"question": question}, timeout=120)
        if response.status_code != 429:
            response.raise_for_status()
            break
        retry = max(1, int(response.headers.get("Retry-After", "30")))
        print(f"rate limited; retrying in {retry}s", flush=True)
        for remaining in range(retry, 0, -30):
            time.sleep(min(30, remaining))
            print(f"  wait: {max(remaining - 30, 0)}s", flush=True)
    query_id = response.headers.get("X-Query-Id")
    if not query_id:
        payload = response.json()
        query_id = payload.get("query_id")
        return payload["answer"], query_id
    return response.text, query_id


def fetch_log(query_id: str, question: str) -> dict:
    for _ in range(10):
        rows = db_get("query_logs", {
            "select": "id,question,retrieved_chunk_ids,retrieved_urls,answer,cache_hit,created_at",
            "id": f"eq.{query_id}",
            "limit": "1",
        })
        if rows:
            row = rows[0]
            if row.get("retrieved_chunk_ids"):
                return row
            # Cached answers log no retrieval data. Reuse the newest uncached trace for the same canonical prompt.
            historical = db_get("query_logs", {
                "select": "id,question,retrieved_chunk_ids,retrieved_urls,answer,cache_hit,created_at",
                "question": f"eq.{question}",
                "cache_hit": "eq.false",
                "order": "created_at.desc",
                "limit": "1",
            })
            if historical:
                historical[0]["answer"] = row.get("answer") or historical[0].get("answer")
                return historical[0]
        else:
            historical = latest_trace(question)
            if historical:
                return historical
        time.sleep(1)
    raise RuntimeError(f"No retrieval trace found for query {query_id}")


def latest_trace(question: str) -> dict | None:
    newest = db_get("query_logs", {
        "select": "id,question,retrieved_chunk_ids,retrieved_urls,answer,cache_hit,created_at",
        "question": f"eq.{question}",
        "order": "created_at.desc",
        "limit": "1",
    })
    historical = db_get("query_logs", {
        "select": "id,question,retrieved_chunk_ids,retrieved_urls,answer,cache_hit,created_at",
        "question": f"eq.{question}",
        "cache_hit": "eq.false",
        "order": "created_at.desc",
        "limit": "1",
    })
    if not newest or not historical or not historical[0].get("retrieved_chunk_ids"):
        return None
    historical[0]["answer"] = newest[0].get("answer") or historical[0].get("answer")
    historical[0]["answer_query_id"] = newest[0].get("id")
    return historical[0]


def fetch_chunks(ids: list[str]) -> list[dict]:
    if not ids:
        return []
    rows = db_get("documents", {
        "select": "id,url,title,section,content",
        "id": f"in.({','.join(ids)})",
    })
    by_id = {row["id"]: row for row in rows}
    return [by_id[item_id] for item_id in ids if item_id in by_id][:K]


def retrieval_scores(chunks: list[dict], expected: list[str]) -> dict[str, float]:
    top = chunks[:K]
    relevant = [any(slug in urlparse(chunk["url"]).path for slug in expected) for chunk in top]
    precision = sum(relevant) / K
    found = {slug for slug in expected if any(slug in urlparse(chunk["url"]).path for chunk in top)}
    recall = len(found) / len(expected)
    first = next((index for index, value in enumerate(relevant) if value), None)
    reciprocal_rank = 0 if first is None else 1 / (first + 1)
    credited = set()
    gains = []
    for chunk in top:
        path = urlparse(chunk["url"]).path
        slug = next((slug for slug in expected if slug in path and slug not in credited), None)
        gains.append(1 if slug else 0)
        if slug:
            credited.add(slug)
    dcg = sum(gain / math.log2(index + 2) for index, gain in enumerate(gains))
    ideal = sum(1 / math.log2(index + 2) for index in range(min(K, len(expected))))
    return {"precision_at_k": precision, "recall_at_k": recall, "mrr": reciprocal_rank, "ndcg_at_k": dcg / ideal}


print("Loading local evaluator models...", flush=True)
nli_tokenizer = AutoTokenizer.from_pretrained(NLI_MODEL)
nli_model = AutoModelForSequenceClassification.from_pretrained(NLI_MODEL).eval()
semantic_tokenizer = AutoTokenizer.from_pretrained(SEMANTIC_MODEL)
semantic_model = AutoModel.from_pretrained(SEMANTIC_MODEL).eval()


def claims(answer: str) -> list[str]:
    clean = re.sub(r"\[([^]]+)]\([^)]+\)", r"\1", answer)
    values = [value.strip() for value in re.split(r"(?<=[.!?])\s+|\n+", clean) if len(value.split()) >= 3]
    return values or [clean.strip()]


@torch.inference_mode()
def entailment(premise: str, hypothesis: str) -> float:
    inputs = nli_tokenizer(premise, hypothesis, return_tensors="pt", truncation=True, max_length=512)
    probabilities = torch.softmax(nli_model(**inputs).logits, dim=-1)[0]
    return float(probabilities[1])


@torch.inference_mode()
def embed_text(text: str) -> torch.Tensor:
    inputs = semantic_tokenizer(text, return_tensors="pt", truncation=True, max_length=512)
    output = semantic_model(**inputs).last_hidden_state
    mask = inputs["attention_mask"].unsqueeze(-1).float()
    pooled = (output * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1e-9)
    return F.normalize(pooled, p=2, dim=1)


def generation_scores(question: str, answer: str, chunks: list[dict]) -> dict[str, float]:
    answer_claims = claims(answer)
    supports = []
    for claim in answer_claims:
        supports.append(max((entailment(chunk["content"], claim) for chunk in chunks), default=0.0))
    faithfulness = sum(score >= 0.5 for score in supports) / len(supports)
    groundedness = sum(supports) / len(supports)
    relevance = float((embed_text(question) @ embed_text(answer).T).item())
    cited_urls = re.findall(r"\[[^]]+\]\((https?://[^)]+)\)", answer)
    retrieved_urls = {chunk["url"].rstrip("/") for chunk in chunks}
    citation_precision = (
        sum(url.rstrip("/") in retrieved_urls for url in cited_urls) / len(cited_urls)
        if cited_urls else 0.0
    )
    return {
        "faithfulness": faithfulness,
        "answer_relevance": max(0.0, min(1.0, relevance)),
        "citation_correctness": citation_precision * groundedness,
        "groundedness": groundedness,
    }


def average(results: list[dict], path: tuple[str, str]) -> float:
    return sum(item[path[0]][path[1]] for item in results) / len(results) if results else 0.0


checkpoint_path = Path("tmp/rag-evals/rag-eval-keyless-checkpoint.json")
checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
baseline_path = os.getenv("RAG_EVAL_BASELINE")
if checkpoint_path.exists():
    results = json.loads(checkpoint_path.read_text(encoding="utf-8"))
elif baseline_path:
    results = json.loads(Path(baseline_path).read_text(encoding="utf-8"))["results"]
else:
    results = []
refresh_indexes = {int(value) for value in os.getenv("RAG_EVAL_REFRESH", "").split(",") if value.strip()}
refresh_questions = {EVAL_SET[index - 1][0] for index in refresh_indexes}
results = [item for item in results if item["question"] not in refresh_questions]
completed_questions = {item["question"] for item in results}
for index, (question, expected) in enumerate(EVAL_SET, 1):
    if question in completed_questions:
        print(f"[{index}/{len(EVAL_SET)}] {question} ... checkpoint", flush=True)
        continue
    print(f"[{index}/{len(EVAL_SET)}] {question} ... ", end="", flush=True)
    log = latest_trace(question)
    if log:
        answer = log["answer"]
        query_id = log.get("answer_query_id") or log["id"]
    else:
        answer, query_id = call_chat(question)
        log = fetch_log(query_id, question)
    chunks = fetch_chunks(log.get("retrieved_chunk_ids") or [])
    expected_chunk_count = min(K, len(log.get("retrieved_chunk_ids") or []))
    if len(chunks) < expected_chunk_count:
        # Re-ingestion replaces document IDs, which can make an otherwise valid historical trace stale.
        live_question = question + "\u200b"  # Preserve semantics while avoiding exact-prompt answer caches.
        answer, query_id = call_chat(live_question)
        log = fetch_log(query_id, live_question)
        chunks = fetch_chunks(log.get("retrieved_chunk_ids") or [])
    retrieval = retrieval_scores(chunks, expected)
    generation = generation_scores(question, answer, chunks)
    results.append({
        "question": question,
        "expected_slugs": expected,
        "answer": answer,
        "query_id": query_id,
        "retrieved": [{"id": c["id"], "url": c["url"], "title": c.get("title")} for c in chunks],
        "retrieval": retrieval,
        "generation": generation,
    })
    checkpoint_path.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"recall={retrieval['recall_at_k']:.0%}, groundedness={generation['groundedness']:.0%}", flush=True)

good = [item for item in results if item["retrieval"]["recall_at_k"] == 1]
summary = {
    "retrieval": {
        f"precision_at_{K}": average(results, ("retrieval", "precision_at_k")),
        f"recall_at_{K}": average(results, ("retrieval", "recall_at_k")),
        "mrr": average(results, ("retrieval", "mrr")),
        f"ndcg_at_{K}": average(results, ("retrieval", "ndcg_at_k")),
    },
    "generation": {name: average(results, ("generation", name)) for name in [
        "faithfulness", "answer_relevance", "citation_correctness", "groundedness"
    ]},
    "generation_when_recall_is_1": {name: average(good, ("generation", name)) for name in [
        "faithfulness", "answer_relevance", "citation_correctness", "groundedness"
    ]},
    "perfect_retrieval_cases": len(good),
    "total_cases": len(results),
}

output_dir = Path("tmp/rag-evals")
output_dir.mkdir(parents=True, exist_ok=True)
stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
output_path = output_dir / f"rag-eval-keyless-{stamp}.json"
output_path.write_text(json.dumps({
    "created_at": datetime.now(timezone.utc).isoformat(),
    "method": {
        "generation_and_retrieval": ENDPOINT,
        "faithfulness_and_groundedness": NLI_MODEL,
        "answer_relevance": SEMANTIC_MODEL,
        "citation_correctness": "retrieved URL precision multiplied by NLI groundedness",
    },
    "summary": summary,
    "results": results,
}, indent=2), encoding="utf-8")
checkpoint_path.unlink(missing_ok=True)

print("\nSUMMARY")
print(json.dumps(summary, indent=2))
print(f"Saved: {output_path.resolve()}")
