// Пузырь опроса и викторины — по поведению Telegram (своя реализация):
//  • сверху вопрос и подпись: «Анонимный опрос» / «Опрос» / «Викторина» / «Анонимная викторина», закрытый — «Итоги»;
//  • до голоса — варианты с кружками; одиночный выбор голосует сразу, несколько — флажки и кнопка «Проголосовать»;
//  • после голоса (или у закрытого) — проценты слева, полоски под текстом (растут от нуля один раз, при голосе),
//    мой выбор отмечен; в викторине правильный — зелёной галочкой, мой неверный — красным крестиком;
//  • пояснение викторины — по лампочке справа от вопроса (раскрывается под вопросом);
//  • внизу: «N голосов», у неанонимного после голоса — «Результаты», у таймера — «Осталось 0:42».
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cx, Icon, MessageStatus, ReplyQuote, metaOrReactions } from './kit.js';

function plural(n, one, few, many) {
  var m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}

/** Проценты в сумме ровно 100 (наибольшие остатки), без голосов — нули. */
export function pollShares(counts) {
  var total = counts.reduce(function (a, b) { return a + b; }, 0);
  if (!total) return counts.map(function () { return 0; });
  var raw = counts.map(function (c) { return c * 100 / total; });
  var out = raw.map(Math.floor), left = 100 - out.reduce(function (a, b) { return a + b; }, 0);
  raw.map(function (v, i) { return [v - Math.floor(v), i]; }).filter(function (x) { return counts[x[1]] > 0; })
    .sort(function (a, b) { return b[0] - a[0]; }).forEach(function (x) { if (left > 0) { out[x[1]]++; left--; } });
  return out;
}

export function pollSubtitle(p) {
  if (p.closed) return p.quiz ? 'Итоги викторины' : 'Итоги опроса';
  return p.quiz ? (p.anonymous ? 'Анонимная викторина' : 'Викторина') : (p.anonymous ? 'Анонимный опрос' : 'Опрос');
}

