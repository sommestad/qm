export interface BriefingInput {
  title: string;
  summary: string;
  sourceUrl: string;
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value))
    throw new Error("invalid card text");
  return value.trim();
}

export function parseBriefingInput(body: unknown): BriefingInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid card");
  const b = body as Record<string, unknown>;
  const url = new URL(text(b.sourceUrl, 1500));
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("source must be HTTPS");
  return { title: text(b.title, 150), summary: text(b.summary, 1800), sourceUrl: url.href };
}

export function briefingCardMessage(input: BriefingInput) {
  const card = parseBriefingInput(input);
  const help =
    "Markera med Slacks reaktioner: ✅ = klar, ⭐ = viktig. Ta bort din reaktion för att ångra. Markeringarna gäller bara i Slack. Utkast bygger på kortets underlag, inte en ny läsning av källan. Svara i tråden för att diskutera.";
  return {
    text: `${card.title}\n${card.summary}\n${card.sourceUrl}\n${help}`,
    blocks: [
      { type: "header", block_id: "briefing_title", text: { type: "plain_text", text: card.title } },
      { type: "section", block_id: "briefing_summary", text: { type: "plain_text", text: card.summary } },
      {
        type: "actions",
        block_id: "briefing_actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Öppna källa" },
            url: card.sourceUrl,
            action_id: "briefing_source",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Skriv utkast" },
            action_id: "briefing_draft",
            value: "draft",
          },
        ],
      },
      { type: "context", elements: [{ type: "plain_text", text: help }] },
    ],
  };
}

export function briefingInputFromMessage(message: { blocks?: any[] }): BriefingInput {
  const blocks = message.blocks ?? [];
  const title = blocks.find((b) => b.block_id === "briefing_title")?.text;
  const summary = blocks.find((b) => b.block_id === "briefing_summary")?.text;
  const actions = blocks.find((b) => b.block_id === "briefing_actions")?.elements;
  if (
    title?.type !== "plain_text" ||
    summary?.type !== "plain_text" ||
    !Array.isArray(actions) ||
    !actions.some((a) => a.action_id === "briefing_draft")
  )
    throw new Error("not a briefing card");
  return parseBriefingInput({
    title: title.text,
    summary: summary.text,
    sourceUrl: actions.find((a) => a.action_id === "briefing_source")?.url,
  });
}

export function isBriefingMark(message: { blocks?: any[] }, emoji: string): boolean {
  if (emoji !== "white_check_mark" && emoji !== "star") return false;
  try {
    briefingInputFromMessage(message);
    return true;
  } catch {
    return false;
  }
}
