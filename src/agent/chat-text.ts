/**
 * Minecraft chat draws `&` codes, never Markdown: `**word**` reaches the player as two stars on each side. The prompt
 * asks for codes, yet a model slips now and then (Haiku wrote «ставят на **ботинки**» on 2026-10-24), so the answer,
 * and what say and finish tell the player, go through here before the plugin and the session get them: bold becomes
 * &l, italics &o, headings bold lines, and code marks go. Every plugin gets it, old ones too, without a release.
 *
 * Stars and underscores that mean something else stay: products (2*3*4, 2 * 3), wildcards (allay.*, *.yml), ids
 * (redbull:winter_apple), and anything that could be a player's name (_Steve_, __Alex__). Button tags and links pass
 * untouched. Nothing reaches across a line, so the stream can be cut at line ends (see [ChatText]).
 */

// A button tag as the plugin reads it, and a link, are passed whole; inline code loses its backticks and nothing more.
const OPAQUE = /<button\b[^>]*>[^<]*<\/button>|https?:\/\/[^\s<>]+|`([^`\n]+)`/g;
const FENCE = /^[ \t]*```[^\n]*(?:\n|$)/gm;
const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+([^\n]*?)[ \t]*#*[ \t]*$/gm;
// A delimiter opens after a space, punctuation, a code, or the line's start, and closes before one: never inside a word.
const EDGE_BEFORE = String.raw`(?<!(?<!&)[\p{L}\p{N}*_\\])`;
const EDGE_AFTER = String.raw`(?![\p{L}\p{N}*_])`;
const STRONG_ITALIC = new RegExp(String.raw`${EDGE_BEFORE}(\*\*\*|___)(?=\S)([^\n]+?)(?<=\S)\1${EDGE_AFTER}`, "gu");
const STRONG = new RegExp(String.raw`${EDGE_BEFORE}(\*\*|__)(?=\S)([^\n]+?)(?<=[^\s\\])\1${EDGE_AFTER}`, "gu");
// Italics must start with a letter, a digit, a code, or a quote, so `*,` and `*.` (wildcards) never open one.
const ITALIC = new RegExp(String.raw`${EDGE_BEFORE}([*_])(?=[\p{L}\p{N}&«"“'(])([^\n]+?)(?<=[^\s\\])\1${EDGE_AFTER}`, "gu");
// What a Minecraft name may be: letters, digits, underscores, 3 to 16 of them.
const PLAYER_NAME = /^\w{3,16}$/;
const LEADING_COLORS = /^(?:&[0-9a-fA-F])+/;
const CODE = /&([0-9a-fk-orA-FK-OR])/g;

/**
 * The color and formats in force after [before] on its last line, as the game reads codes, so a stretch can give them
 * back after its &r. Only the line counts, so a stream cut at line ends styles as the whole text does.
 */
const styleAfter = (before: string) => {
  let color = "";
  let formats = "";
  for (const [, code] of before.slice(before.lastIndexOf("\n") + 1).matchAll(CODE)) {
    const c = code!.toLowerCase();
    if (c === "r") [color, formats] = ["", ""];
    else if ("0123456789abcdef".includes(c)) [color, formats] = [`&${c}`, ""];
    else if (!formats.includes(c)) formats += `&${c}`;
  }
  return color + formats;
};

/** [inner] in [formats], then back to the style before it. A color after &l would end the bold, so colors go first. */
const wrap = (formats: string, inner: string, before: string) => {
  const colors = LEADING_COLORS.exec(inner)?.[0] ?? "";
  return `${colors}${formats}${inner.slice(colors.length)}&r${styleAfter(before)}`;
};

const styled = (formats: string, before: string) => (whole: string, marker: string, inner: string, offset: number, text: string) =>
  // An underscored word may be somebody's name; a name is never emphasis.
  marker.startsWith("_") && PLAYER_NAME.test(whole) ? whole : wrap(formats, inner, before + text.slice(0, offset));

const emphasis = (text: string, before: string) =>
  text
    .replace(STRONG_ITALIC, styled("&l&o", before))
    .replace(STRONG, styled("&l", before))
    .replace(ITALIC, styled("&o", before));

const heading = (_: string, title: string) => {
  const plain = title.replace(/^(\*\*|__)(.+)\1$/, "$2");
  return plain ? wrap("&l", plain, "") : "";
};

/** Turns the Markdown a model may write into Minecraft's `&` codes; text without Markdown comes back as it was. */
export const toMinecraft = (text: string): string => {
  if (!/[*_`#]/.test(text)) return text;
  const lines = text.replace(FENCE, "").replace(HEADING, heading);
  let out = "";
  let at = 0;
  for (const match of lines.matchAll(OPAQUE)) {
    out += emphasis(lines.slice(at, match.index), out) + (match[1] ?? match[0]);
    at = match.index + match[0].length;
  }
  return out + emphasis(lines.slice(at), out);
};

/**
 * [toMinecraft] for a stream: it hands on whole lines and keeps the rest until its line ends, a tool call comes, or
 * the stream does ([flush]). A button tag split over lines waits whole. The pieces add up to [toMinecraft] of the whole.
 */
export class ChatText {
  private held = "";

  push(delta: string): string {
    this.held += delta;
    let cut = this.held.lastIndexOf("\n") + 1;
    const open = this.held.lastIndexOf("<button", cut);
    if (open >= 0 && !this.held.slice(open, cut).includes("</button>")) cut = this.held.lastIndexOf("\n", open) + 1;
    if (cut <= 0) return "";
    const ready = this.held.slice(0, cut);
    this.held = this.held.slice(cut);
    return toMinecraft(ready);
  }

  flush(): string {
    const rest = this.held;
    this.held = "";
    return rest ? toMinecraft(rest) : "";
  }
}
