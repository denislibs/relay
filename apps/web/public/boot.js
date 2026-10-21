// До загрузки CSS и обоев: фон уже в цвет темы, без белой/чёрной вспышки. Обычный (не модульный) скрипт в <head>:
// выполняется сразу. Отдельным файлом, не встроенным, — CSP пускает скрипты только с адресом (build.ts: boot-<хэш>.js,
// в конец дописывается таблица адресов сборки self.__ASSETS__).
try { var d = document.documentElement, s = localStorage, p = JSON.parse(s.getItem('relay.prefs') || 'null'), r = matchMedia('(prefers-reduced-motion: reduce)').matches;
    p = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    var ok = p.v === undefined || p.v === 1, t = p.theme || (p.v === undefined ? s.getItem('relay.theme') : null), a = ok && p.anim && typeof p.anim === 'object' ? p.anim : {};
    if (t === 'light' || t === 'dark') d.setAttribute('data-theme', t);
    if (ok && typeof p.textSize === 'number' && p.textSize >= 12 && p.textSize <= 20) d.style.setProperty('--message-text-size', Math.round(p.textSize) + 'px');
    if (typeof a.ui === 'boolean' ? !a.ui : r) d.setAttribute('data-anim', '0');
    if (typeof a.blur === 'boolean' ? !a.blur : r) d.setAttribute('data-blur', '0');
    if (typeof a.wallpaper === 'boolean' ? !a.wallpaper : r) d.setAttribute('data-wpanim', '0');
    var ac = s.getItem('relay.accentCss'); if (ac) { var st = document.createElement('style'); st.id = 'rl-accent'; st.textContent = ac; document.head.appendChild(st); } } catch (e) {}
