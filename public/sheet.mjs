// The playing screen is one surface, not two states. The cover, the title and
// the queue sit in a single column: the queue already starts below the cover,
// so scrolling reveals it and nothing has to be opened, closed or explained.
// The transport stays pinned at the bottom, within reach at any scroll
// position.
//
// Dragging the sheet down dismisses it. That gesture is taken from the handle
// at the top, and from the column itself only when there is nothing left to
// scroll up; otherwise the column scrolls, which is what a pull there means.
const FOLLOW = 6;    // A movement smaller than this has not chosen a direction yet.
const DISMISS = 80;  // Past this a downward pull closes rather than snapping back.

export function setupSheet(dialog, { opening }) {
  const handle = document.getElementById('sheet-gesture');
  const column = document.getElementById('sheet-scroll');
  let drag;

  function offset(value) {
    dialog.style.transform = value ? `translateY(${value}px)` : '';
  }
  function open() {
    if (dialog.open) return;
    offset(0); opening();
    document.body.classList.add('player-open');
    dialog.showModal();
    // 自動フォーカスがキューの先頭に当たって枠が出ないよう、列そのものへ移す。
    column.focus({ preventScroll: true });
    column.scrollTop = 0; atTop();
  }
  // 一番上にいる間は下向きのパンをブラウザに渡さず、こちらで「閉じる」として扱う。
  // 上向き（続きを読むスクロール）はブラウザに任せる。
  const atTop = () => column.classList.toggle('at-top', column.scrollTop <= 0);
  column.addEventListener('scroll', atTop, { passive: true });
  dialog.addEventListener('close', () => {
    document.body.classList.remove('player-open');
    dialog.style.transition = '';
    offset(0);
  });

  function begin(event) {
    if (event.target.closest('button,input') || !event.isPrimary) return;
    const fromColumn = event.currentTarget === column;
    if (fromColumn && column.scrollTop > 0) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, travelled: 0, fromColumn };
    if (!fromColumn) {
      // The handle is the sheet's own gesture, so it is claimed immediately.
      // Without this Chromium cancels the pointer after the first move and the
      // sheet stops following the finger. The column cannot claim it that way:
      // the same touch may turn out to be a scroll.
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
    }
  }
  handle.addEventListener('pointerdown', begin);
  column.addEventListener('pointerdown', begin);

  // The rest is followed on the window: moving the sheet moves what is under
  // the finger, so later events do not reach the element it started on.
  window.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const dy = event.clientY - drag.y, dx = event.clientX - drag.x;
    if (drag.vertical === undefined) {
      if (Math.abs(dy) < FOLLOW && Math.abs(dx) < FOLLOW) return;
      // A sideways start, or an upward pull inside the column, is not this
      // sheet's gesture: the first is nothing, the second is a scroll.
      drag.vertical = Math.abs(dy) > Math.abs(dx);
      if (!drag.vertical || (drag.fromColumn && dy < 0)) { drag = undefined; return; }
      dialog.style.transition = 'none';
      if (drag.fromColumn) { column.setPointerCapture(event.pointerId); }
    }
    event.preventDefault();
    drag.travelled = dy;
    // Downward follows the finger. Upward resists, because the sheet is
    // already as high as it goes.
    offset(dy > 0 ? dy : dy / FOLLOW);
  });
  // The decision is taken from where the finger left the screen, so it holds
  // even when the moves in between were coalesced away.
  function release(event) {
    if (!drag) return;
    const dy = event ? event.clientY - drag.y : drag.travelled;
    drag = undefined;
    dialog.style.transition = '';
    offset(0);
    if (dy >= DISMISS) dialog.close();
  }
  window.addEventListener('pointerup', event => { if (drag?.id === event.pointerId) release(event); });
  // A cancelled pointer still finishes from where it was last seen, rather
  // than leaving the sheet mid-pull with nothing decided.
  window.addEventListener('pointercancel', () => release());
  dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientY < r.top || event.clientX < r.left || event.clientX > r.right) dialog.close(); } });
  return { open };
}
