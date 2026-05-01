import { GoogleGenAI } from '@google/genai';

type GscInsightRow = Record<string, unknown>;

let aiClient: GoogleGenAI | null = null;

function getAiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('AI insights are unavailable until GEMINI_API_KEY is configured.');
  }

  if (!aiClient) {
    aiClient = new GoogleGenAI({ apiKey });
  }

  return aiClient;
}

export async function generateGscInsights(
  data: GscInsightRow[],
  dimension: string,
  searchTerm: string,
  intentFilter: string,
) {
  const topData = data.slice(0, 50);
  const prompt = `
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

  const ai = getAiClient();
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });

  return response.text || '';
}
