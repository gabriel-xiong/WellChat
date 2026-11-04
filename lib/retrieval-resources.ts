import { selectLexicalSearchTerms } from './retrieval';

export const APPROVED_RESOURCE_LINKS = [
  { title: 'Sundays With Us', url: 'https://thewellaustin.com/sundays', keywords: ['sunday', 'service', 'services', 'worship', 'visit', 'visitor', 'visitors', 'attend', 'weekend', 'location', 'parking'] },
  { title: 'Community Groups', url: 'https://thewellaustin.com/community', keywords: ['community', 'group', 'groups', 'connect'] },
  { title: 'Serve', url: 'https://thewellaustin.com/serve', keywords: ['serve', 'volunteer', 'team'] },
  { title: 'Giving', url: 'https://thewellaustin.com/giving', keywords: ['give', 'giving', 'donate', 'donation', 'financial', 'contribution', 'stock', 'crypto'] },
  { title: 'Ministries', url: 'https://thewellaustin.com/ministries', keywords: ['ministry', 'kids', 'children', 'youth'] },
  { title: 'What We Believe', url: 'https://thewellaustin.com/beliefs', keywords: ['believe', 'belief', 'scripture', 'doctrine', 'faith'] },
  { title: 'Our Team', url: 'https://thewellaustin.com/team', keywords: ['team', 'staff', 'pastor', 'pastors', 'leader', 'leaders', 'leadership', 'contact', 'email', 'office'] },
  { title: 'Events', url: 'https://thewellaustin.com/events', keywords: ['event', 'happening', 'calendar', 'upcoming', 'this month', 'this week'] },
  { title: 'Sermons', url: 'https://thewellaustin.com/sermons', keywords: ['sermon', 'message', 'teaching'] },
  { title: 'Podcast', url: 'https://thewellaustin.com/podcast', keywords: ['podcast'] },
  { title: 'Mission and Vision', url: 'https://thewellaustin.com/mission', keywords: ['mission', 'vision', 'values', 'purpose'] },
  { title: 'International Missions', url: 'https://thewellaustin.com/missions', keywords: ['international', 'missions', 'missionary', 'missionaries', 'global', 'outreach', 'trip', 'trips'] },
  { title: 'Jobs', url: 'https://thewellaustin.com/jobs', keywords: ['job', 'jobs', 'career', 'careers', 'employment', 'hiring', 'apply', 'application', 'role', 'roles'] },
] as const;

function matchesKeyword(question: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(question);
}

export function matchingApprovedResourceUrls(question: string): string[] {
  return APPROVED_RESOURCE_LINKS
    .filter((resource) => resource.keywords.some((keyword) => matchesKeyword(question, keyword)))
    .map((resource) => resource.url);
}

export function isInferredAuthoritativeUrl(question: string, url: string): boolean {
  const terms = selectLexicalSearchTerms(question);
  const approvedUrls = matchingApprovedResourceUrls(question);
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  const collection = segments[0]?.replace(/s$/, '');
  const normalizedTerms = new Set(terms.map((term) => term.replace(/s$/, '')));
  const exactSubjectSlug = terms.includes(segments.at(-1) ?? '');
  const isCollectionPage = segments.length === 1
    || (collection === 'retreat' && segments.length === 2 && /^\d{4}$/.test(segments[1]));
  return exactSubjectSlug || (
    approvedUrls.length === 0
    && Boolean(collection && normalizedTerms.has(collection) && isCollectionPage)
  );
}
