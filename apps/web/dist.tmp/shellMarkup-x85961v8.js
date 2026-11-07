// apps/web/src/devtools/shellMarkup.ts
var DROP = ".rl-shell-veil, .rl-sidecard-over > .rl-presence, .app-banner-slot, .app-listwrap > *, :scope > [hidden]";
var VOLATILE = /^(app-enter-\w+|tw-wrap|is-fresh|app-skel-instant)$/;
function shellSignature(shell) {
  const out = [];
  const skip = new Set(shell.querySelectorAll(DROP));
  const walk = (el, depth) => {
    if (skip.has(el))
      return;
    const cls = [...el.classList].filter((c) => !VOLATILE.test(c)).sort().join(".");
    out.push(depth + ":" + el.tagName.toLowerCase() + (cls ? "." + cls : "") + (el.getAttribute("data-icon") ? "#" + el.getAttribute("data-icon") : ""));
    if (el.tagName === "svg" || el.classList.contains("rl-tw"))
      return;
    for (const ch of el.children)
      walk(ch, depth + 1);
  };
  walk(shell, 0);
  return out;
}
function shellDiff(a, b) {
  for (let i = 0;i < Math.max(a.length, b.length); i++)
    if (a[i] !== b[i])
      return { at: i, shell: a[i], app: b[i] };
  return null;
}
var SKEL_ROW = (i) => `<div style="--i: ${i};"><div class="rl-skel" aria-hidden="true"><i style="width: 54px; height: 54px;"></i><span style="flex: 1 1 0%; display: flex; flex-direction: column; gap: 8px;"><i style="width: 55%; height: 12px;"></i><i style="width: 80%; height: 10px;"></i></span></div></div>`;
var SKEL = `<div data-state="open" class="rl-presence"><div class="app-skel app-skel-instant" aria-busy="true" aria-label="Загрузка чатов">${Array.from({ length: 9 }, (_, i) => SKEL_ROW(i)).join("")}</div></div>`;
function snapshotShell(appShell) {
  const c = appShell.cloneNode(true);
  for (const el of c.querySelectorAll(DROP))
    el.remove();
  for (const el of [c, ...c.querySelectorAll("[class]")])
    for (const k of [...el.classList])
      if (/^app-enter-/.test(k))
        el.classList.remove(k);
  for (const el of c.querySelectorAll("[id], [for]")) {
    el.removeAttribute("id");
    el.removeAttribute("for");
  }
  for (const el of c.querySelectorAll("[style]")) {
    for (const p of [...el.style])
      if (p.startsWith("--"))
        el.style.removeProperty(p);
    if (!el.getAttribute("style"))
      el.removeAttribute("style");
  }
  const tw = c.querySelector(".rl-tw");
  if (tw) {
    tw.classList.add("tw-wrap");
    tw.removeAttribute("style");
    tw.innerHTML = '<div class="tw-canvas"></div><div class="tw-pattern"></div>';
  }
  const list = c.querySelector(".app-listwrap");
  if (list) {
    list.className = "app-listwrap";
    list.innerHTML = SKEL;
  }
  return c.outerHTML.replace(/>\s+</g, "><").replace(/\n\s*/g, "");
}
export {
  shellDiff,
  shellSignature,
  snapshotShell
};

//# debugId=569D9D31E6CCCB9364756E2164756E21
//# sourceMappingURL=shellMarkup-x85961v8.js.map
