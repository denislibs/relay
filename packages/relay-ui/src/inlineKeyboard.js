// Кнопки под сообщением — как inline-клавиатура в Telegram:
//  ряды во всю ширину пузыря, кнопки в ряду поровну, небольшие зазоры; полупрозрачная плашка цвета обоев
//  (та же, что у дат и служебных строк) с белым текстом; у кнопки-ссылки — стрелка в углу;
//  нажатая callback-кнопка — кружок загрузки в углу (появляется не сразу и держится минимум полсекунды, без мигания),
//  пока ответ не пришёл, клавиатура не нажимается второй раз; кнопки убрали (итог в тексте) — клавиатура сворачивается.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cx, Icon, useMinVisible } from './kit.js';

const SAFE_URL = /^https?:\/\/[^\s]+$/i;

/**
 * Ряды для показа: пустые ряды и кнопки без текста отбрасываются; у ссылки — только http(s), иначе url: null
 * (кнопка видна, но никуда не ведёт); null — показывать нечего.
 */
export function keyboardRows(rows) {
  if (!Array.isArray(rows)) return null;
  var out = [];
  rows.forEach(function (row) {
    if (!Array.isArray(row)) return;
    var r = [];
    row.forEach(function (b) {
      if (!b || typeof b.text !== 'string' || !b.text.trim()) return;
      if (b.kind === 'url') r.push({ text: b.text, kind: 'url', url: typeof b.url === 'string' && SAFE_URL.test(b.url) ? b.url : null });
      else if (b.kind === 'callback') r.push({ text: b.text, kind: 'callback', data: typeof b.data === 'string' ? b.data : '' });
    });
    if (r.length) out.push(r);
  });
  return out.length ? out : null;
}

/**
 * props: rows — [[{ text, kind: 'callback' | 'url', data?, url? }]] (null/пусто — кнопок нет, клавиатура уходит);
 *        onPress(button) → Promise (callback-кнопка; пока не завершится — кнопка «в работе»);
 *        нет onPress — кнопки не нажимаются, клик проходит дальше (режим выбора сообщений).
 */
export function InlineKeyboard(props) {
  var raw = props.rows;
  var memo = useRef({ raw: undefined, rows: null });
  if (memo.current.raw !== raw) memo.current = { raw: raw, rows: keyboardRows(raw) };   // тот же массив — те же ряды (эффект ниже не дёргается)
  var rows = memo.current.rows;
  var shownSt = useState(rows), shown = shownSt[0];
  useEffect(function () { if (rows) shownSt[1](rows); }, [rows]);
  var pressSt = useState(null), pressed = pressSt[0];   // 'ряд:кнопка' нажатой, пока ждём ответ
  var spinKey = useRef(null);
  if (pressed) spinKey.current = pressed;
  var spin = useMinVisible(!!pressed, { delay: 120, min: 500 });
  var alive = useRef(true);
  useEffect(function () { return function () { alive.current = false; }; }, []);

  var list = rows || shown;
  if (!list) return null;
  var leaving = !rows;
  return h('div', {
    class: cx('rl-kb', leaving && 'rl-kb-leave'), role: 'group', 'aria-label': 'Кнопки сообщения',
    onAnimationEnd: leaving ? function (e) { if (e.target === e.currentTarget) shownSt[1](null); } : undefined,
  },
    h('div', { class: 'rl-kb-inner' },
      list.map(function (row, r) {
        return h('div', { key: r, class: 'rl-kb-row' }, row.map(function (b, c) {
          var key = r + ':' + c;
          var busy = spin && spinKey.current === key;
          var corner = busy ? h('span', { class: 'rl-kb-spin', 'aria-hidden': 'true' })
            : b.kind === 'url' ? h('span', { class: 'rl-kb-corner', 'aria-hidden': 'true' }, h(Icon, { name: 'external', size: 12, strokeWidth: 2.4 })) : null;
          var label = h('span', { class: 'rl-kb-text' }, b.text);
          if (b.kind === 'url') {
            var url = b.url;
            return h('a', { key: c, class: 'rl-kb-btn', href: url || undefined, target: '_blank', rel: 'noopener noreferrer', title: url || undefined,
              onClick: function (e) { if (!props.onPress) { e.preventDefault(); return; } e.stopPropagation(); if (!url || leaving) e.preventDefault(); } }, label, corner);
          }
          return h('button', {
            key: c, type: 'button', class: cx('rl-kb-btn', busy && 'rl-kb-busy'), 'aria-busy': pressed === key ? 'true' : undefined,
            'aria-disabled': pressed || leaving ? 'true' : undefined,
            onClick: function (e) {
              if (!props.onPress) return;   // режим выбора: клик — ленте
              e.stopPropagation();
              if (pressed || leaving) return;
              pressSt[1](key);
              var press = props.onPress;
              Promise.resolve().then(function () { return press(b); })
                .catch(function () { /* ошибку показывает вызывающий */ })
                .then(function () { if (alive.current) pressSt[1](null); });
            },
          }, label, corner);
        }));
      })));
}
