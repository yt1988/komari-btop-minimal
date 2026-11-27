export function updateText(element: Node, value: string): void {
  if (element.textContent !== value) {
    element.textContent = value;
  }
}

export function updateClass(element: HTMLElement, value: string): void {
  if (element.className !== value) {
    element.className = value;
  }
}
