// Интерфейс (ui/start.tsx) грузится после слоя данных (main.tsx). Кому нужен его первый кадр — снять анимацию
// появления через секунду после него, а не после старта данных, — ждёт здесь.
let mark: () => void = () => {};
export const uiRendered = new Promise<void>((r) => { mark = r; });
export const markUiRendered = (): void => mark();
