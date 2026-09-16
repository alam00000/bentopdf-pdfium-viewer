export function readEditorText(editor: HTMLElement): string {
  editor.normalize();
  const lines: string[] = [];
  let line: string | null = null;
  const read = (parent: Node) => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        line = (line ?? '') + (node.nodeValue ?? '').replace(/\r\n?|\n/g, '');
      } else if (node.nodeName === 'BR') {
        lines.push(line ?? '');
        line = null;
      } else if (node.nodeName === 'DIV' || node.nodeName === 'P') {
        if (line !== null) lines.push(line);
        line = null;
        read(node);
        if (line !== null) lines.push(line);
        line = null;
      } else {
        read(node);
      }
    }
  };
  read(editor);
  if (line !== null) lines.push(line);
  return lines.join('\n');
}