/** Сколько осталось до автозакрытия: «0:42»; null — таймера нет или вышел. */
function useLeft(closesAt, closed) {
  var at = closesAt && !closed ? Date.parse(closesAt) : 0;
  var st = useState(0);
  useEffect(function () {
    if (!at) return;
    var t = setInterval(function () { st[1](function (n) { return n + 1; }); if (Date.now() >= at) clearInterval(t); }, 1000);
    return function () { clearInterval(t); };
  }, [at]);
  if (!at) return null;
  var s = Math.max(0, Math.ceil((at - Date.now()) / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/**
 * props: poll, from ('in'|'out'), groupStart, tail, appear, time, status, edited, reply, reactions, onReact, metaBefore, footer,
 *        canVote (участник может голосовать), onVote(ids) → Promise | void, onResults() (неанонимный: кто голосовал).
 */
export function PollMessage(props) {
  var p = props.poll, out = props.from === 'out';
  var voted = !!(p.my && p.my.length), showResults = voted || p.closed;
  var mine = {};
  (p.my || []).forEach(function (id) { mine[id] = true; });
  var picked = useState([]);   // несколько ответов: отмеченные до «Проголосовать»
  var tip = useState(false);   // пояснение викторины раскрыто
  var busy = useState(false);
  // полоски растут один раз — когда итоги появились на глазах (голос), а не при каждом показе в ленте
  var was = useRef(showResults), grow = showResults && !was.current;
  useEffect(function () { was.current = showResults; }, [showResults]);
  var left = useLeft(p.closesAt, p.closed);
  var shares = pollShares(p.counts);
  var max = Math.max.apply(null, p.counts.concat([1]));
  var interactive = !showResults && !!props.canVote && !busy[0];

  function vote(ids) {
    if (!ids.length || busy[0]) return;
    var r = props.onVote && props.onVote(ids);
    if (r && r.then) { busy[1](true); r.then(function () { busy[1](false); picked[1]([]); }, function () { busy[1](false); }); }
  }
  function onPick(id) {
    if (!interactive) return;
    if (!p.multiple) { vote([id]); return; }
    var cur = picked[0];
    picked[1](cur.indexOf(id) >= 0 ? cur.filter(function (x) { return x !== id; }) : cur.concat([id]));
  }

  var footText = p.voters ? p.voters + ' ' + plural(p.voters, 'голос', 'голоса', 'голосов') : (p.closed ? 'Никто не проголосовал' : 'Пока нет голосов');
  var action = !showResults && p.multiple && props.canVote
    ? h('button', { type: 'button', class: 'rl-pollm-action', disabled: !picked[0].length || busy[0], onClick: function (e) { e.stopPropagation(); vote(picked[0]); } }, 'Проголосовать')
    : showResults && !p.anonymous && props.onResults
      ? h('button', { type: 'button', class: 'rl-pollm-action', onClick: function (e) { e.stopPropagation(); props.onResults(); } }, 'Результаты')
      : null;

  return h('div', { class: cx('rl-msgline', out && 'rl-msgline-out', props.groupStart && 'rl-msgline-gap') },
    h('div', { class: cx('rl-bubble rl-pollm', out ? 'rl-bubble-out' : 'rl-bubble-in-side', props.tail && 'rl-bubble-tail', props.metaBefore && 'rl-meta-flow', props.footer && 'rl-bubble-has-footer', props.reactions && props.reactions.length && 'rl-bubble-has-react', props.appear && (out ? 'rl-appear-out' : 'rl-appear-in'), grow && 'rl-pollm-grow') },
      props.reply ? h(ReplyQuote, Object.assign({ inBubble: true }, props.reply)) : null,
      h('div', { class: 'rl-pollm-head' },
        h('div', { class: 'rl-pollm-titles' },
          h('b', { class: 'rl-pollm-q' }, p.question),
          h('span', { class: 'rl-pollm-sub' }, pollSubtitle(p), left ? h('span', { class: 'rl-pollm-left' }, ' · осталось ' + left) : null)),
        p.quiz && p.solution
          ? h('button', { type: 'button', class: cx('rl-pollm-tipbtn', tip[0] && 'rl-pollm-tipbtn-on'), 'aria-label': 'Пояснение', 'aria-expanded': String(tip[0]), onClick: function (e) { e.stopPropagation(); tip[1](!tip[0]); } }, h(Icon, { name: 'bulb', size: 20 }))
          : null),
      p.quiz && p.solution && tip[0] ? h('div', { class: 'rl-pollm-tip', role: 'note' }, p.solution) : null,
      h('div', { class: cx('rl-pollm-opts', showResults && 'rl-pollm-results'), role: showResults ? 'list' : p.multiple ? 'group' : 'radiogroup', 'aria-label': p.question },
        p.options.map(function (o, i) {
          var on = picked[0].indexOf(o.id) >= 0;
          if (!showResults) {
            return h('button', {
              key: o.id, type: 'button', class: cx('rl-pollm-opt', on && 'rl-pollm-on', !interactive && 'rl-pollm-ro'),
              role: p.multiple ? 'checkbox' : 'radio', 'aria-checked': String(on), disabled: !props.canVote,
              onClick: function (e) { e.stopPropagation(); onPick(o.id); },
            },
              h('span', { class: cx('rl-pollm-mark', p.multiple && 'rl-pollm-mark-sq') }, h(Icon, { name: 'check', size: 14, strokeWidth: 3 })),
              h('span', { class: 'rl-pollm-text' }, o.text));
          }
          var right = p.quiz && p.correct === o.id, wrong = p.quiz && mine[o.id] && p.correct != null && p.correct !== o.id;
          return h('div', { key: o.id, role: 'listitem', class: cx('rl-pollm-res', mine[o.id] && 'rl-pollm-mine', right && 'rl-pollm-right', wrong && 'rl-pollm-wrong'),
            'aria-label': o.text + ': ' + shares[i] + '%' + (mine[o.id] ? ', ваш выбор' : '') + (right ? ', правильный ответ' : '') },
            h('span', { class: 'rl-pollm-pct' }, shares[i] + '%'),
            h('span', { class: 'rl-pollm-body' },
              h('span', { class: 'rl-pollm-line' },
                h('span', { class: 'rl-pollm-text' }, o.text),
                right || mine[o.id] ? h('span', { class: 'rl-pollm-badge', 'aria-hidden': 'true' }, h(Icon, { name: wrong ? 'close' : 'check', size: 12, strokeWidth: 3.2 })) : null),
              h('span', { class: 'rl-pollm-bar', 'aria-hidden': 'true' }, h('i', { style: { transform: 'scaleX(' + (p.counts[i] / max) + ')' } }))));
        })),
      h('div', { class: 'rl-pollm-foot' }, action || h('span', { class: 'rl-pollm-voters' }, footText)),
      metaOrReactions(props, out, h('span', { class: 'rl-bubble-meta' }, props.metaBefore ? props.metaBefore() : null, props.edited ? h('span', { class: 'rl-bubble-edited' }, 'изм.') : null, props.time, out || props.status ? h(MessageStatus, { status: props.status || 'sent' }) : null)),
      props.footer ? h('div', { class: 'rl-bubble-footer' }, props.footer) : null));
}
