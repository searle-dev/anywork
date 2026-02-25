import { config } from "../config";

/**
 * Generate a short session title by calling the LLM API directly.
 * Uses the same OpenAI-compatible endpoint as the worker.
 * Returns null on any failure so callers can silently skip.
 */
export async function generateTitle(userMessage: string): Promise<string | null> {
  if (!config.llmApiKey || !config.llmApiBaseUrl) return null;

  try {
    const response = await fetch(`${config.llmApiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.llmApiKey}`,
      },
      body: JSON.stringify({
        model: config.titleModel,
        messages: [
          {
            role: "user",
            content:
              "请用5-10个字为以下消息生成一个对话标题，只输出标题文字，不加标点或解释：\n" +
              userMessage.slice(0, 200),
          },
        ],
        max_tokens: 30,
      }),
    });

    if (!response.ok) return null;

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw: string = data.choices?.[0]?.message?.content ?? "";
    const title = raw.trim().replace(/^["'「」\s]+|["'「」\s]+$/g, "");
    return title || null;
  } catch {
    return null;
  }
}
