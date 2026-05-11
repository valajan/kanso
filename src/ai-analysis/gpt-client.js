import OpenAI from 'openai';

const MODEL = 'gpt-5.4';
const MAX_TOKENS = 1000;
const TIMEOUT_MS = 30_000;

let cachedClient = null;

function getClient() {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  cachedClient = new OpenAI({ apiKey, timeout: TIMEOUT_MS });
  return cachedClient;
}

export async function requestAnalysis(prompt, { log } = {}) {
  log?.info?.({ model: MODEL }, '[ai-analysis] calling OpenAI');
  const client = getClient();

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenAI response missing content');
    return content.trim();
  } catch (err) {
    if (err?.status === 429) {
      throw new Error(`OpenAI rate limit: ${err.message}`);
    }
    if (err?.name === 'APIConnectionTimeoutError' || err?.code === 'ETIMEDOUT') {
      throw new Error('OpenAI request timed out');
    }
    if (err?.status) {
      throw new Error(`OpenAI request failed (${err.status}): ${err.message}`);
    }
    throw err;
  }
}
