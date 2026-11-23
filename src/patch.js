// OpenCode gives some models (the GPT family) `apply_patch` in place of `write` and `edit`. A patch names its
// files inside one text argument, so anything that checks what a tool writes has to read them out of it.
const HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/;

/** The files a patch touches: [{op: 'add'|'update'|'delete', path, content}] — content only for added files. */
export function patchFiles(text) {
  const files = [];
  let current;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const header = HEADER.exec(line);
    if (header) { current = { op: header[1].toLowerCase(), path: header[2].trim(), lines: [] }; files.push(current); }
    else if (line.startsWith('*** ')) current = undefined;
    else if (current?.op === 'add' && line.startsWith('+')) current.lines.push(line.slice(1));
  }
  return files.map(({ op, path, lines }) => ({ op, path, ...(op === 'add' && { content: lines.join('\n') }) }));
}

/** The same patch with the added file at `path` holding `content` instead. */
export function replaceAdded(text, path, content) {
  const out = [];
  let skipping = false;
  for (const line of String(text).split(/\r?\n/)) {
    const header = HEADER.exec(line);
    if (header || line.startsWith('*** ')) skipping = false;
    if (skipping) continue;
    out.push(line);
    if (header?.[1] === 'Add' && header[2].trim() === path) {
      out.push(...content.replace(/\n$/, '').split('\n').map(l => `+${l}`));
      skipping = true;
    }
  }
  return out.join('\n');
}
