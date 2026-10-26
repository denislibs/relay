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
    var ac = s.getItem('relay.accentCss'); if (ac) { var st = document.createElement('style'); st.id = 'rl-accent'; st.textContent = ac; document.head.appendChild(st); }
    // каркас приложения (#shell в index.html) — только если здесь уже входили: иначе первым будет экран входа. На телефоне
    // с открытым по адресу чатом первым экраном будет чат, а не список — тогда без каркаса
    if (s.getItem('relay.me') && !(matchMedia('(max-width: 720px)').matches && /(^#|&)chat=/.test(location.hash))) {
      d.setAttribute('data-shell', ''); d.setAttribute('data-shell-was', '');
      // скелетон списка в каркасе — если прошлая загрузка списка была дольше 250 мс (main.tsx: relay.listMs)
      if (Number(s.getItem('relay.listMs')) > 250) d.setAttribute('data-shell-skel', '');
      var sw = Number(s.getItem('relay.sideWidth')); if (sw > 0) d.style.setProperty('--shell-side-w', sw + 'px');
      // обои — снимок настоящих своей темы (main.tsx): цвет, узор, градиент холста
      var dk = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
      var wp = JSON.parse(s.getItem('relay.shellWp.' + (dk ? 'dark' : 'light')) || 'null');
      if (wp && wp.grad) {
        d.style.setProperty('--shell-tw-background', wp.bg); d.style.setProperty('--shell-tw-image', wp.image);
        d.style.setProperty('--shell-tw-size', wp.size); d.style.setProperty('--shell-tw-opacity', wp.opacity);
        d.style.setProperty('--shell-tw-grad', 'url("' + wp.grad + '")');
        d.setAttribute('data-shell-wp', wp.mask ? 'mask' : 'pattern');
      }
    } } catch (e) {}
