// Без импортов: build.ts берёт эту строку и кладёт её в сборку отдельным файлом (voice.worklet-<хэш>.js).
// Блок — 2048 сэмплов (48 кГц, ≈43 мс).
// Ворклет записи голосового: копит моно-блоки по 2048 и отдаёт их в основной поток; на паузе молчит, «reset» — выбросить недобранный блок
export var VOICE_WORKLET = [
  'class R extends AudioWorkletProcessor {',
  '  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; this.on = true;',
  '    this.port.onmessage = (e) => { if (e.data === "pause") this.on = false; else if (e.data === "resume") { this.on = true; this.n = 0; } }; }',
  '  process(inputs) {',
  '    const ch = inputs[0] && inputs[0][0];',
  '    if (!ch || !this.on) return true;',
  '    for (let i = 0; i < ch.length; i++) { this.buf[this.n++] = ch[i]; if (this.n === 2048) { this.port.postMessage(this.buf.slice(0)); this.n = 0; } }',
  '    return true;',
  '  }',
  '}',
  'registerProcessor("relay-voice-capture", R);',
].join('\n');
