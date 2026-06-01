import type { AppDatabase } from '../database.js';
import * as cheerio from 'cheerio';

type GscHintValue = number | { position?: unknown; url?: unknown };
type GscHintMap = Record<string, GscHintValue>;

type SyncRankTrackingOptions = {
  force?: boolean;
  gscHints?: GscHintMap;
};

const RANK_TRACKING_SCHEDULER_MS = 60 * 60 * 1000;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDomain(value: string) {
  return value
    .replace(/^https?:\/\//, '')
    .replace(/^sc-domain:/, '')
    .replace(/^www\./, '')
    .split('/')[0];
}

function mapLocToGsc(loc: string) {
  if (loc === 'UK') return 'gbr';
  if (loc === 'US') return 'usa';
  if (loc === 'CA') return 'can';
  if (loc === 'AU') return 'aus';
  return loc ? loc.toLowerCase() : 'gbr';
}

function getHintValue(gscHints: GscHintMap | undefined, keyword: string, device: string, location: string) {
  if (!gscHints) {
    return undefined;
  }

  const compositeKey = `${keyword.toLowerCase().trim()}|${device.toLowerCase()}|${mapLocToGsc(location)}`;
  if (gscHints[compositeKey] !== undefined) {
    return gscHints[compositeKey];
  }

  return gscHints[keyword.toLowerCase().trim()];
}

export async function syncRankTrackingForSite(
  db: AppDatabase,
  ownerId: string,
  siteUrl: string,
  options: SyncRankTrackingOptions = {},
) {
  const keywords = await db.all<any>('SELECT * FROM tracked_keywords WHERE ownerId = ? AND siteUrl = ?', [ownerId, siteUrl]);
  const today = new Date().toISOString().split('T')[0];
  let syncCount = 0;
  const defaultTargetDomain = normalizeDomain(siteUrl);

  for (const kw of keywords) {
    let currentTargetDomain = kw.targetDomain && kw.targetDomain.trim() !== '' ? kw.targetDomain : defaultTargetDomain;
    currentTargetDomain = normalizeDomain(currentTargetDomain);

    if (!options.force) {
      const existing = await db.get('SELECT 1 FROM keyword_rankings WHERE keywordId = ? AND date = ?', [kw.id, today]);
      if (existing) {
        continue;
      }
    }

    let positionToRecord = 101;
    let matchedUrl: string | null = null;
    let foundInGsc = false;
    const keyword = String(kw.keyword ?? '');
    const device = String(kw.device || 'desktop').toLowerCase();
    const location = String(kw.location || 'UK');
    const hint = getHintValue(options.gscHints, keyword, device, location);

    if (hint !== undefined) {
      if (typeof hint === 'number' && Number.isFinite(hint)) {
        positionToRecord = hint;
        matchedUrl = 'gsc_live_auth';
        foundInGsc = true;
      } else if (hint && typeof hint === 'object') {
        const hintedPosition = Number((hint as { position?: unknown }).position);
        if (Number.isFinite(hintedPosition)) {
          positionToRecord = hintedPosition;
          const hintedUrl = (hint as { url?: unknown }).url;
          matchedUrl = typeof hintedUrl === 'string' && hintedUrl.trim() !== '' ? hintedUrl : 'gsc_live_auth';
          foundInGsc = true;
        }
      }
    }

    if (!foundInGsc) {
      const gscData = await db.get<any>(`
        SELECT position, date FROM gsc_query_metrics
        WHERE ownerId = ? AND siteUrl = ? AND query = ?
        ORDER BY date DESC LIMIT 1
      `, [ownerId, siteUrl, kw.keyword]);

      if (gscData && gscData.position > 0) {
        positionToRecord = Math.round(gscData.position);
        matchedUrl = 'gsc_aggregated';
        foundInGsc = true;
      }
    }

    if (!foundInGsc) {
      try {
        await delay(1000 + Math.random() * 2000);

        const glLocation = String(kw.location || 'US').toLowerCase();
        const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(keyword)}&num=100&hl=en&gl=${glLocation}`;
        const response = await fetch(googleUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml',
            'Accept-Language': 'en-GB,en;q=0.9',
          },
        });

        if (response.ok) {
          const html = await response.text();
          const $ = cheerio.load(html);
          let currentPosition = 1;
          let foundUrl = false;

          $('.g').each((_: number, el: any) => {
            const link = $(el).find('a[href^="http"]').first();
            if (link.length > 0) {
              const href = link.attr('href') || '';
              if (!href.includes('google.com') && !href.includes('googleusercontent')) {
                if (href.includes(currentTargetDomain)) {
                  positionToRecord = currentPosition;
                  matchedUrl = href;
                  foundUrl = true;
                  return false;
                }
                currentPosition++;
              }
            }
            return undefined;
          });

          const resultsCount = $('.g').length;
          if (!foundUrl && (html.includes('sorry/index') || html.includes('enablejs') || html.includes('CONSENT') || resultsCount === 0)) {
            positionToRecord = 101;
            matchedUrl = null;
          }
        } else {
          console.error(`Failed to fetch SERP for '${keyword}': ${response.status}`);
          positionToRecord = 101;
          matchedUrl = null;
        }
      } catch (error) {
        console.error(`Scrape error for '${keyword}':`, error);
      }
    }

    await db.run(`
      INSERT INTO keyword_rankings (keywordId, date, position, rankingUrl)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(keywordId, date) DO UPDATE SET
        position=excluded.position,
        rankingUrl=excluded.rankingUrl
    `, [kw.id, today, positionToRecord, matchedUrl]);

    syncCount++;
  }

  return { success: true, count: syncCount };
}

export function startRankTrackingScheduler(db: AppDatabase) {
  let isRunning = false;

  const tick = async () => {
    if (isRunning) {
      return;
    }

    isRunning = true;

    try {
      const sites = await db.all<{ ownerId: string; siteUrl: string }>(`
        SELECT DISTINCT ownerId, siteUrl
        FROM tracked_keywords
        WHERE ownerId IS NOT NULL
          AND TRIM(ownerId) <> ''
          AND siteUrl IS NOT NULL
          AND TRIM(siteUrl) <> ''
      `);

      for (const site of sites) {
        try {
          await syncRankTrackingForSite(db, site.ownerId, site.siteUrl, { force: false });
        } catch (error) {
          console.error(`Daily cron sync error for ${site.ownerId}:${site.siteUrl}:`, error);
        }
      }
    } catch (error) {
      console.error('Daily cron error:', error);
    } finally {
      isRunning = false;
    }
  };

  const timer = setInterval(() => void tick(), RANK_TRACKING_SCHEDULER_MS);
  setTimeout(() => void tick(), 20_000);
  return () => clearInterval(timer);
}
