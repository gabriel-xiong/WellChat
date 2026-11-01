export const CHAT_CATEGORIES = [
  "crisis",
  "pastoral",
  "events",
  "sundays",
  "community",
  "beliefs",
  "serving",
  "giving",
  "ministries",
  "staff",
  "jobs",
  "other",
] as const;

export type ChatCategory = (typeof CHAT_CATEGORIES)[number];

const CATEGORY_KEYWORDS: Array<[ChatCategory, string[]]> = [
  ["crisis", ["harm myself", "harming myself", "hurt myself", "kill myself", "suicide", "suicidal", "end my life", "take my own life", "self-harm", "self harm", "hurting myself", "want to die", "don't want to live", "dont want to live"]],
  ["pastoral", ["pastoral care", "spiritual advice", "pray for me", "need prayer", "need to talk", "need someone to talk to", "talk to someone", "struggling", "counseling", "personal", "going through something"]],
  ["events", ["event", "happening", "calendar", "this month", "this week"]],
  ["sundays", ["sunday", "service", "church start", "location", "visit"]],
  ["community", ["community group", "small group", "join a group"]],
  ["beliefs", ["believe", "belief", "doctrine", "theology"]],
  ["serving", ["serve", "volunteer"]],
  ["giving", ["give", "giving", "donate", "donation"]],
  ["ministries", ["ministry", "kids", "children", "students"]],
  ["staff", ["staff", "team", "pastor", "leader"]],
  ["jobs", ["job", "jobs", "career", "careers", "employment"]],
];

export function classifyQuestion(question: string): ChatCategory {
  const normalized = question.toLowerCase();
  const matches = CATEGORY_KEYWORDS.flatMap(([category, keywords], categoryIndex) => keywords
    .filter((keyword) => normalized.includes(keyword))
    .map((keyword) => ({ category, keyword, categoryIndex })));
  if (!matches.length) return "other";
  if (matches.some((match) => match.category === "crisis")) return "crisis";
  if (matches.some((match) => match.category === "pastoral")) return "pastoral";
  return matches.sort((left, right) => (
    right.keyword.length - left.keyword.length || left.categoryIndex - right.categoryIndex
  ))[0].category;
}
