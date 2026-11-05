// Only observed secret-section separators and Reference ampersand escaping are presentation.
// Scan tags quote-aware; raw/code spans and enrichers are opaque. Malformed input
// returns the original string, so uncertainty never makes unequal values equal.
function canonicalSecretSeparator(text) {
  let output = "", cursor = 0;
  while (cursor < text.length) {
    const rest = text.slice(cursor);
    const command = /^(?:\[\[|\{\{|(?:[@&][\w.]+|&amp;\w+)\[)/.exec(rest);
    if (command) {
      const open = rest.startsWith("{{") ? "{" : "[";
      const close = open === "{" ? "}" : "]";
      let end = cursor + command[0].indexOf(open), depth = 0, quoted = null;
      for (; end < text.length; end++) {
        if (quoted) {
          if (text[end] === "\\") { end++; continue; }
          if (text[end] === quoted) quoted = null;
          continue;
        }
        if (text[end] === '"' || text[end] === "'") { quoted = text[end]; continue; }
        if (text[end] === open) depth++;
        if (text[end] === close) {
          depth--;
          if (depth === 0) break;
        }
      }
      if (end === text.length) return text;
      // Foundry's server cleanHTML escapes the ampersand in text nodes.
      // Keep the complete Reference input exact; attributes and raw spans never reach here.
      output += text.slice(cursor, end + 1).replace(/^&Reference\[/, "&amp;Reference[");
      cursor = end + 1;
      continue;
    }
    if (text[cursor] !== "<") { output += text[cursor++]; continue; }
    if (rest.startsWith("<!--")) {
      const end = text.indexOf("-->", cursor + 4);
      if (end < 0) return text;
      output += text.slice(cursor, end + 3); cursor = end + 3; continue;
    }
    let quote = null, end = cursor + 1;
    for (; end < text.length; end++) {
      const char = text[end];
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
      else if (char === "<") return text;
    }
    if (end === text.length || quote) return text;
    const tag = text.slice(cursor, end + 1);
    const raw = /^<(script|style|pre|code|textarea)\b/i.exec(tag);
    if (raw) {
      const close = new RegExp(`</${raw[1]}\\s*>`, "ig");
      close.lastIndex = end + 1;
      const match = close.exec(text);
      if (!match || /<(?:script|style|pre|code|textarea)\b/i.test(text.slice(end + 1, match.index))) return text;
      output += text.slice(cursor, close.lastIndex); cursor = close.lastIndex; continue;
    }
    // Exact shape, order and values; no other attributes or attribute syntax accepted.
    output += /^<section class="secret"[\t\n\f\r ]+id="[A-Za-z0-9_-]+">$/.test(tag)
      ? tag.replace(/^(<section class="secret")[\t\n\f\r ]+(id=)/, "$1 $2") : tag;
    cursor = end + 1;
  }
  return output;
}
export function presentationEqual(before, after) {
  return before === after || (typeof before === "string" && typeof after === "string" &&
    canonicalSecretSeparator(before) === canonicalSecretSeparator(after));
}
