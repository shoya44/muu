// 長押しで持ち上げ、指に追従して並べ替える。ハンドル要素は即座に、行本体は長押し後に掴む。
// 指を離すまでは DOM を動かさない。持ち上げた行だけが指に付いて動き、他の行は空く場所へ滑る。
// 離したら行を落とし、その時点の順序で onMove(from, to) を呼ぶ。縦一列のリスト専用。
const HOLD = 350;     // ms。行本体を掴むまでの長押し時間。
const SLOP = 8;       // px。これ以上動いたら長押しではなくスクロール。
const SETTLE = 160;   // ms。行が空いた場所へ滑る時間。
const EDGE = 48;      // px。この幅で画面の端に近づくと一覧をスクロールする。

export function makeSortable(list, { itemSelector, handleSelector, onMove, canMove = () => true }) {
  let drag, timer;

  function items() { return [...list.querySelectorAll(itemSelector)]; }
  const scroller = () => {
    for (let el = list.parentElement; el; el = el.parentElement) {
      const { overflowY } = getComputedStyle(el);
      if (overflowY === 'auto' || overflowY === 'scroll') return el;
    }
    return document.scrollingElement;
  };
  // 指の位置を一覧の座標に直す。一覧がスクロールしても行の layout 位置は変わらないので、比較はこの座標で行う。
  const listY = clientY => clientY - list.getBoundingClientRect().top;

  function lift(item, pointerId, clientY) {
    const rows = items();
    const from = rows.indexOf(item);
    const tops = rows.map(el => el.offsetTop);
    const step = rows.length > 1 ? (tops[rows.length - 1] - tops[0]) / (rows.length - 1) : item.offsetHeight;
    drag = { item, pointerId, from, to: from, rows, tops, step, height: item.offsetHeight, grabY: listY(clientY) - tops[from], scroller: scroller() };
    item.classList.add('dragging');
    item.style.position = 'relative';
    item.style.transition = 'none';
    for (const el of rows) if (el !== item) el.style.transition = `transform ${SETTLE}ms`;
    list.style.touchAction = 'none';
    try { item.setPointerCapture(pointerId); } catch { /* 既に離されている */ }
    if (navigator.vibrate) navigator.vibrate(10);
  }

  list.addEventListener('pointerdown', event => {
    if (!event.isPrimary || drag) return;
    const item = event.target.closest(itemSelector);
    if (!item || !list.contains(item) || !canMove(item)) return;
    const handle = handleSelector && event.target.closest(handleSelector);
    // ハンドルからの持ち上げは即座に決まるので、外側（シートの引き下げ）には渡さない。
    if (handle) { event.preventDefault(); event.stopPropagation(); lift(item, event.pointerId, event.clientY); return; }
    if (event.target.closest('button,input')) return;
    const startX = event.clientX, startY = event.clientY;
    const cancel = () => { clearTimeout(timer); list.removeEventListener('pointermove', watch); list.removeEventListener('pointerup', cancel); list.removeEventListener('pointercancel', cancel); };
    const watch = e => { if (Math.abs(e.clientX - startX) > SLOP || Math.abs(e.clientY - startY) > SLOP) cancel(); };
    list.addEventListener('pointermove', watch); list.addEventListener('pointerup', cancel); list.addEventListener('pointercancel', cancel);
    timer = setTimeout(() => { cancel(); lift(item, event.pointerId, event.clientY); }, HOLD);
  });
  // iOS は touch の途中で touch-action を変えても効かない。持ち上げた後の指の動きはここでスクロールから守る。
  list.addEventListener('touchmove', event => { if (drag) event.preventDefault(); }, { passive: false });

  function follow(clientY) {
    const { item, rows, tops, step, height, grabY, from } = drag;
    const top = listY(clientY) - grabY;
    item.style.transform = `translateY(${top - tops[from]}px)`;
    // 持ち上げた行の中心が、どの行の中心を越えたかで落とす場所を決める。他の行は元の位置を基準に見る。
    // 落とす場所 = 中心より上にある他の行の数。端を越えても、それ以上は動かない。
    const center = top + height / 2;
    let to = 0;
    for (let i = 0; i < rows.length; i++) if (i !== from && tops[i] + height / 2 < center) to++;
    drag.to = to;
    for (let i = 0; i < rows.length; i++) {
      if (i === from) continue;
      const shift = i > from && i <= to ? -step : i < from && i >= to ? step : 0;
      rows[i].style.transform = shift ? `translateY(${shift}px)` : '';
    }
  }

  function edgeScroll(clientY) {
    const el = drag.scroller;
    const rect = el === document.scrollingElement ? { top: 0, bottom: innerHeight } : el.getBoundingClientRect();
    if (clientY < rect.top + EDGE) el.scrollTop -= Math.ceil((rect.top + EDGE - clientY) / 4);
    else if (clientY > rect.bottom - EDGE) el.scrollTop += Math.ceil((clientY - rect.bottom + EDGE) / 4);
  }

  list.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    edgeScroll(event.clientY);
    follow(event.clientY);
  });

  function drop() {
    if (!drag) return;
    const { item, rows, tops, from, to } = drag;
    drag = undefined;
    // 空いた場所へ滑らせてから、DOM を入れ替えて transform を消す。見た目の位置は変わらない。
    item.style.transition = `transform ${SETTLE}ms`;
    item.style.transform = `translateY(${tops[to] - tops[from]}px)`;
    list.style.touchAction = '';
    setTimeout(() => {
      for (const el of rows) { el.style.transition = 'none'; el.style.transform = ''; }
      item.classList.remove('dragging'); item.style.position = '';
      if (to !== from) list.insertBefore(item, to > from ? rows[to].nextSibling : rows[to]);
      // 次のフレームまで transition を切ったままにして、戻しが動いて見えないようにする。
      requestAnimationFrame(() => { for (const el of rows) el.style.transition = ''; });
      if (to !== from) onMove(from, to);
    }, SETTLE);
  }
  list.addEventListener('pointerup', drop);
  list.addEventListener('pointercancel', drop);
}
