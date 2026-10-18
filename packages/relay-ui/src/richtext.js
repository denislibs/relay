// Текст с форматированием: модель { text, entities } и её отображение в DOM поля ввода и обратно.
// Сущность — { type, offset, length, url? } в единицах UTF-16 (как String.length), без вложенности:
// разные типы могут перекрываться, один тип — нет (соседние куски одного типа склеиваются).
// Источник правды при вводе — DOM поля: значение читается из него одним обходом, когда нужно.

export var FORMATS = ['bold', 'italic', 'underline', 'strike', 'spoiler', 'code', 'pre', 'link'];
// порядок обёрток снаружи внутрь: ссылка и моноширинный — внешние, остальное — внутри
var ORDER = ['link', 'pre', 'code', 'spoiler', 'bold', 'italic', 'underline', 'strike'];
// моноширинный не сочетается с остальным оформлением (как в Telegram)
var MONO = { code: 1, pre: 1 };
var EMPTY = { text: '', entities: [] };

export function emptyValue() { return { text: '', entities: [] }; }

/* ---------- чтение DOM → значение ---------- */

var BLOCK = /^(DIV|P|LI|UL|OL|H[1-6]|BLOCKQUOTE|PRE|TR|TABLE|SECTION|ARTICLE|HEADER|FOOTER)$/;

function marksOf(el, parent) {
  var tag = el.nodeName, m = null;
  function add(type, v) { if (!m) m = Object.assign({}, parent); m[type] = v === undefined ? true : v; }
  function drop(type) { if (parent[type] || (m && m[type])) { if (!m) m = Object.assign({}, parent); delete m[type]; } }
  if (tag === 'B' || tag === 'STRONG') add('bold');
  else if (tag === 'I' || tag === 'EM') add('italic');
  else if (tag === 'U' || tag === 'INS') add('underline');
  else if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') add('strike');
  else if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' || tag === 'TT') add(el.getAttribute('data-pre') != null || (el.parentNode && el.parentNode.nodeName === 'PRE') ? 'pre' : 'code');
  else if (tag === 'PRE') add('pre');
  else if (tag === 'A') { var href = el.getAttribute('href'); if (href && safeUrl(href)) add('link', safeUrl(href)); }
  if (el.getAttribute && el.getAttribute('data-fmt') === 'spoiler') add('spoiler');
  // оформление стилями (вставка из Google Docs, Word): учитываем и «отмену» — <b style="font-weight:normal">
  var st = el.style;
  if (st) {
    var fw = st.fontWeight;
    if (fw === 'bold' || fw === 'bolder' || +fw >= 600) add('bold'); else if (fw === 'normal' || (+fw && +fw < 600)) drop('bold');
    if (st.fontStyle === 'italic' || st.fontStyle === 'oblique') add('italic'); else if (st.fontStyle === 'normal') drop('italic');
    var td = st.textDecorationLine || st.textDecoration || '';
    if (td.indexOf('underline') >= 0) add('underline');
    if (td.indexOf('line-through') >= 0) add('strike');
    if (/monospace/i.test(st.fontFamily || '')) add('code');
  }
  return m || parent;
}

