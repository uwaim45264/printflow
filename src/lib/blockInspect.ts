// Blocks the common ways to open the browser's inspect / developer tools:
// right-click menu, F12, Ctrl+Shift+I/J/C/K, Ctrl+U (view source) and the macOS Cmd+Option equivalents.
// Note: this only deters casual users - it cannot stop someone who opens DevTools from the browser menu.
export function blockInspect(): void {
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  document.addEventListener(
    'keydown',
    (e) => {
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      const blocked =
        key === 'f12' ||
        (mod && (e.shiftKey || e.altKey) && ['i', 'j', 'c', 'k'].includes(key)) ||
        (mod && key === 'u');
      if (blocked) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
}
