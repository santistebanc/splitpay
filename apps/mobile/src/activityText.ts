import type { TextStyle } from "react-native";

export function withoutLeadingActor(summary: string, actorName: string) {
  if (!actorName) return summary;
  const prefix = `${actorName} `;
  return summary.startsWith(prefix) ? summary.slice(prefix.length) : summary;
}

export function splitActivitySummary(
  summary: string,
  highlights: Array<{ value: string; style: TextStyle }>
) {
  const parts: Array<{ text: string; style?: TextStyle }> = [];
  let cursor = 0;

  while (cursor < summary.length) {
    const next = highlights
      .filter((highlight, index, all) => highlight.value && all.findIndex((item) => item.value === highlight.value) === index)
      .map((highlight) => ({ ...highlight, index: summary.indexOf(highlight.value, cursor) }))
      .filter((highlight) => highlight.index >= 0)
      .sort((a, b) => a.index - b.index || b.value.length - a.value.length)[0];

    if (!next) {
      parts.push({ text: summary.slice(cursor) });
      break;
    }

    if (next.index > cursor) parts.push({ text: summary.slice(cursor, next.index) });
    parts.push({ text: next.value, style: next.style });
    cursor = next.index + next.value.length;
  }

  return parts;
}
