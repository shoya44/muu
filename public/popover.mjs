import { icon } from './icons.mjs';

// アンカー付きのメニュー。押した要素の近くに開き、外側タップ・スクロール・Escape で閉じる。
// 項目: { icon, label, run, danger, disabled }
export function setupPopover(element) {
  let cleanup;
  function close() {
    if (element.hidden) return;
    element.hidden = true;
    element.replaceChildren();
    cleanup?.(); cleanup = undefined;
  }
  function open(anchor, items) {
    close();
    element.replaceChildren(...items.filter(Boolean).map(item => {
      const button = document.createElement('button');
      button.setAttribute('role', 'menuitem');
      if (item.danger) button.className = 'danger';
      button.disabled = Boolean(item.disabled);
      button.innerHTML = icon(item.icon);
      button.append(item.label);
      button.onclick = () => { close(); item.run(); };
      return button;
    }));
    element.hidden = false;
    // アンカーの右端に揃え、画面からはみ出さないよう位置を決める。
    const rect = anchor.getBoundingClientRect();
    const width = element.offsetWidth, height = element.offsetHeight;
    let left = Math.min(rect.right - width, window.innerWidth - width - 8);
    left = Math.max(8, left);
    let top = rect.bottom + 4;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 4);
    element.style.left = `${left}px`; element.style.top = `${top}px`;
    element.style.transformOrigin = top < rect.top ? 'bottom right' : 'top right';
    const away = event => { if (!element.contains(event.target)) close(); };
    const key = event => { if (event.key === 'Escape') close(); };
    setTimeout(() => {
      document.addEventListener('pointerdown', away, true);
      document.addEventListener('keydown', key);
      window.addEventListener('scroll', close, { capture: true, once: true });
    });
    cleanup = () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', close, { capture: true });
    };
    element.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  }
  return { open, close };
}
