import { Api } from 'teleproto';

export function normalizeDigits(text) {
  return text.replace(/[۰-۹٠-٩]/g, digit => {
    const persian = '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit);
    return String(persian < 0 ? '٠١٢٣٤٥٦٧٨٩'.indexOf(digit) : persian);
  });
}

// Only Telegram code entities are emitted: no Markdown/HTML parsing of names,
// references or errors. Match known command syntax, not the surrounding prose.
const COMMAND = /\/(?:source[ \t]+(?:list(?:[ \t]+(?:\[PAGE\]|PAGE|\d+))?|(?:add|remove)[ \t]+(?:GROUP_ID|ID|REF))|allow[ \t]+(?:list(?:[ \t]+(?:\[PAGE\]|PAGE|\d+))?|add[ \t]+(?:CHANNEL_ID|GROUP_ID|REF)|remove[ \t]+RULE_NUMBER)|rule[ \t]+(?:RULE_NUMBER\|all|RULE_NUMBER|all|\d+)[ \t]+(?:forwards|replies)[ \t]+(?:on\|off|on|off)|destination[ \t]+(?:show|set[ \t]+REF)|data[ \t]+(?:export|sample|import[ \t]+(?:merge\|replace|merge|replace)[ \t]+confirm)|queue[ \t]+clear[ \t]+confirm|linked(?:[ \t]+(?:GROUP_REF|REF))?|join(?:[ \t]+(?:LINK_OR_USERNAME|REF))?|sync|pause|resume|status|errors|menu|help|cancel|start)(?![\w/-])/g;

export function adminTextChunks(text) {
  const limit = 3500;
  const matches = [...text.matchAll(COMMAND)];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    // Do not split a copyable command (or a UTF-16 surrogate pair).
    const crossing = matches.find(match => match.index < end && match.index + match[0].length > end);
    if (crossing && crossing.index > start) end = crossing.index;
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    const formattingEntities = matches.filter(match => match.index >= start && match.index + match[0].length <= end)
      .map(match => new Api.MessageEntityCode({ offset: match.index - start, length: match[0].length }));
    chunks.push({ message: text.slice(start, end), formattingEntities });
    start = end;
  }
  return chunks;
}
