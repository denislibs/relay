import {
  fromMessagePort,
  HostCore
} from "./main-p1twxvxz.js";
import {
  Engine
} from "./main-qy2821z4.js";

// packages/sync-engine/src/hosts/dedicated.ts
function createDedicatedHost(opts) {
  let role = "follower";
  let core = null;
  let feedLocal = null;
  const remote = new Map;
  let release = () => {};
  let closed = false;
  let hello = null;
  const subs = new Map;
  const calls = new Set;
  function record(m) {
    if (m.t === "hello")
      hello = m;
    else if (m.t === "watch" || m.t === "update")
      subs.set(m.sub, { t: "watch", sub: m.sub, query: m.query });
    else if (m.t === "unwatch")
      subs.delete(m.sub);
    else if (m.t === "call")
      calls.add(m.id);
  }
  const toSelf = (m) => {
    if (m.t === "result")
      calls.delete(m.id);
    opts.self.post(m);
  };
  const failCalls = () => {
    for (const id of calls)
      opts.self.post({ t: "result", id, ok: false, error: "leader_changed" });
    calls.clear();
  };
  const replay = (send) => {
    if (hello)
      send(hello);
    for (const m of subs.values())
      send(m);
  };
  const toLeader = (m) => opts.channel.postMessage({ to: "leader", from: opts.tabId, msg: m });
  opts.self.listen((m) => {
    record(m);
    if (role === "leader")
      feedLocal(m);
    else
      toLeader(m);
  });
  opts.channel.addEventListener("message", (e) => {
    const d = e.data;
    if ("t" in d) {
      if (d.t === "leader" && role === "follower") {
        failCalls();
        replay(toLeader);
      }
      return;
    }
    if (d.to === "leader") {
      if (role !== "leader")
        return;
      const w = d;
      let feed = remote.get(w.from);
      if (!feed) {
        core.attach({
          post: (m) => opts.channel.postMessage({ to: w.from, msg: m }),
          listen: (cb) => {
            feed = cb;
          }
        });
        remote.set(w.from, feed);
      }
      feed(w.msg);
      if (w.msg.t === "bye")
        remote.delete(w.from);
      return;
    }
    if (d.to === opts.tabId)
      toSelf(d.msg);
  });
  opts.locks.request("relay-leader@" + opts.build, () => new Promise((resolve) => {
    if (closed) {
      resolve();
      return;
    }
    release = resolve;
    role = "leader";
    core = new HostCore({ build: opts.build, open: opts.open, kind: "dedicated-leader" });
    core.attach({ post: toSelf, listen: (cb) => {
      feedLocal = cb;
    } });
    failCalls();
    replay(feedLocal);
    opts.channel.postMessage({ t: "leader" });
  }));
  return {
    get role() {
      return role;
    },
    async close() {
      closed = true;
      if (role === "leader")
        await core.close();
      else
        toLeader({ t: "bye" });
      release();
      opts.channel.close();
    }
  };
}

// packages/sync-engine/src/hosts/dedicated.worker.ts
var scope = self;
var build = scope.name.split("@")[1] ?? "dev";
createDedicatedHost({
  self: fromMessagePort(scope),
  channel: new BroadcastChannel("relay-host@" + build),
  locks: navigator.locks,
  tabId: crypto.randomUUID(),
  build,
  open: (cfg) => Engine.open(cfg)
});

//# debugId=3CC2305B5B04F3F464756E2164756E21
//# sourceMappingURL=dedicated.worker-3fpej2dw.js.map
