// Копирование из сообщений — как в Telegram Web A:
//  • текст — одним элементом буфера: простой текст + HTML в разметке Bot API (strong, em, u, del, code, pre>code,
//    a, tg-spoiler); скрытый текст копируется целиком; запасные пути — writeText, затем скрытое поле и execCommand;
//  • выделенный кусок — клон выделения, обёрнутый в своё оформление до корня текста: полужирное слово остаётся полужирным;
//  • картинка — в PNG через ClipboardItem с обещанием (запись начинается сразу, пока жест пользователя ещё «живой»).
import { readDom, segments } from './richtext.js';

var ORDER = ['link', 'date', 'pre', 'code', 'spoiler', 'bold', 'italic', 'underline', 'strike'];
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
var OPEN = {
  bold: function () { return '<strong>'; }, italic: function () { return '<em>'; }, underline: function () { return '<u>'; }, strike: function () { return '<del>'; },
  code: function () { return '<code>'; }, pre: function () { return '<pre><code>'; }, spoiler: function () { return '<tg-spoiler>'; },
  link: function (url) { return '<a href="' + esc(url) + '">'; },
  date: function (v) { var p = v.split('|'); return '<tg-time unix="' + esc(p[0]) + '"' + (p[1] ? ' format="' + esc(p[1]) + '"' : '') + '>'; },
};
var CLOSE = { bold: '</strong>', italic: '</em>', underline: '</u>', strike: '</del>', code: '</code>', pre: '</code></pre>', spoiler: '</tg-spoiler>', link: '</a>', date: '</tg-time>' };

/** Текст с оформлением → HTML для буфера (разметка Bot API, переводы строк — <br>). */
export function clipboardHtml(text, entities) {
  var html = '', segs = segments(text || '', entities || []);
  for (var i = 0; i < segs.length; i++) {
    var sg = segs[i], open = '', close = '';
    for (var k = 0; k < ORDER.length; k++) { var t = ORDER[k]; if (sg.marks[t]) { open += OPEN[t](sg.marks[t]); close = CLOSE[t] + close; } }
    html += open + (sg.marks.pre ? esc(sg.text) : esc(sg.text).replace(/\n/g, '<br>')) + close;
  }
  return html;
}

/** Выделение внутри root (текст сообщения) → { text, entities } с сохранённым оформлением; нет выделения — null. */
export function selectionValue(root) {
  var sel = root && root.ownerDocument.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  var range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) {
    // выделение шире сообщения — берём только его часть
    if (!range.intersectsNode(root)) return null;
    var r = root.ownerDocument.createRange();
    r.selectNodeContents(root);
    if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset);
    range = r;
  }
  var frag = range.cloneContents();
  // обрывок внутри <b>/<a>/скрытого — обёртываем в копии предков до корня, чтобы оформление не потерялось
  for (var n = range.commonAncestorContainer; n && n !== root; n = n.parentNode) {
    if (n.nodeType !== 1) continue;
    var shell = n.cloneNode(false);
    shell.appendChild(frag);
    frag = root.ownerDocument.createDocumentFragment();
    frag.appendChild(shell);
  }
  var box = root.ownerDocument.createElement('div');
  box.appendChild(frag);
  var v = readDom(box);
  return v.text.replace(/\s+/g, '') ? v : null;
}

/** Записать текст (и HTML) в буфер. Возвращает обещание: true — записано. */
export function copyRich(text, html) {
  var cb = navigator.clipboard;
  function viaTextarea() {
    var doc = document, ta = doc.createElement('textarea'), sel = doc.getSelection(), saved = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    ta.value = text; ta.readOnly = true;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    (doc.querySelector('dialog[open]') || doc.body).appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    if (saved && sel) { sel.removeAllRanges(); sel.addRange(saved); }
    return ok;
  }
  if (cb && html && typeof ClipboardItem === 'function' && cb.write) {
    var item = new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) });
    return cb.write([item]).then(function () { return true; }, function () { return cb.writeText(text).then(function () { return true; }, viaTextarea); });
  }
  if (cb && cb.writeText) return cb.writeText(text).then(function () { return true; }, viaTextarea);
  return Promise.resolve(viaTextarea());
}

function isWebKit() {
  var ua = navigator.userAgent;
  return /iP(hone|ad|od)/.test(ua) || (/Safari\//.test(ua) && !/(Chrome|Chromium|Edg|OPR|Firefox)\//.test(ua));
}
/** Можно ли положить картинку в буфер (как в Telegram Web A: ClipboardItem с image/png, не Safari). */
export function canCopyImage() {
  if (typeof ClipboardItem !== 'function' || !navigator.clipboard || !navigator.clipboard.write || isWebKit()) return false;
  return typeof ClipboardItem.supports === 'function' ? ClipboardItem.supports('image/png') : true;
}

/** Картинка по адресу → PNG (через холст в натуральном размере) → буфер. */
export function copyImage(url) {
  var png = fetch(url, { credentials: 'include' }).then(function (r) {
    if (!r.ok) throw new Error('fetch ' + r.status);
    return r.blob();
  }).then(function (blob) {
    if (blob.type === 'image/png') return blob;
    var draw = typeof createImageBitmap === 'function'
      ? createImageBitmap(blob)
      : new Promise(function (res, rej) { var img = new Image(); img.onload = function () { res(img); }; img.onerror = rej; img.src = URL.createObjectURL(blob); });
    return draw.then(function (src) {
      var c = document.createElement('canvas');
      c.width = src.width || src.naturalWidth; c.height = src.height || src.naturalHeight;
      c.getContext('2d').drawImage(src, 0, 0);
      if (src.close) src.close();
      return new Promise(function (res, rej) { c.toBlob(function (b) { if (b) res(b); else rej(new Error('toBlob')); }, 'image/png', 1); });
    });
  });
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).then(function () { return true; });
}

/** Скачать файл: временная ссылка с download (браузер сам решает, куда сохранить). */
export function downloadUrl(url, name) {
  var a = document.createElement('a');
  a.href = url; a.download = name || ''; a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { a.remove(); }, 100);
}
