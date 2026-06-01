type GscInsightRow = Record<string, unknown>;

export class AiProviderNotConfiguredError extends Error {
  constructor() {
    super('AI insights are temporarily unavailable while the LLM provider is being configured.');
    this.name = 'AiProviderNotConfiguredError';
  }
}

export async function generateGscInsights(
  data: GscInsightRow[],
  dimension: string,
  searchTerm: string,
  intentFilter: string,
) {
  const topData = data.slice(0, 50);
  void `
You are an expert SEO analyst. I am providing you with Google Search Console data for a website.
The data is grouped by: ${dimension}.
${searchTerm ? `The user has filtered the data to only include queries containing: "${searchTerm}".` : ''}
${intentFilter !== 'all' ? `The user has filtered for "${intentFilter}" intent.` : ''}

Here is the data (Top ${topData.length} rows):
${JSON.stringify(topData, null, 2)}

Please provide a concise, actionable SEO analysis based on this data.
Format your response in Markdown. Include:
1. **Key Observations:** What stands out? (e.g., high impressions but low CTR, top performing queries).
2. **Opportunities:** What are the quick wins? (e.g., queries ranking in positions 11-20 that could be pushed to page 1).
3. **Action Plan:** 3-4 specific recommendations for the content or SEO team.

Keep it professional, insightful, and directly related to the provided data. Do not use generic SEO advice if it doesn't apply to the data.
  `;

  throw new AiProviderNotConfiguredError();
}

export async function generateContentAuditBrief(data: GscInsightRow[], siteUrl: string) {
  const topData = data.slice(0, 40);
  void `
You are an expert SEO content strategist. I am providing a prioritized content audit for ${siteUrl}.
Each row includes crawl quality signals and, when available, Google Search Console page performance.

Audit rows:
${JSON.stringify(topData, null, 2)}

Write a concise markdown brief for a content team. Include:
1. **Highest priority fixes:** pages or patterns to address first.
2. **Content opportunities:** pages with search demand or engagement potential.
3. **Technical blockers:** indexability, metadata, canonical, word count, or internal-link issues that limit performance.
4. **Next sprint plan:** 5 specific actions.

Avoid generic advice. Tie every recommendation to the provided rows.
  `;

  throw new AiProviderNotConfiguredError();
}
