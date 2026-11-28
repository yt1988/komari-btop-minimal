export function updateText(element: Node, value: string): void {
  const text = element.firstChild;
  if (text instanceof Text && text === element.lastChild) {
    if (text.data !== value) text.data = value;
    return;
  }
  if (element.textContent !== value) {
    element.textContent = value;
  }
}

export function updateClass(element: HTMLElement, value: string): void {
  if (element.className !== value) {
    element.className = value;
  }
}
