import {
  fromMessagePort,
  HostCore
} from "./main-p1twxvxz.js";
import {
  Engine
} from "./main-qy2821z4.js";

// packages/sync-engine/src/hosts/shared.worker.ts
var scope = self;
var build = scope.name.split("@")[1] ?? "dev";
var core = new HostCore({ build, open: (cfg) => Engine.open(cfg) });
scope.onconnect = (e) => {
  core.attach(fromMessagePort(e.ports[0]));
};
setInterval(() => core.sweep(30000), 1e4);

//# debugId=98E84A9040831B9B64756E2164756E21
//# sourceMappingURL=shared.worker-he59zr5n.js.map
