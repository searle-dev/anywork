import { config } from "../config";

/**
 * Generate a short session title by calling the LLM API directly.
 * Uses an OpenAI-compatible endpoint for title generation.
 * Returns null on any failure so callers can silently skip.
 */
export async function generateTitle(userMessage: string): Promise<string | null> {
  if (!config.title.apiKey || !config.title.apiBaseUrl) return null;

  try {
    const response = await fetch(`${config.title.apiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.title.apiKey}`,
      },
      body: JSON.stringify({
        model: config.title.model,
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
