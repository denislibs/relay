import {
  d,
  h,
  Mirror,
  watchDev2,
  ingestLogErrors2,
  startMetrics2
} from "./main-s48bdnny.js";

// apps/web/src/devtools/session.ts
var SERVER_MS = 2000;
var users = 0;
var stats = null;
var main = null;
var server = { stats: null, error: null };
var logM = new Mirror;
var logList = [];
var logVersion = 0;
var closers = [];
var serverWanted = false;
var serverTimer = null;
var serverGen = 0;
var subs = { stats: new Set, log: new Set, main: new Set, server: new Set };
var emit = (t) => {
  for (const fn of subs[t])
    fn();
};
function openDevSession2() {
  if (users++ === 0) {
    serverStopped = false;
    const sm = new Mirror;
    const ws = watchDev2({ kind: "devStats" }, (p) => {
      sm.apply(p);
      stats = sm.list()[0] ?? null;
      emit("stats");
    });
    logM.items.clear();
    logM.order = [];
    logList = [];
    const wl = watchDev2({ kind: "devLog", since: 0 }, (p) => {
      logM.apply(p);
      logList = logM.list();
      logVersion++;
      ingestLogErrors2(p.op === "snapshot" ? p.items : p.upsert);
      emit("log");
    });
    const stopMain = startMetrics2((m) => {
      main = m;
      emit("main");
    });
    const vis = () => pumpServer();
    document.addEventListener("visibilitychange", vis);
    closers = [() => ws.close(), () => wl.close(), stopMain, () => document.removeEventListener("visibilitychange", vis)];
  }
  let done = false;
  return () => {
    if (done)
      return;
    done = true;
    if (--users > 0)
      return;
    for (const c of closers)
      c();
    closers = [];
    setServerPolling2(false);
    stats = null;
    main = null;
    logList = [];
    logM.items.clear();
    logM.order = [];
  };
}
function setServerPolling2(on) {
  serverWanted = on;
  pumpServer();
}
var serverStopped = false;
function pollVerdict(status) {
  if (status === 404 || status === 401)
    return "stop";
  return status >= 200 && status < 300 ? "ok" : "retry";
}
function pumpServer() {
  const run = serverWanted && users > 0 && !serverStopped && document.visibilityState === "visible";
  if (!run) {
    if (serverTimer)
      clearTimeout(serverTimer);
    serverTimer = null;
    serverGen++;
    return;
  }
  if (serverTimer)
    return;
  const gen = ++serverGen;
  const tick = async () => {
    try {
      const res = await fetch("/dev/stats", { credentials: "include" });
      if (gen !== serverGen)
        return;
      const v = pollVerdict(res.status);
      if (v === "stop") {
        serverStopped = true;
        server = { stats: null, error: "unavailable" };
        emit("server");
        serverTimer = null;
        return;
      }
      const body = v === "ok" ? await res.json() : null;
      if (gen !== serverGen)
        return;
      server = { stats: body ?? server.stats, error: body ? null : "offline" };
    } catch {
      if (gen !== serverGen)
        return;
      server = { stats: server.stats, error: "offline" };
    }
    emit("server");
    serverTimer = setTimeout(tick, SERVER_MS);
  };
  serverTimer = setTimeout(tick, 0);
}
var devRunning2 = () => users > 0 || serverTimer !== null;
function useTopic(t, get) {
  const [, force] = d(0);
  h(() => {
    const fn = () => force((x) => x + 1);
    subs[t].add(fn);
    return () => {
      subs[t].delete(fn);
    };
  }, []);
  return get();
}
var useDevStats2 = () => useTopic("stats", () => stats);
var useMainMetrics2 = () => useTopic("main", () => main);
var useServerStats2 = () => useTopic("server", () => server);
var useDevLog2 = () => useTopic("log", () => ({ list: logList, version: logVersion }));
var devSnapshot2 = () => ({ stats, main, server: server.stats, log: logList });

export { openDevSession2, setServerPolling2, devRunning2, useDevStats2, useMainMetrics2, useServerStats2, useDevLog2, devSnapshot2 };

//# debugId=820E0460C382312264756E2164756E21
//# sourceMappingURL=main-kvw7vkbq.js.map
