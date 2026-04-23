export function getBotType(userAgent: string): string {
  if (!userAgent) return 'Unknown';
  const ua = userAgent.toLowerCase();

  if (ua.includes('googlebot')) return 'Googlebot';
  if (ua.includes('bingbot')) return 'Bingbot';
  if (ua.includes('applebot')) return 'Applebot';
  if (ua.includes('ahrefsbot')) return 'AhrefsBot';
  if (ua.includes('semrushbot')) return 'SemrushBot';
  if (ua.includes('yandexbot')) return 'YandexBot';
  if (ua.includes('baiduspider')) return 'Baiduspider';
  if (ua.includes('facebookexternalhit')) return 'FacebookBot';
  if (ua.includes('linkedinbot')) return 'LinkedInBot';
  if (ua.includes('twitterbot')) return 'TwitterBot';

  if (ua.includes('chatgpt-user') || ua.includes('gptbot') || ua.includes('openai')) return 'ChatGPT / OpenAI';
  if (ua.includes('anthropic-ai') || ua.includes('claudebot')) return 'Claude / Anthropic';
  if (ua.includes('perplexitybot')) return 'Perplexity';
  if (ua.includes('cohere-ai')) return 'Cohere';
  if (ua.includes('omgili') || ua.includes('ccbot')) return 'Generic LLM / Scraper';

  if (ua.includes('bot') || ua.includes('crawler') || ua.includes('spider')) return 'Generic Bot';

  return 'Human';
}

export const NGINX_LOG_REGEX = /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"([^"]*)"\s+(\d{3})\s+(\d+|-)(?:\s+"([^"]*)")?(?:\s+"([^"]*)")?/;

export function parseLogDate(dateStr: string): string {
  try {
    const parts = dateStr.split(/[/\s:]/);
    if (parts.length >= 6) {
      const [day, monthStr, year, hour, minute, second] = parts;
      const monthMap: Record<string, string> = {
        Jan: '01',
        Feb: '02',
        Mar: '03',
        Apr: '04',
        May: '05',
        Jun: '06',
        Jul: '07',
        Aug: '08',
        Sep: '09',
        Oct: '10',
        Nov: '11',
        Dec: '12',
      };
      const month = monthMap[monthStr] || '01';
      return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
    }
  } catch {
    // Fall through to the timestamp fallback below.
  }

  return new Date().toISOString();
}
