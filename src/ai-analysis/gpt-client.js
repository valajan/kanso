import OpenAI from 'openai';

// Builds the chat client used by the analysis module. Model, limits and
// endpoint all come from the environment (see src/config/env.js) so an
// operator can switch model or provider without touching the code — any
// OpenAI-compatible API works through baseUrl.
//
// Returns null when no API key is configured; the caller treats that as
// "AI analysis disabled" rather than as an error.
export function createGptClient({ apiKey, baseUrl, model, maxTokens, timeoutMs, maxRetries } = {}) {
  if (!apiKey) return null;

  const client = new OpenAI({
    apiKey,
    ...(baseUrl ? { baseURL: baseUrl } : {}),
    timeout: timeoutMs,
    maxRetries,
  });

  async function requestAnalysis(prompt, { log, json = false } = {}) {
    log?.info?.({ model, json }, '[ai-analysis] calling AI provider');

    try {
      const completion = await client.chat.completions.create({
        model,
        max_completion_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      });

      const content = completion.choices?.[0]?.message?.content;
      if (!content) throw new Error('AI provider returned no content');
      return content.trim();
    } catch (err) {
      if (err?.status === 429) {
        throw new Error(`AI provider rate limit: ${err.message}`);
      }
      if (err?.name === 'APIConnectionTimeoutError' || err?.code === 'ETIMEDOUT') {
        throw new Error('AI request timed out');
      }
      if (err?.status) {
        throw new Error(`AI request failed (${err.status}): ${err.message}`);
      }
      throw err;
    }
  }

  return { model, baseUrl, requestAnalysis };
}
