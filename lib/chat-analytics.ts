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
  "other",
] as const;

export type ChatCategory = (typeof CHAT_CATEGORIES)[number];

const CATEGORY_KEYWORDS: Array<[ChatCategory, string[]]> = [
  ["crisis", ["hurt myself", "kill myself", "suicide", "end my life", "self-harm", "hurting myself", "want to die"]],
  ["pastoral", ["spiritual advice", "pray for me", "need to talk", "need someone to talk to", "struggling", "counseling", "personal", "going through something"]],
  ["events", ["event", "happening", "calendar", "this month", "this week"]],
  ["sundays", ["sunday", "service", "church start", "location", "visit"]],
  ["community", ["community group", "small group", "join a group"]],
  ["beliefs", ["believe", "belief", "doctrine", "theology"]],
  ["serving", ["serve", "volunteer"]],
  ["giving", ["give", "giving", "donate", "donation"]],
  ["ministries", ["ministry", "kids", "children", "students"]],
  ["staff", ["staff", "team", "pastor", "leader"]],
];

export function classifyQuestion(question: string): ChatCategory {
  const normalized = question.toLowerCase();
  return CATEGORY_KEYWORDS.find(([, keywords]) => keywords.some((keyword) => normalized.includes(keyword)))?.[0] ?? "other";
}
