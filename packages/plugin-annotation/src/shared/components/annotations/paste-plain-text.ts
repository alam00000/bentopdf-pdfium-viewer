export function pastePlainText(e: {
  preventDefault(): void;
  clipboardData: DataTransfer | null;
}): void {
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain') ?? '';
  text.split(/\r\n?|\n/).forEach((line, i) => {
    if (i > 0) document.execCommand('insertParagraph');
    if (line) document.execCommand('insertText', false, line);
  });
}
