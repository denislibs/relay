/**
 * Файлы из перетаскивания: обычные файлы и содержимое папок (вложенных тоже), как в Telegram Desktop.
 * Папку браузер отдаёт только через webkitGetAsEntry — и только синхронно в обработчике drop, поэтому записи
 * снимаем сразу, а читаем потом. Скрытые файлы (.DS_Store и т. п.) пропускаем.
 */
const MAX_FILES = 100;

export function entriesOf(dt: DataTransfer): FileSystemEntry[] | null {
  const items = [...dt.items].filter((i) => i.kind === 'file');
  const entries = items.map((i) => i.webkitGetAsEntry?.() ?? null);
  // нет API или ни одной папки — обычный список файлов
  if (!entries.length || entries.some((e) => !e) || !entries.some((e) => e!.isDirectory)) return null;
  return entries as FileSystemEntry[];
}

export async function filesFromEntries(entries: FileSystemEntry[]): Promise<File[]> {
  const out: File[] = [];
  const walk = async (e: FileSystemEntry): Promise<void> => {
    if (out.length >= MAX_FILES || e.name.startsWith('.')) return;
    if (e.isFile) { out.push(await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej))); return; }
    const reader = (e as FileSystemDirectoryEntry).createReader();
    // readEntries отдаёт пачками (по 100 в Chrome) — читаем до пустой
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      batch.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const x of batch) await walk(x);
    }
  };
  for (const e of entries) await walk(e).catch(() => {});
  return out;
}
