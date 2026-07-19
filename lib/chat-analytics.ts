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
];

export function classifyQuestion(question: string): ChatCategory {
  const normalized = question.toLowerCase();
  return CATEGORY_KEYWORDS.find(([, keywords]) => keywords.some((keyword) => normalized.includes(keyword)))?.[0] ?? "other";
}
