// 長押しで持ち上げ、指に追従して並べ替える。ハンドル要素は即座に、行本体は長押し後に掴む。
// 順序が変わったら onMove(from, to) を呼ぶ。縦一列のリスト専用。
const HOLD = 350;   // ms。行本体を掴むまでの長押し時間。
const SLOP = 8;     // px。これ以上動いたら長押しではなくスクロール。

export function makeSortable(list, { itemSelector, handleSelector, onMove, canMove = () => true }) {
  let drag, timer;

  function items() { return [...list.querySelectorAll(itemSelector)]; }
  function indexOf(element) { return items().indexOf(element); }

  function lift(item, pointerId, y) {
    const rect = item.getBoundingClientRect();
    drag = { item, pointerId, from: indexOf(item), offsetY: y - rect.top, height: rect.height, startY: y };
    item.classList.add('dragging');
    item.style.position = 'relative';
    list.style.touchAction = 'none';
    try { item.setPointerCapture(pointerId); } catch { /* 既に離されている */ }
    if (navigator.vibrate) navigator.vibrate(10);
  }

  list.addEventListener('pointerdown', event => {
    if (!event.isPrimary) return;
    const item = event.target.closest(itemSelector);
    if (!item || !list.contains(item) || !canMove(item)) return;
    const handle = handleSelector && event.target.closest(handleSelector);
    if (handle) { event.preventDefault(); lift(item, event.pointerId, event.clientY); return; }
    if (event.target.closest('button,input')) return;
    const startX = event.clientX, startY = event.clientY;
    const cancel = () => { clearTimeout(timer); list.removeEventListener('pointermove', watch); list.removeEventListener('pointerup', cancel); list.removeEventListener('pointercancel', cancel); };
    const watch = e => { if (Math.abs(e.clientX - startX) > SLOP || Math.abs(e.clientY - startY) > SLOP) cancel(); };
    list.addEventListener('pointermove', watch); list.addEventListener('pointerup', cancel); list.addEventListener('pointercancel', cancel);
    timer = setTimeout(() => { cancel(); lift(item, event.pointerId, event.clientY); }, HOLD);
  });

  list.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const dy = event.clientY - drag.startY;
    drag.item.style.transform = `translateY(${dy}px)`;
    // 中心が隣の行の中心を越えたら入れ替える。
    const siblings = items().filter(el => el !== drag.item);
    const center = event.clientY - drag.offsetY + drag.height / 2;
    let target = siblings.findIndex(el => { const r = el.getBoundingClientRect(); return center < r.top + r.height / 2; });
    if (target < 0) target = siblings.length;
    const current = indexOf(drag.item);
    if (target !== current) {
      const ref = siblings[target] || null;
      list.insertBefore(drag.item, ref);
      const rect = drag.item.getBoundingClientRect();
      // 移動後の位置を基準に、指との差だけを残す。
      drag.startY = event.clientY - (event.clientY - drag.offsetY - rect.top);
      drag.item.style.transform = `translateY(${event.clientY - drag.offsetY - rect.top}px)`;
    }
  });

  function drop() {
    if (!drag) return;
    const { item, from } = drag;
    drag = undefined;
    item.classList.remove('dragging'); item.style.transform = ''; item.style.position = '';
    list.style.touchAction = '';
    const to = indexOf(item);
    if (to !== from && to >= 0) onMove(from, to);
  }
  list.addEventListener('pointerup', drop);
  list.addEventListener('pointercancel', drop);
}
