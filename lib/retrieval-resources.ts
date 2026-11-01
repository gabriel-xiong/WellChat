export const APPROVED_RESOURCE_LINKS = [
  { title: 'Sundays With Us', url: 'https://thewellaustin.com/sundays', keywords: ['sunday', 'service', 'worship', 'visit', 'location', 'parking'] },
  { title: 'Community Groups', url: 'https://thewellaustin.com/community', keywords: ['community', 'group', 'connect'] },
  { title: 'Serve', url: 'https://thewellaustin.com/serve', keywords: ['serve', 'volunteer', 'team'] },
  { title: 'Giving', url: 'https://thewellaustin.com/giving', keywords: ['give', 'giving', 'donate', 'stock', 'crypto'] },
  { title: 'Ministries', url: 'https://thewellaustin.com/ministries', keywords: ['ministry', 'kids', 'children', 'youth'] },
  { title: 'What We Believe', url: 'https://thewellaustin.com/beliefs', keywords: ['believe', 'belief', 'scripture', 'doctrine', 'faith'] },
  { title: 'Our Team', url: 'https://thewellaustin.com/team', keywords: ['team', 'staff', 'pastor', 'contact'] },
  { title: 'Events', url: 'https://thewellaustin.com/events', keywords: ['event', 'happening', 'calendar', 'upcoming', 'this month', 'this week'] },
  { title: 'Sermons', url: 'https://thewellaustin.com/sermons', keywords: ['sermon', 'message', 'teaching'] },
  { title: 'Podcast', url: 'https://thewellaustin.com/podcast', keywords: ['podcast'] },
  { title: 'Mission and Vision', url: 'https://thewellaustin.com/mission', keywords: ['mission', 'vision', 'values'] },
  { title: 'International Missions', url: 'https://thewellaustin.com/missions', keywords: ['international', 'missions', 'trip'] },
  { title: 'Jobs', url: 'https://thewellaustin.com/jobs', keywords: ['job', 'jobs', 'career', 'careers', 'employment'] },
] as const;

export function matchingApprovedResourceUrls(question: string): string[] {
  const normalized = question.toLowerCase();
  return APPROVED_RESOURCE_LINKS
    .filter((resource) => resource.keywords.some((keyword) => normalized.includes(keyword)))
    .map((resource) => resource.url);
}
