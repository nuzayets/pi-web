/**
 * Session event subscription opt-in (`toolText=derived`): `tool.update` and
 * `tool.end` frames omit `text` when {@link toolTextFromContent} rebuilds it
 * exactly from the frame's `content`. Older clients never send it, and older
 * servers ignore it and keep sending `text`.
 */
export const SESSION_TOOL_TEXT_DERIVED = "derived";

/**
 * Tool event text as the server joins it from text and image blocks, or
 * undefined for content of any other shape. Only plain JSON strings are read,
 * so the result is the same before and after the frame crosses the wire.
 */
export function toolTextFromContent(content: unknown): string | undefined {
  if (!isUnknownArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) return undefined;
    const text = block["text"];
    if (block["type"] === "image") texts.push("[image]");
    else if (block["type"] === "text" && typeof text === "string") texts.push(text);
    else return undefined;
  }
  return texts.filter((text) => text !== "").join("\n");
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