/** Ссылка, которую можно показать: только http(s) и mailto; без протокола — https. */
export function safeUrl(raw) {
  var s = String(raw || '').trim();
  if (!s || /\s/.test(s) || s.length > 2048) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  if (!/^(https?:\/\/[^/?#]+|mailto:[^@\s]+@)/i.test(s)) return null;
  return s;
}

// <br>, после которого в своём блоке ничего нет, — «подпорка» последней строки, а не перевод строки
function trailingBr(br, root) {
  var n = br;
  while (n && n !== root) {
    for (var s = n.nextSibling; s; s = s.nextSibling) {
      if (s.nodeType === 3 ? s.data.length : s.nodeType === 1) return false;
    }
    n = n.parentNode;
    if (n && n !== root && BLOCK.test(n.nodeName)) return true;
  }
  return true;
}

/**
 * DOM → { text, entities }; с sel — ещё start/end выделения в символах текста.
 * Неизвестные теги — просто контейнеры: из вставленного HTML в значение попадает только текст и известное оформление.
 */
export function readDom(root, sel) {
  var out = '', entities = [], open = {}, start = -1, end = -1;
  var a = sel ? [sel.anchorNode, sel.anchorOffset] : null, f = sel ? [sel.focusNode, sel.focusOffset] : null;
  var aPos = -1, fPos = -1;
  function at(node, i, pos) {
    if (a && a[0] === node && a[1] === i && aPos < 0) aPos = pos;
    if (f && f[0] === node && f[1] === i && fPos < 0) fPos = pos;
  }
  function push(chunk, marks) {
    var pos = out.length;
    out += chunk;
    for (var t in open) {
      var e = open[t];
      if (!marks[t] || (t === 'link' && e.url !== marks.link)) delete open[t];
    }
    for (var type in marks) {
      var cur = open[type];
      if (cur && cur.offset + cur.length === pos) cur.length += chunk.length;
      else { cur = { type: type, offset: pos, length: chunk.length }; if (type === 'link') cur.url = marks.link; entities.push(cur); open[type] = cur; }
    }
  }
  function walk(node, marks) {
    var kids = node.childNodes;
    for (var i = 0; i < kids.length; i++) {
      at(node, i, out.length);
      var c = kids[i];
      if (c.nodeType === 3) {
        var t = c.data.replace(/\u00a0/g, ' ').replace(/[\u200b\ufeff]/g, '');
        // pre-wrap: последний «\n» в конце блока не рисует строку — это подпорка браузера, как <br> в конце
        if (t[t.length - 1] === '\n' && trailingBr(c, root)) t = t.slice(0, -1);
        if (a && a[0] === c && aPos < 0) aPos = out.length + countClean(c.data, a[1]);
        if (f && f[0] === c && fPos < 0) fPos = out.length + countClean(c.data, f[1]);
        if (t) push(t, marks);
        continue;
      }
      if (c.nodeType !== 1) continue;
      var tag = c.nodeName;
      if (tag === 'BR') { if (!trailingBr(c, root)) push('\n', marks); continue; }
      if (tag === 'IMG') { var alt = c.getAttribute('alt'); if (alt) push(alt, marks); continue; }
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE' || tag === 'HEAD' || tag === 'TITLE' || tag === 'META') continue;
      var block = BLOCK.test(tag);
      if (block && out && out[out.length - 1] !== '\n') push('\n', {});
      walk(c, marksOf(c, marks));
      if (block && (tag === 'P' || /^H[1-6]$/.test(tag)) && c.nextSibling && out && out[out.length - 1] !== '\n') push('\n', {});
    }
    at(node, kids.length, out.length);
  }
  walk(root, {});
  if (sel) {
    start = aPos < 0 ? out.length : aPos; end = fPos < 0 ? start : fPos;
    if (start > end) { var x = start; start = end; end = x; }
  }
  var v = { text: out, entities: clean(out, entities) };
  if (sel) { v.start = start; v.end = end; }
  return v;
}

function countClean(data, offset) {
  var s = data.slice(0, offset);
  return s.replace(/[\u200b\ufeff]/g, '').length;
}

/* ---------- значение → HTML поля / сегменты для пузыря ---------- */

/** Разбивка текста по границам сущностей: [{ text, marks }] — одна и та же для поля и для пузыря. */
export function segments(text, entities) {
  var cuts = [0, text.length];
  var list = entities || [];
  for (var i = 0; i < list.length; i++) { cuts.push(list[i].offset, list[i].offset + list[i].length); }
  cuts = cuts.filter(function (x) { return x >= 0 && x <= text.length; }).sort(function (x, y) { return x - y; });
  var out = [];
  for (var k = 0; k < cuts.length - 1; k++) {
    var s = cuts[k], e = cuts[k + 1];
    if (s === e) continue;
    var marks = {};
    for (var j = 0; j < list.length; j++) {
      var en = list[j];
      if (en.offset <= s && en.offset + en.length >= e) marks[en.type] = en.type === 'link' ? en.url : true;
    }
    out.push({ text: text.slice(s, e), marks: marks });
  }
  return out;
}

function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
var OPEN = {
  bold: function () { return '<b>'; }, italic: function () { return '<i>'; }, underline: function () { return '<u>'; }, strike: function () { return '<s>'; },
  code: function () { return '<code>'; }, pre: function () { return '<code data-pre="1">'; },
  spoiler: function () { return '<span data-fmt="spoiler" class="rl-spoiler-edit">'; },
  link: function (url) { return '<a href="' + esc(url) + '" rel="noopener noreferrer" target="_blank">'; },
};
var CLOSE = { bold: '</b>', italic: '</i>', underline: '</u>', strike: '</s>', code: '</code>', pre: '</code>', spoiler: '</span>', link: '</a>' };

/** HTML для поля ввода. Перевод строки — <br>; в конце текста — ещё один, иначе последняя пустая строка не видна. */
export function toHtml(value) {
  var v = value || EMPTY, html = '';
  var segs = segments(v.text, v.entities);
  for (var i = 0; i < segs.length; i++) {
    var sg = segs[i], open = '', close = '';
    for (var k = 0; k < ORDER.length; k++) {
      var t = ORDER[k];
      if (sg.marks[t]) { open += OPEN[t](sg.marks[t]); close = CLOSE[t] + close; }
    }
    html += open + esc(sg.text).replace(/\n/g, '<br>') + close;
  }
  if (v.text && v.text[v.text.length - 1] === '\n') html += '<br>';
  return html;
}

/* ---------- операции над значением ---------- */

function sortEntities(list) {
  return list.sort(function (x, y) { return x.offset - y.offset || y.length - x.length || (x.type < y.type ? -1 : 1); });
}

/** Чистка: в пределах текста, без пустых, известных типов; один тип не перекрывается сам с собой (склеиваем). */
export function clean(text, entities) {
  var by = {};
  (entities || []).forEach(function (e) {
    if (!e || FORMATS.indexOf(e.type) < 0) return;
    var s = Math.max(0, e.offset | 0), en = Math.min(text.length, (e.offset | 0) + (e.length | 0));
    // пробелы по краям в оформление не входят (кроме моноширинного — там пробелы значимы)
    if (!MONO[e.type]) { while (s < en && /\s/.test(text[s])) s++; while (en > s && /\s/.test(text[en - 1])) en--; }
    if (en <= s) return;
    var key = e.type === 'link' ? 'link\u0000' + e.url : e.type;
    if (e.type === 'link' && !safeUrl(e.url)) return;
    (by[key] = by[key] || []).push({ type: e.type, offset: s, length: en - s, url: e.url });
  });
  var out = [];
  Object.keys(by).forEach(function (key) {
    var list = by[key].sort(function (x, y) { return x.offset - y.offset; });
    var cur = null;
    list.forEach(function (e) {
      if (cur && e.offset <= cur.offset + cur.length) cur.length = Math.max(cur.length, e.offset + e.length - cur.offset);
      else { cur = { type: e.type, offset: e.offset, length: e.length }; if (e.type === 'link') cur.url = safeUrl(e.url); out.push(cur); }
    });
  });
  // разные ссылки не перекрываются: позже начавшаяся обрезает раннюю
  return sortEntities(out);
}

function subtract(entities, pred, s, e) {
  var out = [];
  entities.forEach(function (en) {
    var a = en.offset, b = en.offset + en.length;
    if (!pred(en) || b <= s || a >= e) { out.push(en); return; }
    if (a < s) out.push(Object.assign({}, en, { length: s - a }));
    if (b > e) out.push(Object.assign({}, en, { offset: e, length: b - e }));
  });
  return out;
}

/** Покрыт ли весь диапазон [s, e) сущностями этого типа. */
export function covers(value, type, s, e) {
  if (e <= s) return false;
  var spans = value.entities.filter(function (x) { return x.type === type; }).sort(function (x, y) { return x.offset - y.offset; });
  var pos = s;
  for (var i = 0; i < spans.length && pos < e; i++) {
    var x = spans[i];
    if (x.offset > pos) break;
    pos = Math.max(pos, x.offset + x.length);
  }
  // пробелы на границах не считаем: «жирный» с пробелом в выделении всё равно жирный
  while (pos < e && /\s/.test(value.text[pos])) pos++;
  return pos >= e;
}

/** Включить/выключить тип на [s, e). Ссылка: url — поставить, null — снять. */
export function toggleFormat(value, type, s, e, url) {
  var list = value.entities.slice();
  if (type === 'link') {
    list = subtract(list, function (x) { return x.type === 'link'; }, s, e);
    if (url) { list = subtract(list, function (x) { return MONO[x.type]; }, s, e); list.push({ type: 'link', offset: s, length: e - s, url: url }); }
    return { text: value.text, entities: clean(value.text, list) };
  }
  if (covers(value, type, s, e)) list = subtract(list, function (x) { return x.type === type; }, s, e);
  else {
    // моноширинный снимает остальное оформление, а остальное — моноширинный
    list = subtract(list, MONO[type] ? function (x) { return x.type !== type; } : function (x) { return !!MONO[x.type]; }, s, e);
    list.push({ type: type, offset: s, length: e - s });
  }
  return { text: value.text, entities: clean(value.text, list) };
}

/** Заменить [s, e) вставкой (со своим оформлением); сущности справа сдвигаются. */
export function splice(value, s, e, insert) {
  var ins = insert || EMPTY, d = ins.text.length - (e - s), list = [];
  value.entities.forEach(function (en) {
    var a = en.offset, b = en.offset + en.length;
    if (b <= s) { list.push(en); return; }
    if (a >= e) { list.push(Object.assign({}, en, { offset: a + d })); return; }
    // задело заменяемый кусок: оставить части слева и справа
    if (a < s) list.push(Object.assign({}, en, { length: s - a }));
    if (b > e) list.push(Object.assign({}, en, { offset: e + d, length: b - e }));
  });
  ins.entities.forEach(function (en) { list.push(Object.assign({}, en, { offset: en.offset + s })); });
  var text = value.text.slice(0, s) + ins.text + value.text.slice(e);
  return { text: text, entities: clean(text, list) };
}

/** Обрезать пробелы по краям, сдвинув сущности. */
export function trimValue(value) {
  var lead = value.text.length - value.text.replace(/^\s+/, '').length;
  var text = value.text.trim();
  var list = value.entities.map(function (en) { return Object.assign({}, en, { offset: en.offset - lead }); });
  return { text: text, entities: clean(text, list) };
}

export function sameValue(x, y) {
  if (!x || !y) return x === y;
  return x.text === y.text && JSON.stringify(x.entities) === JSON.stringify(y.entities);
}

/* ---------- разметка при отправке: **жирный**, __курсив__, ~~зачёркнутый~~, ||скрытый||, `код`, ```блок```, [текст](ссылка) ---------- */

var MD = [
  { re: /```([a-zA-Z0-9_+-]{1,32}\n)?([\s\S]+?)```/, type: 'pre', group: 2, open: 3, lang: 1 },
  { re: /`([^`\n]+?)`/, type: 'code', group: 1, open: 1 },
  { re: /\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*/, type: 'bold', group: 1, open: 2 },
  { re: /__(?!\s)([\s\S]+?)(?<!\s)__/, type: 'italic', group: 1, open: 2 },
  { re: /~~(?!\s)([\s\S]+?)(?<!\s)~~/, type: 'strike', group: 1, open: 2 },
  { re: /\|\|(?!\s)([\s\S]+?)(?<!\s)\|\|/, type: 'spoiler', group: 1, open: 2 },
  { re: /\[([^\]\n]+)\]\(([^)\s]+)\)/, type: 'link', group: 1, open: 1, url: 2 },
];

function insideMono(value, a, b) {
  return value.entities.some(function (en) { return MONO[en.type] && en.offset < b && en.offset + en.length > a; });
}

/** Разметка в тексте → оформление; внутри кода разметку не трогаем. */
export function applyMarkdown(value) {
  var v = { text: value.text, entities: value.entities.slice() };
  for (var r = 0; r < MD.length; r++) {
    var rule = MD[r], from = 0, guard = 0;
    while (guard++ < 500) {
      var m = rule.re.exec(v.text.slice(from));
      if (!m) break;
      var at = from + m.index, whole = m[0], inner = m[rule.group];
      var innerAt = at + rule.open + (rule.lang && m[rule.lang] ? m[rule.lang].length : 0);
      if (insideMono(v, at, at + whole.length) || (rule.type === 'link' && !safeUrl(m[rule.url]))) { from = at + 1; continue; }
      // снять маркеры: правый, потом левый (сдвиги считаются проще)
      var right = { s: innerAt + inner.length, e: at + whole.length }, left = { s: at, e: innerAt };
      v = splice(v, right.s, right.e, EMPTY);
      v = splice(v, left.s, left.e, EMPTY);
      var add = { type: rule.type, offset: at, length: inner.length };
      if (rule.type === 'link') add.url = safeUrl(m[rule.url]);
      v = { text: v.text, entities: clean(v.text, MONO[rule.type] ? subtract(v.entities, function () { return true; }, at, at + inner.length).concat([add]) : v.entities.concat([add])) };
      from = at + inner.length;
    }
  }
  return v;
}

/* ---------- вставка из буфера ---------- */

/**
 * Буфер → значение. HTML разбирается в отдельном документе (скрипты не выполняются, в поле он не попадает:
 * поле получает только наш HTML из toHtml). Оформление из HTML берём, только если его текст совпадает
 * с простым текстом буфера (без учёта пробелов) — иначе HTML врёт, и вставляем простой текст.
 */
export function valueFromClipboard(html, plain) {
  var text = (plain || '').replace(/\r\n?/g, '\n');
  if (!html || typeof DOMParser === 'undefined') return { text: text, entities: [] };
  var body = '<body>' + (/<body[^>]*>([\s\S]*)<\/body>/i.exec(html) || [0, html])[1] + '</body>';
  var doc = new DOMParser().parseFromString(body.replace(/<!--[\s\S]*?-->/g, ''), 'text/html');
  var rich = readDom(doc.body);
  var squash = function (s) { return s.replace(/\s+/g, ''); };
  if (!text) return rich;
  if (squash(rich.text) !== squash(text)) return { text: text, entities: [] };
  // переводы строк — по простому тексту (блочная вёрстка HTML лжёт о них); оформление переносим по непробельным символам
  return { text: text, entities: clean(text, remap(rich, text)) };
}

function remap(rich, text) {
  var map = [], j = 0;
  for (var i = 0; i < rich.text.length; i++) {
    if (/\s/.test(rich.text[i])) { map.push(-1); continue; }
    while (j < text.length && /\s/.test(text[j])) j++;
    map.push(j++);
  }
  return rich.entities.map(function (en) {
    var a = -1, b = -1;
    for (var k = en.offset; k < en.offset + en.length; k++) if (map[k] >= 0) { if (a < 0) a = map[k]; b = map[k]; }
    return a < 0 ? null : Object.assign({}, en, { offset: a, length: b - a + 1 });
  }).filter(Boolean);
}

/* ---------- позиция в символах → точка DOM ---------- */

/** Точка DOM для смещения в тексте поля (обход с теми же правилами, что readDom). */
export function pointAt(root, target) {
  var pos = 0, best = null;
  function walk(node) {
    var kids = node.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c.nodeType === 3) {
        var len = c.data.length;
        if (target >= pos && target <= pos + len) { best = [c, target - pos]; if (target < pos + len) return true; }
        pos += len;
        continue;
      }
      if (c.nodeType !== 1) continue;
      if (c.nodeName === 'BR') {
        if (trailingBr(c, root)) continue;
        if (target === pos && !best) best = [node, i];
        pos += 1;
        if (target === pos) best = [node, i + 1];
        continue;
      }
      if (BLOCK.test(c.nodeName) && pos > 0) { if (target === pos && !best) best = [node, i]; pos += 1; }
      if (walk(c)) return true;
    }
    return false;
  }
  walk(root);
  return best || [root, root.childNodes.length];
}

export function setSelection(root, s, e) {
  var sel = root.ownerDocument.getSelection();
  if (!sel) return;
  var a = pointAt(root, s), b = e === s ? a : pointAt(root, e);
  var r = root.ownerDocument.createRange();
  r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]);
  sel.removeAllRanges(); sel.addRange(r);
}

/**
 * Заменить содержимое поля так, чтобы это попало в историю правки (⌘Z вернёт прежнее): выделить всё
 * и вставить HTML командой редактирования. После — выделение по смещениям.
 */
export function replaceContent(root, value, s, e) {
  var doc = root.ownerDocument, sel = doc.getSelection();
  if (doc.activeElement !== root) root.focus({ preventScroll: true });
  var r = doc.createRange(); r.selectNodeContents(root);
  sel.removeAllRanges(); sel.addRange(r);
  var html = toHtml(value);
  var ok = false;
  try { ok = html ? doc.execCommand('insertHTML', false, html) : doc.execCommand('delete', false); } catch (err) { ok = false; }
  if (!ok) root.innerHTML = html;
  // браузер может обернуть вставку в свой блок или стиль — проверяем, что значение то же, иначе ставим как есть
  if (!sameValue(readDom(root), value)) root.innerHTML = html;
  if (s != null) setSelection(root, s, e == null ? s : e);
}
