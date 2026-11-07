import {
  transcode2
} from "./main-e19kevcs.js";

// apps/web/src/media/videoTranscode.worker.ts
var post = (m) => self.postMessage(m);
self.onmessage = async (e) => {
  const m = e.data;
  if (m?.type !== "run")
    return;
  if (typeof VideoEncoder === "undefined" || typeof VideoDecoder === "undefined" || typeof AudioEncoder === "undefined") {
    post({ type: "unsupported" });
    return;
  }
  let last = 0;
  try {
    const out = await transcode2(m.file, {
      short: m.short,
      onProgress: (p) => {
        const now = performance.now();
        if (now - last < 50)
          return;
        last = now;
        post({ type: "progress", p });
      }
    });
    post({ type: "done", out });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

//# debugId=EEAAC8305C2E50CC64756E2164756E21
//# sourceMappingURL=videoTranscode.worker-wj9r0e4h.js.map
