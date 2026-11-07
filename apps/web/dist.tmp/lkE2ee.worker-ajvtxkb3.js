// node_modules/.bun/livekit-client@2.23.0+27b84c9f76f9ec0d/node_modules/livekit-client/dist/livekit-client.e2ee.worker.mjs
function __awaiter(thisArg, _arguments, P, generator) {
  function adopt(value) {
    return value instanceof P ? value : new P(function(resolve) {
      resolve(value);
    });
  }
  return new (P || (P = Promise))(function(resolve, reject) {
    function fulfilled(value) {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    }
    function rejected(value) {
      try {
        step(generator["throw"](value));
      } catch (e) {
        reject(e);
      }
    }
    function step(result) {
      result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
    }
    step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
}
var loglevel$1 = { exports: {} };
var loglevel = loglevel$1.exports;
var hasRequiredLoglevel;
function requireLoglevel() {
  if (hasRequiredLoglevel)
    return loglevel$1.exports;
  hasRequiredLoglevel = 1;
  (function(module) {
    (function(root, definition) {
      if (module.exports) {
        module.exports = definition();
      } else {
        root.log = definition();
      }
    })(loglevel, function() {
      var noop = function() {};
      var undefinedType = "undefined";
      var isIE = typeof window !== undefinedType && typeof window.navigator !== undefinedType && /Trident\/|MSIE /.test(window.navigator.userAgent);
      var logMethods = ["trace", "debug", "info", "warn", "error"];
      var _loggersByName = {};
      var defaultLogger = null;
      function bindMethod(obj, methodName) {
        var method = obj[methodName];
        if (typeof method.bind === "function") {
          return method.bind(obj);
        } else {
          try {
            return Function.prototype.bind.call(method, obj);
          } catch (e) {
            return function() {
              return Function.prototype.apply.apply(method, [obj, arguments]);
            };
          }
        }
      }
      function traceForIE() {
        if (console.log) {
          if (console.log.apply) {
            console.log.apply(console, arguments);
          } else {
            Function.prototype.apply.apply(console.log, [console, arguments]);
          }
        }
        if (console.trace)
          console.trace();
      }
      function realMethod(methodName) {
        if (methodName === "debug") {
          methodName = "log";
        }
        if (typeof console === undefinedType) {
          return false;
        } else if (methodName === "trace" && isIE) {
          return traceForIE;
        } else if (console[methodName] !== undefined) {
          return bindMethod(console, methodName);
        } else if (console.log !== undefined) {
          return bindMethod(console, "log");
        } else {
          return noop;
        }
      }
      function replaceLoggingMethods() {
        var level = this.getLevel();
        for (var i = 0;i < logMethods.length; i++) {
          var methodName = logMethods[i];
          this[methodName] = i < level ? noop : this.methodFactory(methodName, level, this.name);
        }
        this.log = this.debug;
        if (typeof console === undefinedType && level < this.levels.SILENT) {
          return "No console available for logging";
        }
      }
      function enableLoggingWhenConsoleArrives(methodName) {
        return function() {
          if (typeof console !== undefinedType) {
            replaceLoggingMethods.call(this);
            this[methodName].apply(this, arguments);
          }
        };
      }
      function defaultMethodFactory(methodName, _level, _loggerName) {
        return realMethod(methodName) || enableLoggingWhenConsoleArrives.apply(this, arguments);
      }
      function Logger(name, factory) {
        var self2 = this;
        var inheritedLevel;
        var defaultLevel;
        var userLevel;
        var storageKey = "loglevel";
        if (typeof name === "string") {
          storageKey += ":" + name;
        } else if (typeof name === "symbol") {
          storageKey = undefined;
        }
        function persistLevelIfPossible(levelNum) {
          var levelName = (logMethods[levelNum] || "silent").toUpperCase();
          if (typeof window === undefinedType || !storageKey)
            return;
          try {
            window.localStorage[storageKey] = levelName;
            return;
          } catch (ignore) {}
          try {
            window.document.cookie = encodeURIComponent(storageKey) + "=" + levelName + ";";
          } catch (ignore) {}
        }
        function getPersistedLevel() {
          var storedLevel;
          if (typeof window === undefinedType || !storageKey)
            return;
          try {
            storedLevel = window.localStorage[storageKey];
          } catch (ignore) {}
          if (typeof storedLevel === undefinedType) {
            try {
              var cookie = window.document.cookie;
              var cookieName = encodeURIComponent(storageKey);
              var location = cookie.indexOf(cookieName + "=");
              if (location !== -1) {
                storedLevel = /^([^;]+)/.exec(cookie.slice(location + cookieName.length + 1))[1];
              }
            } catch (ignore) {}
          }
          if (self2.levels[storedLevel] === undefined) {
            storedLevel = undefined;
          }
          return storedLevel;
        }
        function clearPersistedLevel() {
          if (typeof window === undefinedType || !storageKey)
            return;
          try {
            window.localStorage.removeItem(storageKey);
          } catch (ignore) {}
          try {
            window.document.cookie = encodeURIComponent(storageKey) + "=; expires=Thu, 01 Jan 1970 00:00:00 UTC";
          } catch (ignore) {}
        }
        function normalizeLevel(input) {
          var level = input;
          if (typeof level === "string" && self2.levels[level.toUpperCase()] !== undefined) {
            level = self2.levels[level.toUpperCase()];
          }
          if (typeof level === "number" && level >= 0 && level <= self2.levels.SILENT) {
            return level;
          } else {
            throw new TypeError("log.setLevel() called with invalid level: " + input);
          }
        }
        self2.name = name;
        self2.levels = {
          TRACE: 0,
          DEBUG: 1,
          INFO: 2,
          WARN: 3,
          ERROR: 4,
          SILENT: 5
        };
        self2.methodFactory = factory || defaultMethodFactory;
        self2.getLevel = function() {
          if (userLevel != null) {
            return userLevel;
          } else if (defaultLevel != null) {
            return defaultLevel;
          } else {
            return inheritedLevel;
          }
        };
        self2.setLevel = function(level, persist) {
          userLevel = normalizeLevel(level);
          if (persist !== false) {
            persistLevelIfPossible(userLevel);
          }
          return replaceLoggingMethods.call(self2);
        };
        self2.setDefaultLevel = function(level) {
          defaultLevel = normalizeLevel(level);
          if (!getPersistedLevel()) {
            self2.setLevel(level, false);
          }
        };
        self2.resetLevel = function() {
          userLevel = null;
          clearPersistedLevel();
          replaceLoggingMethods.call(self2);
        };
        self2.enableAll = function(persist) {
          self2.setLevel(self2.levels.TRACE, persist);
        };
        self2.disableAll = function(persist) {
          self2.setLevel(self2.levels.SILENT, persist);
        };
        self2.rebuild = function() {
          if (defaultLogger !== self2) {
            inheritedLevel = normalizeLevel(defaultLogger.getLevel());
          }
          replaceLoggingMethods.call(self2);
          if (defaultLogger === self2) {
            for (var childName in _loggersByName) {
              _loggersByName[childName].rebuild();
            }
          }
        };
        inheritedLevel = normalizeLevel(defaultLogger ? defaultLogger.getLevel() : "WARN");
        var initialLevel = getPersistedLevel();
        if (initialLevel != null) {
          userLevel = normalizeLevel(initialLevel);
        }
        replaceLoggingMethods.call(self2);
      }
      defaultLogger = new Logger;
      defaultLogger.getLogger = function getLogger(name) {
        if (typeof name !== "symbol" && typeof name !== "string" || name === "") {
          throw new TypeError("You must supply a name when creating a logger.");
        }
        var logger = _loggersByName[name];
        if (!logger) {
          logger = _loggersByName[name] = new Logger(name, defaultLogger.methodFactory);
        }
        return logger;
      };
      var _log = typeof window !== undefinedType ? window.log : undefined;
      defaultLogger.noConflict = function() {
        if (typeof window !== undefinedType && window.log === defaultLogger) {
          window.log = _log;
        }
        return defaultLogger;
      };
      defaultLogger.getLoggers = function getLoggers() {
        return _loggersByName;
      };
      defaultLogger["default"] = defaultLogger;
      return defaultLogger;
    });
  })(loglevel$1);
  return loglevel$1.exports;
}
var loglevelExports = requireLoglevel();
var LogLevel;
(function(LogLevel) {
  LogLevel[LogLevel["trace"] = 0] = "trace";
  LogLevel[LogLevel["debug"] = 1] = "debug";
  LogLevel[LogLevel["info"] = 2] = "info";
  LogLevel[LogLevel["warn"] = 3] = "warn";
  LogLevel[LogLevel["error"] = 4] = "error";
  LogLevel[LogLevel["silent"] = 5] = "silent";
})(LogLevel || (LogLevel = {}));
var LoggerNames;
(function(LoggerNames) {
  LoggerNames["Default"] = "livekit";
  LoggerNames["Room"] = "livekit-room";
  LoggerNames["TokenSource"] = "livekit-token-source";
  LoggerNames["Participant"] = "livekit-participant";
  LoggerNames["Track"] = "livekit-track";
  LoggerNames["Publication"] = "livekit-track-publication";
  LoggerNames["Engine"] = "livekit-engine";
  LoggerNames["Signal"] = "livekit-signal";
  LoggerNames["PCManager"] = "livekit-pc-manager";
  LoggerNames["PCTransport"] = "livekit-pc-transport";
  LoggerNames["E2EE"] = "lk-e2ee";
  LoggerNames["DataTracks"] = "livekit-data-tracks";
  LoggerNames["Region"] = "livekit-region";
  LoggerNames["ICE"] = "livekit-ice";
  LoggerNames["Stats"] = "livekit-stats";
})(LoggerNames || (LoggerNames = {}));
var livekitLogger = loglevelExports.getLogger(LoggerNames.Default);
Object.values(LoggerNames).map((name) => loglevelExports.getLogger(name));
livekitLogger.setDefaultLevel(LogLevel.info);
function getLogger(name, ctxFn) {
  const logger = loglevelExports.getLogger(name);
  logger.setDefaultLevel(livekitLogger.getLevel());
  if (!ctxFn) {
    return logger;
  }
  return wrapWithContext(logger, ctxFn);
}
function wrapWithContext(base, ctxFn) {
  const wrap = (method) => (msg, extra) => {
    const ctx = ctxFn();
    const merged = ctx || extra ? Object.assign(Object.assign({}, ctx), extra) : undefined;
    base[method](msg, merged);
  };
  const proxy = Object.create(base);
  proxy.trace = wrap("trace");
  proxy.debug = wrap("debug");
  proxy.info = wrap("info");
  proxy.warn = wrap("warn");
  proxy.error = wrap("error");
  return proxy;
}
var workerLogger = loglevelExports.getLogger(LoggerNames.E2EE);
var workerLogLevelListeners = new Set;
var originalWorkerSetLevel = workerLogger.setLevel.bind(workerLogger);
workerLogger.setLevel = (level, persist) => {
  originalWorkerSetLevel(level, persist);
  const numeric = workerLogger.getLevel();
  workerLogLevelListeners.forEach((cb) => cb(numeric));
};
var e = Object.defineProperty;
var h = (i, s, t) => (s in i) ? e(i, s, {
  enumerable: true,
  configurable: true,
  writable: true,
  value: t
}) : i[s] = t;
var o = (i, s, t) => h(i, typeof s != "symbol" ? s + "" : s, t);

class _ {
  constructor() {
    o(this, "_locking");
    o(this, "_locks");
    this._locking = Promise.resolve(), this._locks = 0;
  }
  isLocked() {
    return this._locks > 0;
  }
  lock() {
    this._locks += 1;
    let s;
    const t = new Promise((l) => s = () => {
      this._locks -= 1, l();
    }), c = this._locking.then(() => s);
    return this._locking = this._locking.then(() => t), c;
  }
}
var QueueTaskStatus;
(function(QueueTaskStatus) {
  QueueTaskStatus[QueueTaskStatus["WAITING"] = 0] = "WAITING";
  QueueTaskStatus[QueueTaskStatus["RUNNING"] = 1] = "RUNNING";
  QueueTaskStatus[QueueTaskStatus["COMPLETED"] = 2] = "COMPLETED";
})(QueueTaskStatus || (QueueTaskStatus = {}));

class AsyncQueue {
  constructor() {
    this.pendingTasks = new Map;
    this.taskMutex = new _;
    this.nextTaskIndex = 0;
  }
  run(task) {
    return __awaiter(this, undefined, undefined, function* () {
      const taskInfo = {
        id: this.nextTaskIndex++,
        enqueuedAt: Date.now(),
        status: QueueTaskStatus.WAITING
      };
      this.pendingTasks.set(taskInfo.id, taskInfo);
      const unlock = yield this.taskMutex.lock();
      try {
        taskInfo.executedAt = Date.now();
        taskInfo.status = QueueTaskStatus.RUNNING;
        return yield task();
      } finally {
        taskInfo.status = QueueTaskStatus.COMPLETED;
        this.pendingTasks.delete(taskInfo.id);
        unlock();
      }
    });
  }
  flush() {
    return __awaiter(this, undefined, undefined, function* () {
      return this.run(() => __awaiter(this, undefined, undefined, function* () {}));
    });
  }
  snapshot() {
    return Array.from(this.pendingTasks.values());
  }
}
var ENCRYPTION_ALGORITHM = "AES-GCM";
var DECRYPTION_FAILURE_TOLERANCE = 10;
var UNENCRYPTED_BYTES = {
  key: 10,
  delta: 3,
  audio: 1,
  empty: 0
};
var IV_LENGTH = 12;
var SALT = "LKFrameEncryptionKey";
var KEY_PROVIDER_DEFAULTS = {
  sharedKey: false,
  ratchetSalt: SALT,
  ratchetWindowSize: 8,
  failureTolerance: DECRYPTION_FAILURE_TOLERANCE,
  keyringSize: 16,
  keySize: 128
};
function assert(condition, msg) {
  if (!condition) {
    throw new Error(msg);
  }
}
var FLOAT32_MAX = 340282346638528860000000000000000000000;
var FLOAT32_MIN = -340282346638528860000000000000000000000;
var UINT32_MAX = 4294967295;
var INT32_MAX = 2147483647;
var INT32_MIN = -2147483648;
function assertInt32(arg) {
  if (typeof arg !== "number")
    throw new Error("invalid int 32: " + typeof arg);
  if (!Number.isInteger(arg) || arg > INT32_MAX || arg < INT32_MIN)
    throw new Error("invalid int 32: " + arg);
}
function assertUInt32(arg) {
  if (typeof arg !== "number")
    throw new Error("invalid uint 32: " + typeof arg);
  if (!Number.isInteger(arg) || arg > UINT32_MAX || arg < 0)
    throw new Error("invalid uint 32: " + arg);
}
function assertFloat32(arg) {
  if (typeof arg !== "number")
    throw new Error("invalid float 32: " + typeof arg);
  if (!Number.isFinite(arg))
    return;
  if (arg > FLOAT32_MAX || arg < FLOAT32_MIN)
    throw new Error("invalid float 32: " + arg);
}
var enumTypeSymbol = Symbol("@bufbuild/protobuf/enum-type");
function getEnumType(enumObject) {
  const t = enumObject[enumTypeSymbol];
  assert(t, "missing enum type on enum object");
  return t;
}
function setEnumType(enumObject, typeName, values, opt) {
  enumObject[enumTypeSymbol] = makeEnumType(typeName, values.map((v) => ({
    no: v.no,
    name: v.name,
    localName: enumObject[v.no]
  })));
}
function makeEnumType(typeName, values, _opt) {
  const names = Object.create(null);
  const numbers = Object.create(null);
  const normalValues = [];
  for (const value of values) {
    const n = normalizeEnumValue(value);
    normalValues.push(n);
    names[value.name] = n;
    numbers[value.no] = n;
  }
  return {
    typeName,
    values: normalValues,
    findName(name) {
      return names[name];
    },
    findNumber(no) {
      return numbers[no];
    }
  };
}
function makeEnum(typeName, values, opt) {
  const enumObject = {};
  for (const value of values) {
    const n = normalizeEnumValue(value);
    enumObject[n.localName] = n.no;
    enumObject[n.no] = n.localName;
  }
  setEnumType(enumObject, typeName, values);
  return enumObject;
}
function normalizeEnumValue(value) {
  if ("localName" in value) {
    return value;
  }
  return Object.assign(Object.assign({}, value), {
    localName: value.name
  });
}

class Message {
  equals(other) {
    return this.getType().runtime.util.equals(this.getType(), this, other);
  }
  clone() {
    return this.getType().runtime.util.clone(this);
  }
  fromBinary(bytes, options) {
    const type = this.getType(), format = type.runtime.bin, opt = format.makeReadOptions(options);
    format.readMessage(this, opt.readerFactory(bytes), bytes.byteLength, opt);
    return this;
  }
  fromJson(jsonValue, options) {
    const type = this.getType(), format = type.runtime.json, opt = format.makeReadOptions(options);
    format.readMessage(type, jsonValue, opt, this);
    return this;
  }
  fromJsonString(jsonString, options) {
    let json;
    try {
      json = JSON.parse(jsonString);
    } catch (e) {
      throw new Error("cannot decode ".concat(this.getType().typeName, " from JSON: ").concat(e instanceof Error ? e.message : String(e)));
    }
    return this.fromJson(json, options);
  }
  toBinary(options) {
    const type = this.getType(), bin = type.runtime.bin, opt = bin.makeWriteOptions(options), writer = opt.writerFactory();
    bin.writeMessage(this, writer, opt);
    return writer.finish();
  }
  toJson(options) {
    const type = this.getType(), json = type.runtime.json, opt = json.makeWriteOptions(options);
    return json.writeMessage(this, opt);
  }
  toJsonString(options) {
    var _a;
    const value = this.toJson(options);
    return JSON.stringify(value, null, (_a = options === null || options === undefined ? undefined : options.prettySpaces) !== null && _a !== undefined ? _a : 0);
  }
  toJSON() {
    return this.toJson({
      emitDefaultValues: true
    });
  }
  getType() {
    return Object.getPrototypeOf(this).constructor;
  }
}
function makeMessageType(runtime, typeName, fields, opt) {
  var _a;
  const localName = (_a = opt === null || opt === undefined ? undefined : opt.localName) !== null && _a !== undefined ? _a : typeName.substring(typeName.lastIndexOf(".") + 1);
  const type = {
    [localName]: function(data) {
      runtime.util.initFields(this);
      runtime.util.initPartial(data, this);
    }
  }[localName];
  Object.setPrototypeOf(type.prototype, new Message);
  Object.assign(type, {
    runtime,
    typeName,
    fields: runtime.util.newFieldList(fields),
    fromBinary(bytes, options) {
      return new type().fromBinary(bytes, options);
    },
    fromJson(jsonValue, options) {
      return new type().fromJson(jsonValue, options);
    },
    fromJsonString(jsonString, options) {
      return new type().fromJsonString(jsonString, options);
    },
    equals(a, b) {
      return runtime.util.equals(type, a, b);
    }
  });
  return type;
}
function varint64read() {
  let lowBits = 0;
  let highBits = 0;
  for (let shift = 0;shift < 28; shift += 7) {
    let b = this.buf[this.pos++];
    lowBits |= (b & 127) << shift;
    if ((b & 128) == 0) {
      this.assertBounds();
      return [lowBits, highBits];
    }
  }
  let middleByte = this.buf[this.pos++];
  lowBits |= (middleByte & 15) << 28;
  highBits = (middleByte & 112) >> 4;
  if ((middleByte & 128) == 0) {
    this.assertBounds();
    return [lowBits, highBits];
  }
  for (let shift = 3;shift <= 31; shift += 7) {
    let b = this.buf[this.pos++];
    highBits |= (b & 127) << shift;
    if ((b & 128) == 0) {
      this.assertBounds();
      return [lowBits, highBits];
    }
  }
  throw new Error("invalid varint");
}
function varint64write(lo, hi, bytes) {
  for (let i = 0;i < 28; i = i + 7) {
    const shift = lo >>> i;
    const hasNext = !(shift >>> 7 == 0 && hi == 0);
    const byte = (hasNext ? shift | 128 : shift) & 255;
    bytes.push(byte);
    if (!hasNext) {
      return;
    }
  }
  const splitBits = lo >>> 28 & 15 | (hi & 7) << 4;
  const hasMoreBits = !(hi >> 3 == 0);
  bytes.push((hasMoreBits ? splitBits | 128 : splitBits) & 255);
  if (!hasMoreBits) {
    return;
  }
  for (let i = 3;i < 31; i = i + 7) {
    const shift = hi >>> i;
    const hasNext = !(shift >>> 7 == 0);
    const byte = (hasNext ? shift | 128 : shift) & 255;
    bytes.push(byte);
    if (!hasNext) {
      return;
    }
  }
  bytes.push(hi >>> 31 & 1);
}
var TWO_PWR_32_DBL = 4294967296;
function int64FromString(dec) {
  const minus = dec[0] === "-";
  if (minus) {
    dec = dec.slice(1);
  }
  const base = 1e6;
  let lowBits = 0;
  let highBits = 0;
  function add1e6digit(begin, end) {
    const digit1e6 = Number(dec.slice(begin, end));
    highBits *= base;
    lowBits = lowBits * base + digit1e6;
    if (lowBits >= TWO_PWR_32_DBL) {
      highBits = highBits + (lowBits / TWO_PWR_32_DBL | 0);
      lowBits = lowBits % TWO_PWR_32_DBL;
    }
  }
  add1e6digit(-24, -18);
  add1e6digit(-18, -12);
  add1e6digit(-12, -6);
  add1e6digit(-6);
  return minus ? negate(lowBits, highBits) : newBits(lowBits, highBits);
}
function int64ToString(lo, hi) {
  let bits = newBits(lo, hi);
  const negative = bits.hi & 2147483648;
  if (negative) {
    bits = negate(bits.lo, bits.hi);
  }
  const result = uInt64ToString(bits.lo, bits.hi);
  return negative ? "-" + result : result;
}
function uInt64ToString(lo, hi) {
  var _toUnsigned = toUnsigned(lo, hi);
  lo = _toUnsigned.lo;
  hi = _toUnsigned.hi;
  if (hi <= 2097151) {
    return String(TWO_PWR_32_DBL * hi + lo);
  }
  const low = lo & 16777215;
  const mid = (lo >>> 24 | hi << 8) & 16777215;
  const high = hi >> 16 & 65535;
  let digitA = low + mid * 6777216 + high * 6710656;
  let digitB = mid + high * 8147497;
  let digitC = high * 2;
  const base = 1e7;
  if (digitA >= base) {
    digitB += Math.floor(digitA / base);
    digitA %= base;
  }
  if (digitB >= base) {
    digitC += Math.floor(digitB / base);
    digitB %= base;
  }
  return digitC.toString() + decimalFrom1e7WithLeadingZeros(digitB) + decimalFrom1e7WithLeadingZeros(digitA);
}
function toUnsigned(lo, hi) {
  return {
    lo: lo >>> 0,
    hi: hi >>> 0
  };
}
function newBits(lo, hi) {
  return {
    lo: lo | 0,
    hi: hi | 0
  };
}
function negate(lowBits, highBits) {
  highBits = ~highBits;
  if (lowBits) {
    lowBits = ~lowBits + 1;
  } else {
    highBits += 1;
  }
  return newBits(lowBits, highBits);
}
var decimalFrom1e7WithLeadingZeros = (digit1e7) => {
  const partial = String(digit1e7);
  return "0000000".slice(partial.length) + partial;
};
function varint32write(value, bytes) {
  if (value >= 0) {
    while (value > 127) {
      bytes.push(value & 127 | 128);
      value = value >>> 7;
    }
    bytes.push(value);
  } else {
    for (let i = 0;i < 9; i++) {
      bytes.push(value & 127 | 128);
      value = value >> 7;
    }
    bytes.push(1);
  }
}
function varint32read() {
  let b = this.buf[this.pos++];
  let result = b & 127;
  if ((b & 128) == 0) {
    this.assertBounds();
    return result;
  }
  b = this.buf[this.pos++];
  result |= (b & 127) << 7;
  if ((b & 128) == 0) {
    this.assertBounds();
    return result;
  }
  b = this.buf[this.pos++];
  result |= (b & 127) << 14;
  if ((b & 128) == 0) {
    this.assertBounds();
    return result;
  }
  b = this.buf[this.pos++];
  result |= (b & 127) << 21;
  if ((b & 128) == 0) {
    this.assertBounds();
    return result;
  }
  b = this.buf[this.pos++];
  result |= (b & 15) << 28;
  for (let readBytes = 5;(b & 128) !== 0 && readBytes < 10; readBytes++)
    b = this.buf[this.pos++];
  if ((b & 128) != 0)
    throw new Error("invalid varint");
  this.assertBounds();
  return result >>> 0;
}
function makeInt64Support() {
  const dv = new DataView(new ArrayBuffer(8));
  const ok = typeof BigInt === "function" && typeof dv.getBigInt64 === "function" && typeof dv.getBigUint64 === "function" && typeof dv.setBigInt64 === "function" && typeof dv.setBigUint64 === "function" && (typeof process != "object" || typeof process.env != "object" || process.env.BUF_BIGINT_DISABLE !== "1");
  if (ok) {
    const MIN = BigInt("-9223372036854775808"), MAX = BigInt("9223372036854775807"), UMIN = BigInt("0"), UMAX = BigInt("18446744073709551615");
    return {
      zero: BigInt(0),
      supported: true,
      parse(value) {
        const bi = typeof value == "bigint" ? value : BigInt(value);
        if (bi > MAX || bi < MIN) {
          throw new Error("int64 invalid: ".concat(value));
        }
        return bi;
      },
      uParse(value) {
        const bi = typeof value == "bigint" ? value : BigInt(value);
        if (bi > UMAX || bi < UMIN) {
          throw new Error("uint64 invalid: ".concat(value));
        }
        return bi;
      },
      enc(value) {
        dv.setBigInt64(0, this.parse(value), true);
        return {
          lo: dv.getInt32(0, true),
          hi: dv.getInt32(4, true)
        };
      },
      uEnc(value) {
        dv.setBigInt64(0, this.uParse(value), true);
        return {
          lo: dv.getInt32(0, true),
          hi: dv.getInt32(4, true)
        };
      },
      dec(lo, hi) {
        dv.setInt32(0, lo, true);
        dv.setInt32(4, hi, true);
        return dv.getBigInt64(0, true);
      },
      uDec(lo, hi) {
        dv.setInt32(0, lo, true);
        dv.setInt32(4, hi, true);
        return dv.getBigUint64(0, true);
      }
    };
  }
  const assertInt64String = (value) => assert(/^-?[0-9]+$/.test(value), "int64 invalid: ".concat(value));
  const assertUInt64String = (value) => assert(/^[0-9]+$/.test(value), "uint64 invalid: ".concat(value));
  return {
    zero: "0",
    supported: false,
    parse(value) {
      if (typeof value != "string") {
        value = value.toString();
      }
      assertInt64String(value);
      return value;
    },
    uParse(value) {
      if (typeof value != "string") {
        value = value.toString();
      }
      assertUInt64String(value);
      return value;
    },
    enc(value) {
      if (typeof value != "string") {
        value = value.toString();
      }
      assertInt64String(value);
      return int64FromString(value);
    },
    uEnc(value) {
      if (typeof value != "string") {
        value = value.toString();
      }
      assertUInt64String(value);
      return int64FromString(value);
    },
    dec(lo, hi) {
      return int64ToString(lo, hi);
    },
    uDec(lo, hi) {
      return uInt64ToString(lo, hi);
    }
  };
}
var protoInt64 = makeInt64Support();
var ScalarType;
(function(ScalarType) {
  ScalarType[ScalarType["DOUBLE"] = 1] = "DOUBLE";
  ScalarType[ScalarType["FLOAT"] = 2] = "FLOAT";
  ScalarType[ScalarType["INT64"] = 3] = "INT64";
  ScalarType[ScalarType["UINT64"] = 4] = "UINT64";
  ScalarType[ScalarType["INT32"] = 5] = "INT32";
  ScalarType[ScalarType["FIXED64"] = 6] = "FIXED64";
  ScalarType[ScalarType["FIXED32"] = 7] = "FIXED32";
  ScalarType[ScalarType["BOOL"] = 8] = "BOOL";
  ScalarType[ScalarType["STRING"] = 9] = "STRING";
  ScalarType[ScalarType["BYTES"] = 12] = "BYTES";
  ScalarType[ScalarType["UINT32"] = 13] = "UINT32";
  ScalarType[ScalarType["SFIXED32"] = 15] = "SFIXED32";
  ScalarType[ScalarType["SFIXED64"] = 16] = "SFIXED64";
  ScalarType[ScalarType["SINT32"] = 17] = "SINT32";
  ScalarType[ScalarType["SINT64"] = 18] = "SINT64";
})(ScalarType || (ScalarType = {}));
var LongType;
(function(LongType) {
  LongType[LongType["BIGINT"] = 0] = "BIGINT";
  LongType[LongType["STRING"] = 1] = "STRING";
})(LongType || (LongType = {}));
function scalarEquals(type, a, b) {
  if (a === b) {
    return true;
  }
  if (type == ScalarType.BYTES) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) {
      return false;
    }
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0;i < a.length; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }
  switch (type) {
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
    case ScalarType.INT64:
    case ScalarType.SFIXED64:
    case ScalarType.SINT64:
      return a == b;
  }
  return false;
}
function scalarZeroValue(type, longType) {
  switch (type) {
    case ScalarType.BOOL:
      return false;
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
    case ScalarType.INT64:
    case ScalarType.SFIXED64:
    case ScalarType.SINT64:
      return longType == 0 ? protoInt64.zero : "0";
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT:
      return 0;
    case ScalarType.BYTES:
      return new Uint8Array(0);
    case ScalarType.STRING:
      return "";
    default:
      return 0;
  }
}
function isScalarZeroValue(type, value) {
  switch (type) {
    case ScalarType.BOOL:
      return value === false;
    case ScalarType.STRING:
      return value === "";
    case ScalarType.BYTES:
      return value instanceof Uint8Array && !value.byteLength;
    default:
      return value == 0;
  }
}
function _arrayLikeToArray(r, a) {
  (a == null || a > r.length) && (a = r.length);
  for (var e = 0, n = Array(a);e < a; e++)
    n[e] = r[e];
  return n;
}
function _arrayWithHoles(r) {
  if (Array.isArray(r))
    return r;
}
function _iterableToArrayLimit(r, l) {
  var t = r == null ? null : typeof Symbol != "undefined" && r[Symbol.iterator] || r["@@iterator"];
  if (t != null) {
    var e, n, i, u, a = [], f = true, o = false;
    try {
      if (i = (t = t.call(r)).next, l === 0) {
        if (Object(t) !== t)
          return;
        f = false;
      } else
        for (;!(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l); f = true)
          ;
    } catch (r) {
      o = true, n = r;
    } finally {
      try {
        if (!f && t.return != null && (u = t.return(), Object(u) !== u))
          return;
      } finally {
        if (o)
          throw n;
      }
    }
    return a;
  }
}
function _nonIterableRest() {
  throw new TypeError(`Invalid attempt to destructure non-iterable instance.
In order to be iterable, non-array objects must have a [Symbol.iterator]() method.`);
}
function _slicedToArray(r, e) {
  return _arrayWithHoles(r) || _iterableToArrayLimit(r, e) || _unsupportedIterableToArray(r, e) || _nonIterableRest();
}
function _unsupportedIterableToArray(r, a) {
  if (r) {
    if (typeof r == "string")
      return _arrayLikeToArray(r, a);
    var t = {}.toString.call(r).slice(8, -1);
    return t === "Object" && r.constructor && (t = r.constructor.name), t === "Map" || t === "Set" ? Array.from(r) : t === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t) ? _arrayLikeToArray(r, a) : undefined;
  }
}
var WireType;
(function(WireType) {
  WireType[WireType["Varint"] = 0] = "Varint";
  WireType[WireType["Bit64"] = 1] = "Bit64";
  WireType[WireType["LengthDelimited"] = 2] = "LengthDelimited";
  WireType[WireType["StartGroup"] = 3] = "StartGroup";
  WireType[WireType["EndGroup"] = 4] = "EndGroup";
  WireType[WireType["Bit32"] = 5] = "Bit32";
})(WireType || (WireType = {}));

class BinaryWriter {
  constructor(textEncoder) {
    this.stack = [];
    this.textEncoder = textEncoder !== null && textEncoder !== undefined ? textEncoder : new TextEncoder;
    this.chunks = [];
    this.buf = [];
  }
  finish() {
    this.chunks.push(new Uint8Array(this.buf));
    let len = 0;
    for (let i = 0;i < this.chunks.length; i++)
      len += this.chunks[i].length;
    let bytes = new Uint8Array(len);
    let offset = 0;
    for (let i = 0;i < this.chunks.length; i++) {
      bytes.set(this.chunks[i], offset);
      offset += this.chunks[i].length;
    }
    this.chunks = [];
    return bytes;
  }
  fork() {
    this.stack.push({
      chunks: this.chunks,
      buf: this.buf
    });
    this.chunks = [];
    this.buf = [];
    return this;
  }
  join() {
    let chunk = this.finish();
    let prev = this.stack.pop();
    if (!prev)
      throw new Error("invalid state, fork stack empty");
    this.chunks = prev.chunks;
    this.buf = prev.buf;
    this.uint32(chunk.byteLength);
    return this.raw(chunk);
  }
  tag(fieldNo, type) {
    return this.uint32((fieldNo << 3 | type) >>> 0);
  }
  raw(chunk) {
    if (this.buf.length) {
      this.chunks.push(new Uint8Array(this.buf));
      this.buf = [];
    }
    this.chunks.push(chunk);
    return this;
  }
  uint32(value) {
    assertUInt32(value);
    while (value > 127) {
      this.buf.push(value & 127 | 128);
      value = value >>> 7;
    }
    this.buf.push(value);
    return this;
  }
  int32(value) {
    assertInt32(value);
    varint32write(value, this.buf);
    return this;
  }
  bool(value) {
    this.buf.push(value ? 1 : 0);
    return this;
  }
  bytes(value) {
    this.uint32(value.byteLength);
    return this.raw(value);
  }
  string(value) {
    let chunk = this.textEncoder.encode(value);
    this.uint32(chunk.byteLength);
    return this.raw(chunk);
  }
  float(value) {
    assertFloat32(value);
    let chunk = new Uint8Array(4);
    new DataView(chunk.buffer).setFloat32(0, value, true);
    return this.raw(chunk);
  }
  double(value) {
    let chunk = new Uint8Array(8);
    new DataView(chunk.buffer).setFloat64(0, value, true);
    return this.raw(chunk);
  }
  fixed32(value) {
    assertUInt32(value);
    let chunk = new Uint8Array(4);
    new DataView(chunk.buffer).setUint32(0, value, true);
    return this.raw(chunk);
  }
  sfixed32(value) {
    assertInt32(value);
    let chunk = new Uint8Array(4);
    new DataView(chunk.buffer).setInt32(0, value, true);
    return this.raw(chunk);
  }
  sint32(value) {
    assertInt32(value);
    value = (value << 1 ^ value >> 31) >>> 0;
    varint32write(value, this.buf);
    return this;
  }
  sfixed64(value) {
    let chunk = new Uint8Array(8), view = new DataView(chunk.buffer), tc = protoInt64.enc(value);
    view.setInt32(0, tc.lo, true);
    view.setInt32(4, tc.hi, true);
    return this.raw(chunk);
  }
  fixed64(value) {
    let chunk = new Uint8Array(8), view = new DataView(chunk.buffer), tc = protoInt64.uEnc(value);
    view.setInt32(0, tc.lo, true);
    view.setInt32(4, tc.hi, true);
    return this.raw(chunk);
  }
  int64(value) {
    let tc = protoInt64.enc(value);
    varint64write(tc.lo, tc.hi, this.buf);
    return this;
  }
  sint64(value) {
    let tc = protoInt64.enc(value), sign = tc.hi >> 31, lo = tc.lo << 1 ^ sign, hi = (tc.hi << 1 | tc.lo >>> 31) ^ sign;
    varint64write(lo, hi, this.buf);
    return this;
  }
  uint64(value) {
    let tc = protoInt64.uEnc(value);
    varint64write(tc.lo, tc.hi, this.buf);
    return this;
  }
}

class BinaryReader {
  constructor(buf, textDecoder) {
    this.varint64 = varint64read;
    this.uint32 = varint32read;
    this.buf = buf;
    this.len = buf.length;
    this.pos = 0;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.textDecoder = textDecoder !== null && textDecoder !== undefined ? textDecoder : new TextDecoder;
  }
  tag() {
    let tag = this.uint32(), fieldNo = tag >>> 3, wireType = tag & 7;
    if (fieldNo <= 0 || wireType < 0 || wireType > 5)
      throw new Error("illegal tag: field no " + fieldNo + " wire type " + wireType);
    return [fieldNo, wireType];
  }
  skip(wireType, fieldNo) {
    let start = this.pos;
    switch (wireType) {
      case WireType.Varint:
        while (this.buf[this.pos++] & 128) {}
        break;
      case WireType.Bit64:
        this.pos += 4;
      case WireType.Bit32:
        this.pos += 4;
        break;
      case WireType.LengthDelimited:
        let len = this.uint32();
        this.pos += len;
        break;
      case WireType.StartGroup:
        for (;; ) {
          const _this$tag = this.tag(), _this$tag2 = _slicedToArray(_this$tag, 2), fn = _this$tag2[0], wt = _this$tag2[1];
          if (wt === WireType.EndGroup) {
            if (fieldNo !== undefined && fn !== fieldNo) {
              throw new Error("invalid end group tag");
            }
            break;
          }
          this.skip(wt, fn);
        }
        break;
      default:
        throw new Error("cant skip wire type " + wireType);
    }
    this.assertBounds();
    return this.buf.subarray(start, this.pos);
  }
  assertBounds() {
    if (this.pos > this.len)
      throw new RangeError("premature EOF");
  }
  int32() {
    return this.uint32() | 0;
  }
  sint32() {
    let zze = this.uint32();
    return zze >>> 1 ^ -(zze & 1);
  }
  int64() {
    return protoInt64.dec(...this.varint64());
  }
  uint64() {
    return protoInt64.uDec(...this.varint64());
  }
  sint64() {
    let _this$varint = this.varint64(), _this$varint2 = _slicedToArray(_this$varint, 2), lo = _this$varint2[0], hi = _this$varint2[1];
    let s = -(lo & 1);
    lo = (lo >>> 1 | (hi & 1) << 31) ^ s;
    hi = hi >>> 1 ^ s;
    return protoInt64.dec(lo, hi);
  }
  bool() {
    let _this$varint3 = this.varint64(), _this$varint4 = _slicedToArray(_this$varint3, 2), lo = _this$varint4[0], hi = _this$varint4[1];
    return lo !== 0 || hi !== 0;
  }
  fixed32() {
    return this.view.getUint32((this.pos += 4) - 4, true);
  }
  sfixed32() {
    return this.view.getInt32((this.pos += 4) - 4, true);
  }
  fixed64() {
    return protoInt64.uDec(this.sfixed32(), this.sfixed32());
  }
  sfixed64() {
    return protoInt64.dec(this.sfixed32(), this.sfixed32());
  }
  float() {
    return this.view.getFloat32((this.pos += 4) - 4, true);
  }
  double() {
    return this.view.getFloat64((this.pos += 8) - 8, true);
  }
  bytes() {
    let len = this.uint32(), start = this.pos;
    this.pos += len;
    this.assertBounds();
    return this.buf.subarray(start, start + len);
  }
  string() {
    return this.textDecoder.decode(this.bytes());
  }
}
function makeExtension(runtime, typeName, extendee, field) {
  let fi;
  return {
    typeName,
    extendee,
    get field() {
      if (!fi) {
        const i = typeof field == "function" ? field() : field;
        i.name = typeName.split(".").pop();
        i.jsonName = "[".concat(typeName, "]");
        fi = runtime.util.newFieldList([i]).list()[0];
      }
      return fi;
    },
    runtime
  };
}
function createExtensionContainer(extension) {
  const localName = extension.field.localName;
  const container = Object.create(null);
  container[localName] = initExtensionField(extension);
  return [container, () => container[localName]];
}
function initExtensionField(ext) {
  const field = ext.field;
  if (field.repeated) {
    return [];
  }
  if (field.default !== undefined) {
    return field.default;
  }
  switch (field.kind) {
    case "enum":
      return field.T.values[0].no;
    case "scalar":
      return scalarZeroValue(field.T, field.L);
    case "message":
      const T = field.T, value = new T;
      return T.fieldWrapper ? T.fieldWrapper.unwrapField(value) : value;
    case "map":
      throw "map fields are not allowed to be extensions";
  }
}
function filterUnknownFields(unknownFields, field) {
  if (!field.repeated && (field.kind == "enum" || field.kind == "scalar")) {
    for (let i = unknownFields.length - 1;i >= 0; --i) {
      if (unknownFields[i].no == field.no) {
        return [unknownFields[i]];
      }
    }
    return [];
  }
  return unknownFields.filter((uf) => uf.no === field.no);
}
var encTable = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("");
var decTable = [];
for (let i = 0;i < encTable.length; i++)
  decTable[encTable[i].charCodeAt(0)] = i;
decTable[45] = encTable.indexOf("+");
decTable[95] = encTable.indexOf("/");
var protoBase64 = {
  dec(base64Str) {
    let es = base64Str.length * 3 / 4;
    if (base64Str[base64Str.length - 2] == "=")
      es -= 2;
    else if (base64Str[base64Str.length - 1] == "=")
      es -= 1;
    let bytes = new Uint8Array(es), bytePos = 0, groupPos = 0, b, p = 0;
    for (let i = 0;i < base64Str.length; i++) {
      b = decTable[base64Str.charCodeAt(i)];
      if (b === undefined) {
        switch (base64Str[i]) {
          case "=":
            groupPos = 0;
          case `
`:
          case "\r":
          case "\t":
          case " ":
            continue;
          default:
            throw Error("invalid base64 string.");
        }
      }
      switch (groupPos) {
        case 0:
          p = b;
          groupPos = 1;
          break;
        case 1:
          bytes[bytePos++] = p << 2 | (b & 48) >> 4;
          p = b;
          groupPos = 2;
          break;
        case 2:
          bytes[bytePos++] = (p & 15) << 4 | (b & 60) >> 2;
          p = b;
          groupPos = 3;
          break;
        case 3:
          bytes[bytePos++] = (p & 3) << 6 | b;
          groupPos = 0;
          break;
      }
    }
    if (groupPos == 1)
      throw Error("invalid base64 string.");
    return bytes.subarray(0, bytePos);
  },
  enc(bytes) {
    let base64 = "", groupPos = 0, b, p = 0;
    for (let i = 0;i < bytes.length; i++) {
      b = bytes[i];
      switch (groupPos) {
        case 0:
          base64 += encTable[b >> 2];
          p = (b & 3) << 4;
          groupPos = 1;
          break;
        case 1:
          base64 += encTable[p | b >> 4];
          p = (b & 15) << 2;
          groupPos = 2;
          break;
        case 2:
          base64 += encTable[p | b >> 6];
          base64 += encTable[b & 63];
          groupPos = 0;
          break;
      }
    }
    if (groupPos) {
      base64 += encTable[p];
      base64 += "=";
      if (groupPos == 1)
        base64 += "=";
    }
    return base64;
  }
};
function getExtension(message, extension, options) {
  assertExtendee(extension, message);
  const opt = extension.runtime.bin.makeReadOptions(options);
  const ufs = filterUnknownFields(message.getType().runtime.bin.listUnknownFields(message), extension.field);
  const _createExtensionConta = createExtensionContainer(extension), _createExtensionConta2 = _slicedToArray(_createExtensionConta, 2), container = _createExtensionConta2[0], get = _createExtensionConta2[1];
  for (const uf of ufs) {
    extension.runtime.bin.readField(container, opt.readerFactory(uf.data), extension.field, uf.wireType, opt);
  }
  return get();
}
function setExtension(message, extension, value, options) {
  assertExtendee(extension, message);
  const readOpt = extension.runtime.bin.makeReadOptions(options);
  const writeOpt = extension.runtime.bin.makeWriteOptions(options);
  if (hasExtension(message, extension)) {
    const ufs = message.getType().runtime.bin.listUnknownFields(message).filter((uf) => uf.no != extension.field.no);
    message.getType().runtime.bin.discardUnknownFields(message);
    for (const uf of ufs) {
      message.getType().runtime.bin.onUnknownField(message, uf.no, uf.wireType, uf.data);
    }
  }
  const writer = writeOpt.writerFactory();
  let f = extension.field;
  if (!f.opt && !f.repeated && (f.kind == "enum" || f.kind == "scalar")) {
    f = Object.assign(Object.assign({}, extension.field), {
      opt: true
    });
  }
  extension.runtime.bin.writeField(f, value, writer, writeOpt);
  const reader = readOpt.readerFactory(writer.finish());
  while (reader.pos < reader.len) {
    const _reader$tag = reader.tag(), _reader$tag2 = _slicedToArray(_reader$tag, 2), no = _reader$tag2[0], wireType = _reader$tag2[1];
    const data = reader.skip(wireType, no);
    message.getType().runtime.bin.onUnknownField(message, no, wireType, data);
  }
}
function hasExtension(message, extension) {
  const messageType = message.getType();
  return extension.extendee.typeName === messageType.typeName && !!messageType.runtime.bin.listUnknownFields(message).find((uf) => uf.no == extension.field.no);
}
function assertExtendee(extension, message) {
  assert(extension.extendee.typeName == message.getType().typeName, "extension ".concat(extension.typeName, " can only be applied to message ").concat(extension.extendee.typeName));
}
function isFieldSet(field, target) {
  const localName = field.localName;
  if (field.repeated) {
    return target[localName].length > 0;
  }
  if (field.oneof) {
    return target[field.oneof.localName].case === localName;
  }
  switch (field.kind) {
    case "enum":
    case "scalar":
      if (field.opt || field.req) {
        return target[localName] !== undefined;
      }
      if (field.kind == "enum") {
        return target[localName] !== field.T.values[0].no;
      }
      return !isScalarZeroValue(field.T, target[localName]);
    case "message":
      return target[localName] !== undefined;
    case "map":
      return Object.keys(target[localName]).length > 0;
  }
}
function clearField(field, target) {
  const localName = field.localName;
  const implicitPresence = !field.opt && !field.req;
  if (field.repeated) {
    target[localName] = [];
  } else if (field.oneof) {
    target[field.oneof.localName] = {
      case: undefined
    };
  } else {
    switch (field.kind) {
      case "map":
        target[localName] = {};
        break;
      case "enum":
        target[localName] = implicitPresence ? field.T.values[0].no : undefined;
        break;
      case "scalar":
        target[localName] = implicitPresence ? scalarZeroValue(field.T, field.L) : undefined;
        break;
      case "message":
        target[localName] = undefined;
        break;
    }
  }
}
function isMessage(arg, type) {
  if (arg === null || typeof arg != "object") {
    return false;
  }
  if (!Object.getOwnPropertyNames(Message.prototype).every((m) => (m in arg) && typeof arg[m] == "function")) {
    return false;
  }
  const actualType = arg.getType();
  if (actualType === null || typeof actualType != "function" || !("typeName" in actualType) || typeof actualType.typeName != "string") {
    return false;
  }
  return type === undefined ? true : actualType.typeName == type.typeName;
}
function wrapField(type, value) {
  if (isMessage(value) || !type.fieldWrapper) {
    return value;
  }
  return type.fieldWrapper.wrapField(value);
}
ScalarType.DOUBLE, ScalarType.FLOAT, ScalarType.INT64, ScalarType.UINT64, ScalarType.INT32, ScalarType.UINT32, ScalarType.BOOL, ScalarType.STRING, ScalarType.BYTES;
var jsonReadDefaults = {
  ignoreUnknownFields: false
};
var jsonWriteDefaults = {
  emitDefaultValues: false,
  enumAsInteger: false,
  useProtoFieldName: false,
  prettySpaces: 0
};
function makeReadOptions$1(options) {
  return options ? Object.assign(Object.assign({}, jsonReadDefaults), options) : jsonReadDefaults;
}
function makeWriteOptions$1(options) {
  return options ? Object.assign(Object.assign({}, jsonWriteDefaults), options) : jsonWriteDefaults;
}
var tokenNull = Symbol();
var tokenIgnoredUnknownEnum = Symbol();
function makeJsonFormat() {
  return {
    makeReadOptions: makeReadOptions$1,
    makeWriteOptions: makeWriteOptions$1,
    readMessage(type, json, options, message) {
      if (json == null || Array.isArray(json) || typeof json != "object") {
        throw new Error("cannot decode message ".concat(type.typeName, " from JSON: ").concat(debugJsonValue(json)));
      }
      message = message !== null && message !== undefined ? message : new type;
      const oneofSeen = new Map;
      const registry = options.typeRegistry;
      for (const _ref of Object.entries(json)) {
        var _ref2 = _slicedToArray(_ref, 2);
        const jsonKey = _ref2[0];
        const jsonValue = _ref2[1];
        const field = type.fields.findJsonName(jsonKey);
        if (field) {
          if (field.oneof) {
            if (jsonValue === null && field.kind == "scalar") {
              continue;
            }
            const seen = oneofSeen.get(field.oneof);
            if (seen !== undefined) {
              throw new Error("cannot decode message ".concat(type.typeName, ' from JSON: multiple keys for oneof "').concat(field.oneof.name, '" present: "').concat(seen, '", "').concat(jsonKey, '"'));
            }
            oneofSeen.set(field.oneof, jsonKey);
          }
          readField$1(message, jsonValue, field, options, type);
        } else {
          let found = false;
          if ((registry === null || registry === undefined ? undefined : registry.findExtension) && jsonKey.startsWith("[") && jsonKey.endsWith("]")) {
            const ext = registry.findExtension(jsonKey.substring(1, jsonKey.length - 1));
            if (ext && ext.extendee.typeName == type.typeName) {
              found = true;
              const _createExtensionConta = createExtensionContainer(ext), _createExtensionConta2 = _slicedToArray(_createExtensionConta, 2), container = _createExtensionConta2[0], get = _createExtensionConta2[1];
              readField$1(container, jsonValue, ext.field, options, ext);
              setExtension(message, ext, get(), options);
            }
          }
          if (!found && !options.ignoreUnknownFields) {
            throw new Error("cannot decode message ".concat(type.typeName, ' from JSON: key "').concat(jsonKey, '" is unknown'));
          }
        }
      }
      return message;
    },
    writeMessage(message, options) {
      const type = message.getType();
      const json = {};
      let field;
      try {
        for (field of type.fields.byNumber()) {
          if (!isFieldSet(field, message)) {
            if (field.req) {
              throw "required field not set";
            }
            if (!options.emitDefaultValues) {
              continue;
            }
            if (!canEmitFieldDefaultValue(field)) {
              continue;
            }
          }
          const value = field.oneof ? message[field.oneof.localName].value : message[field.localName];
          const jsonValue = writeField$1(field, value, options);
          if (jsonValue !== undefined) {
            json[options.useProtoFieldName ? field.name : field.jsonName] = jsonValue;
          }
        }
        const registry = options.typeRegistry;
        if (registry === null || registry === undefined ? undefined : registry.findExtensionFor) {
          for (const uf of type.runtime.bin.listUnknownFields(message)) {
            const ext = registry.findExtensionFor(type.typeName, uf.no);
            if (ext && hasExtension(message, ext)) {
              const value = getExtension(message, ext, options);
              const jsonValue = writeField$1(ext.field, value, options);
              if (jsonValue !== undefined) {
                json[ext.field.jsonName] = jsonValue;
              }
            }
          }
        }
      } catch (e) {
        const m = field ? "cannot encode field ".concat(type.typeName, ".").concat(field.name, " to JSON") : "cannot encode message ".concat(type.typeName, " to JSON");
        const r = e instanceof Error ? e.message : String(e);
        throw new Error(m + (r.length > 0 ? ": ".concat(r) : ""));
      }
      return json;
    },
    readScalar(type, json, longType) {
      return readScalar$1(type, json, longType !== null && longType !== undefined ? longType : LongType.BIGINT, true);
    },
    writeScalar(type, value, emitDefaultValues) {
      if (value === undefined) {
        return;
      }
      if (emitDefaultValues || isScalarZeroValue(type, value)) {
        return writeScalar$1(type, value);
      }
      return;
    },
    debug: debugJsonValue
  };
}
function debugJsonValue(json) {
  if (json === null) {
    return "null";
  }
  switch (typeof json) {
    case "object":
      return Array.isArray(json) ? "array" : "object";
    case "string":
      return json.length > 100 ? "string" : '"'.concat(json.split('"').join("\\\""), '"');
    default:
      return String(json);
  }
}
function readField$1(target, jsonValue, field, options, parentType) {
  let localName = field.localName;
  if (field.repeated) {
    assert(field.kind != "map");
    if (jsonValue === null) {
      return;
    }
    if (!Array.isArray(jsonValue)) {
      throw new Error("cannot decode field ".concat(parentType.typeName, ".").concat(field.name, " from JSON: ").concat(debugJsonValue(jsonValue)));
    }
    const targetArray = target[localName];
    for (const jsonItem of jsonValue) {
      if (jsonItem === null) {
        throw new Error("cannot decode field ".concat(parentType.typeName, ".").concat(field.name, " from JSON: ").concat(debugJsonValue(jsonItem)));
      }
      switch (field.kind) {
        case "message":
          targetArray.push(field.T.fromJson(jsonItem, options));
          break;
        case "enum":
          const enumValue = readEnum(field.T, jsonItem, options.ignoreUnknownFields, true);
          if (enumValue !== tokenIgnoredUnknownEnum) {
            targetArray.push(enumValue);
          }
          break;
        case "scalar":
          try {
            targetArray.push(readScalar$1(field.T, jsonItem, field.L, true));
          } catch (e) {
            let m = "cannot decode field ".concat(parentType.typeName, ".").concat(field.name, " from JSON: ").concat(debugJsonValue(jsonItem));
            if (e instanceof Error && e.message.length > 0) {
              m += ": ".concat(e.message);
            }
            throw new Error(m);
          }
          break;
      }
    }
  } else if (field.kind == "map") {
    if (jsonValue === null) {
      return;
    }
    if (typeof jsonValue != "object" || Array.isArray(jsonValue)) {
      throw new Error("cannot decode field ".concat(parentType.typeName, ".").concat(field.name, " from JSON: ").concat(debugJsonValue(jsonValue)));
    }
    const targetMap = target[localName];
    for (const _ref3 of Object.entries(jsonValue)) {
      var _ref4 = _slicedToArray(_ref3, 2);
      const jsonMapKey = _ref4[0];
      const jsonMapValue = _ref4[1];
      if (jsonMapValue === null) {
        throw new Error("cannot decode field ".concat(parentType.typeName, ".").concat(field.name, " from JSON: map value null"));
      }
      let key;
      try {
        key = readMapKey(field.K, jsonMapKey);
      } catch (e) {
        let m = "cannot decode map key for field ".concat(parentType.typeName, ".").concat(field.name, " from JSON: ").concat(debugJsonValue(jsonValue));
        if (e instanceof Error && e.message.length > 0) {
          m += ": ".concat(e.message);
        }
        throw new Error(m);
      }
      switch (field.V.kind) {
        case "message":
          targetMap[key] = field.V.T.fromJson(jsonMapValue, options);
          break;
        case "enum":
          const enumValue = readEnum(field.V.T, jsonMapValue, options.ignoreUnknownFields, true);
          if (enumValue !== tokenIgnoredUnknownEnum) {
            targetMap[key] = enumValue;
          }
          break;
        case "scalar":
          try {
            targetMap[key] = readScalar$1(field.V.T, jsonMapValue, LongType.BIGINT, true);
          } catch (e) {
            let m = "cannot decode map value for field ".concat(parentType.typeName, ".").concat(field.name, " from JSON: ").concat(debugJsonValue(jsonValue));
            if (e instanceof Error && e.message.length > 0) {
              m += ": ".concat(e.message);
            }
            throw new Error(m);
          }
          break;
      }
    }
  } else {
    if (field.oneof) {
      target = target[field.oneof.localName] = {
        case: localName
      };
      localName = "value";
    }
    switch (field.kind) {
      case "message":
        const messageType = field.T;
        if (jsonValue === null && messageType.typeName != "google.protobuf.Value") {
          return;
        }
        let currentValue = target[localName];
        if (isMessage(currentValue)) {
          currentValue.fromJson(jsonValue, options);
        } else {
          target[localName] = currentValue = messageType.fromJson(jsonValue, options);
          if (messageType.fieldWrapper && !field.oneof) {
            target[localName] = messageType.fieldWrapper.unwrapField(currentValue);
          }
        }
        break;
      case "enum":
        const enumValue = readEnum(field.T, jsonValue, options.ignoreUnknownFields, false);
        switch (enumValue) {
          case tokenNull:
            clearField(field, target);
            break;
          case tokenIgnoredUnknownEnum:
            break;
          default:
            target[localName] = enumValue;
            break;
        }
        break;
      case "scalar":
        try {
          const scalarValue = readScalar$1(field.T, jsonValue, field.L, false);
          switch (scalarValue) {
            case tokenNull:
              clearField(field, target);
              break;
            default:
              target[localName] = scalarValue;
              break;
          }
        } catch (e) {
          let m = "cannot decode field ".concat(parentType.typeName, ".").concat(field.name, " from JSON: ").concat(debugJsonValue(jsonValue));
          if (e instanceof Error && e.message.length > 0) {
            m += ": ".concat(e.message);
          }
          throw new Error(m);
        }
        break;
    }
  }
}
function readMapKey(type, json) {
  if (type === ScalarType.BOOL) {
    switch (json) {
      case "true":
        json = true;
        break;
      case "false":
        json = false;
        break;
    }
  }
  return readScalar$1(type, json, LongType.BIGINT, true).toString();
}
function readScalar$1(type, json, longType, nullAsZeroValue) {
  if (json === null) {
    if (nullAsZeroValue) {
      return scalarZeroValue(type, longType);
    }
    return tokenNull;
  }
  switch (type) {
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT:
      if (json === "NaN")
        return Number.NaN;
      if (json === "Infinity")
        return Number.POSITIVE_INFINITY;
      if (json === "-Infinity")
        return Number.NEGATIVE_INFINITY;
      if (json === "") {
        break;
      }
      if (typeof json == "string" && json.trim().length !== json.length) {
        break;
      }
      if (typeof json != "string" && typeof json != "number") {
        break;
      }
      const float = Number(json);
      if (Number.isNaN(float)) {
        break;
      }
      if (!Number.isFinite(float)) {
        break;
      }
      if (type == ScalarType.FLOAT)
        assertFloat32(float);
      return float;
    case ScalarType.INT32:
    case ScalarType.FIXED32:
    case ScalarType.SFIXED32:
    case ScalarType.SINT32:
    case ScalarType.UINT32:
      let int32;
      if (typeof json == "number")
        int32 = json;
      else if (typeof json == "string" && json.length > 0) {
        if (json.trim().length === json.length)
          int32 = Number(json);
      }
      if (int32 === undefined)
        break;
      if (type == ScalarType.UINT32 || type == ScalarType.FIXED32)
        assertUInt32(int32);
      else
        assertInt32(int32);
      return int32;
    case ScalarType.INT64:
    case ScalarType.SFIXED64:
    case ScalarType.SINT64:
      if (typeof json != "number" && typeof json != "string")
        break;
      const long = protoInt64.parse(json);
      return longType ? long.toString() : long;
    case ScalarType.FIXED64:
    case ScalarType.UINT64:
      if (typeof json != "number" && typeof json != "string")
        break;
      const uLong = protoInt64.uParse(json);
      return longType ? uLong.toString() : uLong;
    case ScalarType.BOOL:
      if (typeof json !== "boolean")
        break;
      return json;
    case ScalarType.STRING:
      if (typeof json !== "string") {
        break;
      }
      try {
        encodeURIComponent(json);
      } catch (e) {
        throw new Error("invalid UTF8");
      }
      return json;
    case ScalarType.BYTES:
      if (json === "")
        return new Uint8Array(0);
      if (typeof json !== "string")
        break;
      return protoBase64.dec(json);
  }
  throw new Error;
}
function readEnum(type, json, ignoreUnknownFields, nullAsZeroValue) {
  if (json === null) {
    if (type.typeName == "google.protobuf.NullValue") {
      return 0;
    }
    return nullAsZeroValue ? type.values[0].no : tokenNull;
  }
  switch (typeof json) {
    case "number":
      if (Number.isInteger(json)) {
        return json;
      }
      break;
    case "string":
      const value = type.findName(json);
      if (value !== undefined) {
        return value.no;
      }
      if (ignoreUnknownFields) {
        return tokenIgnoredUnknownEnum;
      }
      break;
  }
  throw new Error("cannot decode enum ".concat(type.typeName, " from JSON: ").concat(debugJsonValue(json)));
}
function canEmitFieldDefaultValue(field) {
  if (field.repeated || field.kind == "map") {
    return true;
  }
  if (field.oneof) {
    return false;
  }
  if (field.kind == "message") {
    return false;
  }
  if (field.opt || field.req) {
    return false;
  }
  return true;
}
function writeField$1(field, value, options) {
  if (field.kind == "map") {
    assert(typeof value == "object" && value != null);
    const jsonObj = {};
    const entries = Object.entries(value);
    switch (field.V.kind) {
      case "scalar":
        for (const _ref5 of entries) {
          var _ref6 = _slicedToArray(_ref5, 2);
          const entryKey = _ref6[0];
          const entryValue = _ref6[1];
          jsonObj[entryKey.toString()] = writeScalar$1(field.V.T, entryValue);
        }
        break;
      case "message":
        for (const _ref7 of entries) {
          var _ref8 = _slicedToArray(_ref7, 2);
          const entryKey = _ref8[0];
          const entryValue = _ref8[1];
          jsonObj[entryKey.toString()] = entryValue.toJson(options);
        }
        break;
      case "enum":
        const enumType = field.V.T;
        for (const _ref9 of entries) {
          var _ref0 = _slicedToArray(_ref9, 2);
          const entryKey = _ref0[0];
          const entryValue = _ref0[1];
          jsonObj[entryKey.toString()] = writeEnum(enumType, entryValue, options.enumAsInteger);
        }
        break;
    }
    return options.emitDefaultValues || entries.length > 0 ? jsonObj : undefined;
  }
  if (field.repeated) {
    assert(Array.isArray(value));
    const jsonArr = [];
    switch (field.kind) {
      case "scalar":
        for (let i = 0;i < value.length; i++) {
          jsonArr.push(writeScalar$1(field.T, value[i]));
        }
        break;
      case "enum":
        for (let i = 0;i < value.length; i++) {
          jsonArr.push(writeEnum(field.T, value[i], options.enumAsInteger));
        }
        break;
      case "message":
        for (let i = 0;i < value.length; i++) {
          jsonArr.push(value[i].toJson(options));
        }
        break;
    }
    return options.emitDefaultValues || jsonArr.length > 0 ? jsonArr : undefined;
  }
  switch (field.kind) {
    case "scalar":
      return writeScalar$1(field.T, value);
    case "enum":
      return writeEnum(field.T, value, options.enumAsInteger);
    case "message":
      return wrapField(field.T, value).toJson(options);
  }
}
function writeEnum(type, value, enumAsInteger) {
  var _a;
  assert(typeof value == "number");
  if (type.typeName == "google.protobuf.NullValue") {
    return null;
  }
  if (enumAsInteger) {
    return value;
  }
  const val = type.findNumber(value);
  return (_a = val === null || val === undefined ? undefined : val.name) !== null && _a !== undefined ? _a : value;
}
function writeScalar$1(type, value) {
  switch (type) {
    case ScalarType.INT32:
    case ScalarType.SFIXED32:
    case ScalarType.SINT32:
    case ScalarType.FIXED32:
    case ScalarType.UINT32:
      assert(typeof value == "number");
      return value;
    case ScalarType.FLOAT:
    case ScalarType.DOUBLE:
      assert(typeof value == "number");
      if (Number.isNaN(value))
        return "NaN";
      if (value === Number.POSITIVE_INFINITY)
        return "Infinity";
      if (value === Number.NEGATIVE_INFINITY)
        return "-Infinity";
      return value;
    case ScalarType.STRING:
      assert(typeof value == "string");
      return value;
    case ScalarType.BOOL:
      assert(typeof value == "boolean");
      return value;
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
    case ScalarType.INT64:
    case ScalarType.SFIXED64:
    case ScalarType.SINT64:
      assert(typeof value == "bigint" || typeof value == "string" || typeof value == "number");
      return value.toString();
    case ScalarType.BYTES:
      assert(value instanceof Uint8Array);
      return protoBase64.enc(value);
  }
}
var unknownFieldsSymbol = Symbol("@bufbuild/protobuf/unknown-fields");
var readDefaults = {
  readUnknownFields: true,
  readerFactory: (bytes) => new BinaryReader(bytes)
};
var writeDefaults = {
  writeUnknownFields: true,
  writerFactory: () => new BinaryWriter
};
function makeReadOptions(options) {
  return options ? Object.assign(Object.assign({}, readDefaults), options) : readDefaults;
}
function makeWriteOptions(options) {
  return options ? Object.assign(Object.assign({}, writeDefaults), options) : writeDefaults;
}
function makeBinaryFormat() {
  return {
    makeReadOptions,
    makeWriteOptions,
    listUnknownFields(message) {
      var _a;
      return (_a = message[unknownFieldsSymbol]) !== null && _a !== undefined ? _a : [];
    },
    discardUnknownFields(message) {
      delete message[unknownFieldsSymbol];
    },
    writeUnknownFields(message, writer) {
      const m = message;
      const c = m[unknownFieldsSymbol];
      if (c) {
        for (const f of c) {
          writer.tag(f.no, f.wireType).raw(f.data);
        }
      }
    },
    onUnknownField(message, no, wireType, data) {
      const m = message;
      if (!Array.isArray(m[unknownFieldsSymbol])) {
        m[unknownFieldsSymbol] = [];
      }
      m[unknownFieldsSymbol].push({
        no,
        wireType,
        data
      });
    },
    readMessage(message, reader, lengthOrEndTagFieldNo, options, delimitedMessageEncoding) {
      const type = message.getType();
      const end = delimitedMessageEncoding ? reader.len : reader.pos + lengthOrEndTagFieldNo;
      let fieldNo, wireType;
      while (reader.pos < end) {
        var _reader$tag = reader.tag();
        var _reader$tag2 = _slicedToArray(_reader$tag, 2);
        fieldNo = _reader$tag2[0];
        wireType = _reader$tag2[1];
        if (delimitedMessageEncoding === true && wireType == WireType.EndGroup) {
          break;
        }
        const field = type.fields.find(fieldNo);
        if (!field) {
          const data = reader.skip(wireType, fieldNo);
          if (options.readUnknownFields) {
            this.onUnknownField(message, fieldNo, wireType, data);
          }
          continue;
        }
        readField(message, reader, field, wireType, options);
      }
      if (delimitedMessageEncoding && (wireType != WireType.EndGroup || fieldNo !== lengthOrEndTagFieldNo)) {
        throw new Error("invalid end group tag");
      }
    },
    readField,
    writeMessage(message, writer, options) {
      const type = message.getType();
      for (const field of type.fields.byNumber()) {
        if (!isFieldSet(field, message)) {
          if (field.req) {
            throw new Error("cannot encode field ".concat(type.typeName, ".").concat(field.name, " to binary: required field not set"));
          }
          continue;
        }
        const value = field.oneof ? message[field.oneof.localName].value : message[field.localName];
        writeField(field, value, writer, options);
      }
      if (options.writeUnknownFields) {
        this.writeUnknownFields(message, writer);
      }
      return writer;
    },
    writeField(field, value, writer, options) {
      if (value === undefined) {
        return;
      }
      writeField(field, value, writer, options);
    }
  };
}
function readField(target, reader, field, wireType, options) {
  let { repeated, localName } = field;
  if (field.oneof) {
    target = target[field.oneof.localName];
    if (target.case != localName) {
      delete target.value;
    }
    target.case = localName;
    localName = "value";
  }
  switch (field.kind) {
    case "scalar":
    case "enum":
      const scalarType = field.kind == "enum" ? ScalarType.INT32 : field.T;
      let read = readScalar;
      if (field.kind == "scalar" && field.L > 0) {
        read = readScalarLTString;
      }
      if (repeated) {
        let arr = target[localName];
        const isPacked = wireType == WireType.LengthDelimited && scalarType != ScalarType.STRING && scalarType != ScalarType.BYTES;
        if (isPacked) {
          let e = reader.uint32() + reader.pos;
          while (reader.pos < e) {
            arr.push(read(reader, scalarType));
          }
        } else {
          arr.push(read(reader, scalarType));
        }
      } else {
        target[localName] = read(reader, scalarType);
      }
      break;
    case "message":
      const messageType = field.T;
      if (repeated) {
        target[localName].push(readMessageField(reader, new messageType, options, field));
      } else {
        if (isMessage(target[localName])) {
          readMessageField(reader, target[localName], options, field);
        } else {
          target[localName] = readMessageField(reader, new messageType, options, field);
          if (messageType.fieldWrapper && !field.oneof && !field.repeated) {
            target[localName] = messageType.fieldWrapper.unwrapField(target[localName]);
          }
        }
      }
      break;
    case "map":
      let _readMapEntry = readMapEntry(field, reader, options), _readMapEntry2 = _slicedToArray(_readMapEntry, 2), mapKey = _readMapEntry2[0], mapVal = _readMapEntry2[1];
      target[localName][mapKey] = mapVal;
      break;
  }
}
function readMessageField(reader, message, options, field) {
  const format = message.getType().runtime.bin;
  const delimited = field === null || field === undefined ? undefined : field.delimited;
  format.readMessage(message, reader, delimited ? field.no : reader.uint32(), options, delimited);
  return message;
}
function readMapEntry(field, reader, options) {
  const length = reader.uint32(), end = reader.pos + length;
  let key, val;
  while (reader.pos < end) {
    const _reader$tag3 = reader.tag(), _reader$tag4 = _slicedToArray(_reader$tag3, 1), fieldNo = _reader$tag4[0];
    switch (fieldNo) {
      case 1:
        key = readScalar(reader, field.K);
        break;
      case 2:
        switch (field.V.kind) {
          case "scalar":
            val = readScalar(reader, field.V.T);
            break;
          case "enum":
            val = reader.int32();
            break;
          case "message":
            val = readMessageField(reader, new field.V.T, options, undefined);
            break;
        }
        break;
    }
  }
  if (key === undefined) {
    key = scalarZeroValue(field.K, LongType.BIGINT);
  }
  if (typeof key != "string" && typeof key != "number") {
    key = key.toString();
  }
  if (val === undefined) {
    switch (field.V.kind) {
      case "scalar":
        val = scalarZeroValue(field.V.T, LongType.BIGINT);
        break;
      case "enum":
        val = field.V.T.values[0].no;
        break;
      case "message":
        val = new field.V.T;
        break;
    }
  }
  return [key, val];
}
function readScalarLTString(reader, type) {
  const v = readScalar(reader, type);
  return typeof v == "bigint" ? v.toString() : v;
}
function readScalar(reader, type) {
  switch (type) {
    case ScalarType.STRING:
      return reader.string();
    case ScalarType.BOOL:
      return reader.bool();
    case ScalarType.DOUBLE:
      return reader.double();
    case ScalarType.FLOAT:
      return reader.float();
    case ScalarType.INT32:
      return reader.int32();
    case ScalarType.INT64:
      return reader.int64();
    case ScalarType.UINT64:
      return reader.uint64();
    case ScalarType.FIXED64:
      return reader.fixed64();
    case ScalarType.BYTES:
      return reader.bytes();
    case ScalarType.FIXED32:
      return reader.fixed32();
    case ScalarType.SFIXED32:
      return reader.sfixed32();
    case ScalarType.SFIXED64:
      return reader.sfixed64();
    case ScalarType.SINT64:
      return reader.sint64();
    case ScalarType.UINT32:
      return reader.uint32();
    case ScalarType.SINT32:
      return reader.sint32();
  }
}
function writeField(field, value, writer, options) {
  assert(value !== undefined);
  const repeated = field.repeated;
  switch (field.kind) {
    case "scalar":
    case "enum":
      let scalarType = field.kind == "enum" ? ScalarType.INT32 : field.T;
      if (repeated) {
        assert(Array.isArray(value));
        if (field.packed) {
          writePacked(writer, scalarType, field.no, value);
        } else {
          for (const item of value) {
            writeScalar(writer, scalarType, field.no, item);
          }
        }
      } else {
        writeScalar(writer, scalarType, field.no, value);
      }
      break;
    case "message":
      if (repeated) {
        assert(Array.isArray(value));
        for (const item of value) {
          writeMessageField(writer, options, field, item);
        }
      } else {
        writeMessageField(writer, options, field, value);
      }
      break;
    case "map":
      assert(typeof value == "object" && value != null);
      for (const _ref of Object.entries(value)) {
        var _ref2 = _slicedToArray(_ref, 2);
        const key = _ref2[0];
        const val = _ref2[1];
        writeMapEntry(writer, options, field, key, val);
      }
      break;
  }
}
function writeMapEntry(writer, options, field, key, value) {
  writer.tag(field.no, WireType.LengthDelimited);
  writer.fork();
  let keyValue = key;
  switch (field.K) {
    case ScalarType.INT32:
    case ScalarType.FIXED32:
    case ScalarType.UINT32:
    case ScalarType.SFIXED32:
    case ScalarType.SINT32:
      keyValue = Number.parseInt(key);
      break;
    case ScalarType.BOOL:
      assert(key == "true" || key == "false");
      keyValue = key == "true";
      break;
  }
  writeScalar(writer, field.K, 1, keyValue);
  switch (field.V.kind) {
    case "scalar":
      writeScalar(writer, field.V.T, 2, value);
      break;
    case "enum":
      writeScalar(writer, ScalarType.INT32, 2, value);
      break;
    case "message":
      assert(value !== undefined);
      writer.tag(2, WireType.LengthDelimited).bytes(value.toBinary(options));
      break;
  }
  writer.join();
}
function writeMessageField(writer, options, field, value) {
  const message = wrapField(field.T, value);
  if (field.delimited)
    writer.tag(field.no, WireType.StartGroup).raw(message.toBinary(options)).tag(field.no, WireType.EndGroup);
  else
    writer.tag(field.no, WireType.LengthDelimited).bytes(message.toBinary(options));
}
function writeScalar(writer, type, fieldNo, value) {
  assert(value !== undefined);
  let _scalarTypeInfo = scalarTypeInfo(type), _scalarTypeInfo2 = _slicedToArray(_scalarTypeInfo, 2), wireType = _scalarTypeInfo2[0], method = _scalarTypeInfo2[1];
  writer.tag(fieldNo, wireType)[method](value);
}
function writePacked(writer, type, fieldNo, value) {
  if (!value.length) {
    return;
  }
  writer.tag(fieldNo, WireType.LengthDelimited).fork();
  let _scalarTypeInfo3 = scalarTypeInfo(type), _scalarTypeInfo4 = _slicedToArray(_scalarTypeInfo3, 2), method = _scalarTypeInfo4[1];
  for (let i = 0;i < value.length; i++) {
    writer[method](value[i]);
  }
  writer.join();
}
function scalarTypeInfo(type) {
  let wireType = WireType.Varint;
  switch (type) {
    case ScalarType.BYTES:
    case ScalarType.STRING:
      wireType = WireType.LengthDelimited;
      break;
    case ScalarType.DOUBLE:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
      wireType = WireType.Bit64;
      break;
    case ScalarType.FIXED32:
    case ScalarType.SFIXED32:
    case ScalarType.FLOAT:
      wireType = WireType.Bit32;
      break;
  }
  const method = ScalarType[type].toLowerCase();
  return [wireType, method];
}
function makeUtilCommon() {
  return {
    setEnumType,
    initPartial(source, target) {
      if (source === undefined) {
        return;
      }
      const type = target.getType();
      for (const member of type.fields.byMember()) {
        const localName = member.localName, t = target, s = source;
        if (s[localName] == null) {
          continue;
        }
        switch (member.kind) {
          case "oneof":
            const sk = s[localName].case;
            if (sk === undefined) {
              continue;
            }
            const sourceField = member.findField(sk);
            let val = s[localName].value;
            if (sourceField && sourceField.kind == "message" && !isMessage(val, sourceField.T)) {
              val = new sourceField.T(val);
            } else if (sourceField && sourceField.kind === "scalar" && sourceField.T === ScalarType.BYTES) {
              val = toU8Arr(val);
            }
            t[localName] = {
              case: sk,
              value: val
            };
            break;
          case "scalar":
          case "enum":
            let copy = s[localName];
            if (member.T === ScalarType.BYTES) {
              copy = member.repeated ? copy.map(toU8Arr) : toU8Arr(copy);
            }
            t[localName] = copy;
            break;
          case "map":
            switch (member.V.kind) {
              case "scalar":
              case "enum":
                if (member.V.T === ScalarType.BYTES) {
                  for (const _ref of Object.entries(s[localName])) {
                    var _ref2 = _slicedToArray(_ref, 2);
                    const k = _ref2[0];
                    const v = _ref2[1];
                    t[localName][k] = toU8Arr(v);
                  }
                } else {
                  Object.assign(t[localName], s[localName]);
                }
                break;
              case "message":
                const messageType = member.V.T;
                for (const k of Object.keys(s[localName])) {
                  let val = s[localName][k];
                  if (!messageType.fieldWrapper) {
                    val = new messageType(val);
                  }
                  t[localName][k] = val;
                }
                break;
            }
            break;
          case "message":
            const mt = member.T;
            if (member.repeated) {
              t[localName] = s[localName].map((val) => isMessage(val, mt) ? val : new mt(val));
            } else {
              const val = s[localName];
              if (mt.fieldWrapper) {
                if (mt.typeName === "google.protobuf.BytesValue") {
                  t[localName] = toU8Arr(val);
                } else {
                  t[localName] = val;
                }
              } else {
                t[localName] = isMessage(val, mt) ? val : new mt(val);
              }
            }
            break;
        }
      }
    },
    equals(type, a, b) {
      if (a === b) {
        return true;
      }
      if (!a || !b) {
        return false;
      }
      return type.fields.byMember().every((m) => {
        const va = a[m.localName];
        const vb = b[m.localName];
        if (m.repeated) {
          if (va.length !== vb.length) {
            return false;
          }
          switch (m.kind) {
            case "message":
              return va.every((a, i) => m.T.equals(a, vb[i]));
            case "scalar":
              return va.every((a, i) => scalarEquals(m.T, a, vb[i]));
            case "enum":
              return va.every((a, i) => scalarEquals(ScalarType.INT32, a, vb[i]));
          }
          throw new Error("repeated cannot contain ".concat(m.kind));
        }
        switch (m.kind) {
          case "message":
            let a = va;
            let b = vb;
            if (m.T.fieldWrapper) {
              if (a !== undefined && !isMessage(a)) {
                a = m.T.fieldWrapper.wrapField(a);
              }
              if (b !== undefined && !isMessage(b)) {
                b = m.T.fieldWrapper.wrapField(b);
              }
            }
            return m.T.equals(a, b);
          case "enum":
            return scalarEquals(ScalarType.INT32, va, vb);
          case "scalar":
            return scalarEquals(m.T, va, vb);
          case "oneof":
            if (va.case !== vb.case) {
              return false;
            }
            const s = m.findField(va.case);
            if (s === undefined) {
              return true;
            }
            switch (s.kind) {
              case "message":
                return s.T.equals(va.value, vb.value);
              case "enum":
                return scalarEquals(ScalarType.INT32, va.value, vb.value);
              case "scalar":
                return scalarEquals(s.T, va.value, vb.value);
            }
            throw new Error("oneof cannot contain ".concat(s.kind));
          case "map":
            const keys = Object.keys(va).concat(Object.keys(vb));
            switch (m.V.kind) {
              case "message":
                const messageType = m.V.T;
                return keys.every((k) => messageType.equals(va[k], vb[k]));
              case "enum":
                return keys.every((k) => scalarEquals(ScalarType.INT32, va[k], vb[k]));
              case "scalar":
                const scalarType = m.V.T;
                return keys.every((k) => scalarEquals(scalarType, va[k], vb[k]));
            }
            break;
        }
      });
    },
    clone(message) {
      const type = message.getType(), target = new type, any = target;
      for (const member of type.fields.byMember()) {
        const source = message[member.localName];
        let copy;
        if (member.repeated) {
          copy = source.map(cloneSingularField);
        } else if (member.kind == "map") {
          copy = any[member.localName];
          for (const _ref3 of Object.entries(source)) {
            var _ref4 = _slicedToArray(_ref3, 2);
            const key = _ref4[0];
            const v = _ref4[1];
            copy[key] = cloneSingularField(v);
          }
        } else if (member.kind == "oneof") {
          const f = member.findField(source.case);
          copy = f ? {
            case: source.case,
            value: cloneSingularField(source.value)
          } : {
            case: undefined
          };
        } else {
          copy = cloneSingularField(source);
        }
        any[member.localName] = copy;
      }
      for (const uf of type.runtime.bin.listUnknownFields(message)) {
        type.runtime.bin.onUnknownField(any, uf.no, uf.wireType, uf.data);
      }
      return target;
    }
  };
}
function cloneSingularField(value) {
  if (value === undefined) {
    return value;
  }
  if (isMessage(value)) {
    return value.clone();
  }
  if (value instanceof Uint8Array) {
    const c = new Uint8Array(value.byteLength);
    c.set(value);
    return c;
  }
  return value;
}
function toU8Arr(input) {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}
function makeProtoRuntime(syntax, newFieldList, initFields) {
  return {
    syntax,
    json: makeJsonFormat(),
    bin: makeBinaryFormat(),
    util: Object.assign(Object.assign({}, makeUtilCommon()), {
      newFieldList,
      initFields
    }),
    makeMessageType(typeName, fields, opt) {
      return makeMessageType(this, typeName, fields, opt);
    },
    makeEnum,
    makeEnumType,
    getEnumType,
    makeExtension(typeName, extendee, field) {
      return makeExtension(this, typeName, extendee, field);
    }
  };
}

class InternalFieldList {
  constructor(fields, normalizer) {
    this._fields = fields;
    this._normalizer = normalizer;
  }
  findJsonName(jsonName) {
    if (!this.jsonNames) {
      const t = {};
      for (const f of this.list()) {
        t[f.jsonName] = t[f.name] = f;
      }
      this.jsonNames = t;
    }
    return this.jsonNames[jsonName];
  }
  find(fieldNo) {
    if (!this.numbers) {
      const t = {};
      for (const f of this.list()) {
        t[f.no] = f;
      }
      this.numbers = t;
    }
    return this.numbers[fieldNo];
  }
  list() {
    if (!this.all) {
      this.all = this._normalizer(this._fields);
    }
    return this.all;
  }
  byNumber() {
    if (!this.numbersAsc) {
      this.numbersAsc = this.list().concat().sort((a, b) => a.no - b.no);
    }
    return this.numbersAsc;
  }
  byMember() {
    if (!this.members) {
      this.members = [];
      const a = this.members;
      let o;
      for (const f of this.list()) {
        if (f.oneof) {
          if (f.oneof !== o) {
            o = f.oneof;
            a.push(o);
          }
        } else {
          a.push(f);
        }
      }
    }
    return this.members;
  }
}
function localFieldName(protoName, inOneof) {
  const name = protoCamelCase(protoName);
  if (inOneof) {
    return name;
  }
  return safeObjectProperty(safeMessageProperty(name));
}
function localOneofName(protoName) {
  return localFieldName(protoName, false);
}
var fieldJsonName = protoCamelCase;
function protoCamelCase(snakeCase) {
  let capNext = false;
  const b = [];
  for (let i = 0;i < snakeCase.length; i++) {
    let c = snakeCase.charAt(i);
    switch (c) {
      case "_":
        capNext = true;
        break;
      case "0":
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7":
      case "8":
      case "9":
        b.push(c);
        capNext = false;
        break;
      default:
        if (capNext) {
          capNext = false;
          c = c.toUpperCase();
        }
        b.push(c);
        break;
    }
  }
  return b.join("");
}
var reservedObjectProperties = new Set([
  "constructor",
  "toString",
  "toJSON",
  "valueOf"
]);
var reservedMessageProperties = new Set([
  "getType",
  "clone",
  "equals",
  "fromBinary",
  "fromJson",
  "fromJsonString",
  "toBinary",
  "toJson",
  "toJsonString",
  "toObject"
]);
var fallback = (name) => "".concat(name, "$");
var safeMessageProperty = (name) => {
  if (reservedMessageProperties.has(name)) {
    return fallback(name);
  }
  return name;
};
var safeObjectProperty = (name) => {
  if (reservedObjectProperties.has(name)) {
    return fallback(name);
  }
  return name;
};

class InternalOneofInfo {
  constructor(name) {
    this.kind = "oneof";
    this.repeated = false;
    this.packed = false;
    this.opt = false;
    this.req = false;
    this.default = undefined;
    this.fields = [];
    this.name = name;
    this.localName = localOneofName(name);
  }
  addField(field) {
    assert(field.oneof === this, "field ".concat(field.name, " not one of ").concat(this.name));
    this.fields.push(field);
  }
  findField(localName) {
    if (!this._lookup) {
      this._lookup = Object.create(null);
      for (let i = 0;i < this.fields.length; i++) {
        this._lookup[this.fields[i].localName] = this.fields[i];
      }
    }
    return this._lookup[localName];
  }
}
function normalizeFieldInfos(fieldInfos, packedByDefault) {
  var _a, _b, _c, _d, _e, _f;
  const r = [];
  let o;
  for (const field of typeof fieldInfos == "function" ? fieldInfos() : fieldInfos) {
    const f = field;
    f.localName = localFieldName(field.name, field.oneof !== undefined);
    f.jsonName = (_a = field.jsonName) !== null && _a !== undefined ? _a : fieldJsonName(field.name);
    f.repeated = (_b = field.repeated) !== null && _b !== undefined ? _b : false;
    if (field.kind == "scalar") {
      f.L = (_c = field.L) !== null && _c !== undefined ? _c : LongType.BIGINT;
    }
    f.delimited = (_d = field.delimited) !== null && _d !== undefined ? _d : false;
    f.req = (_e = field.req) !== null && _e !== undefined ? _e : false;
    f.opt = (_f = field.opt) !== null && _f !== undefined ? _f : false;
    if (field.packed === undefined) {
      {
        f.packed = field.kind == "enum" || field.kind == "scalar" && field.T != ScalarType.BYTES && field.T != ScalarType.STRING;
      }
    }
    if (field.oneof !== undefined) {
      const ooname = typeof field.oneof == "string" ? field.oneof : field.oneof.name;
      if (!o || o.name != ooname) {
        o = new InternalOneofInfo(ooname);
      }
      f.oneof = o;
      o.addField(f);
    }
    r.push(f);
  }
  return r;
}
var proto3 = makeProtoRuntime("proto3", (fields) => {
  return new InternalFieldList(fields, (source) => normalizeFieldInfos(source));
}, (target) => {
  for (const member of target.getType().fields.byMember()) {
    if (member.opt) {
      continue;
    }
    const name = member.localName, t = target;
    if (member.repeated) {
      t[name] = [];
      continue;
    }
    switch (member.kind) {
      case "oneof":
        t[name] = {
          case: undefined
        };
        break;
      case "enum":
        t[name] = 0;
        break;
      case "map":
        t[name] = {};
        break;
      case "scalar":
        t[name] = scalarZeroValue(member.T, member.L);
        break;
    }
  }
});
var TrackType = /* @__PURE__ */ proto3.makeEnum("livekit.TrackType", [{
  no: 0,
  name: "AUDIO"
}, {
  no: 1,
  name: "VIDEO"
}, {
  no: 2,
  name: "DATA"
}]);
var TrackSource = /* @__PURE__ */ proto3.makeEnum("livekit.TrackSource", [{
  no: 0,
  name: "UNKNOWN"
}, {
  no: 1,
  name: "CAMERA"
}, {
  no: 2,
  name: "MICROPHONE"
}, {
  no: 3,
  name: "SCREEN_SHARE"
}, {
  no: 4,
  name: "SCREEN_SHARE_AUDIO"
}]);
var StreamState = /* @__PURE__ */ proto3.makeEnum("livekit.StreamState", [{
  no: 0,
  name: "ACTIVE"
}, {
  no: 1,
  name: "PAUSED"
}]);

class LivekitError extends Error {
  constructor(code, message, options) {
    super(message || "an error has occurred");
    this.name = "LiveKitError";
    this.code = code;
    if (typeof (options === null || options === undefined ? undefined : options.cause) !== "undefined") {
      this.cause = options === null || options === undefined ? undefined : options.cause;
    }
  }
}
var ConnectionErrorReason;
(function(ConnectionErrorReason) {
  ConnectionErrorReason[ConnectionErrorReason["NotAllowed"] = 0] = "NotAllowed";
  ConnectionErrorReason[ConnectionErrorReason["ServerUnreachable"] = 1] = "ServerUnreachable";
  ConnectionErrorReason[ConnectionErrorReason["InternalError"] = 2] = "InternalError";
  ConnectionErrorReason[ConnectionErrorReason["Cancelled"] = 3] = "Cancelled";
  ConnectionErrorReason[ConnectionErrorReason["LeaveRequest"] = 4] = "LeaveRequest";
  ConnectionErrorReason[ConnectionErrorReason["Timeout"] = 5] = "Timeout";
  ConnectionErrorReason[ConnectionErrorReason["WebSocket"] = 6] = "WebSocket";
  ConnectionErrorReason[ConnectionErrorReason["ServiceNotFound"] = 7] = "ServiceNotFound";
})(ConnectionErrorReason || (ConnectionErrorReason = {}));
var DataStreamErrorReason;
(function(DataStreamErrorReason) {
  DataStreamErrorReason[DataStreamErrorReason["AlreadyOpened"] = 0] = "AlreadyOpened";
  DataStreamErrorReason[DataStreamErrorReason["AbnormalEnd"] = 1] = "AbnormalEnd";
  DataStreamErrorReason[DataStreamErrorReason["DecodeFailed"] = 2] = "DecodeFailed";
  DataStreamErrorReason[DataStreamErrorReason["LengthExceeded"] = 3] = "LengthExceeded";
  DataStreamErrorReason[DataStreamErrorReason["Incomplete"] = 4] = "Incomplete";
  DataStreamErrorReason[DataStreamErrorReason["HandlerAlreadyRegistered"] = 7] = "HandlerAlreadyRegistered";
  DataStreamErrorReason[DataStreamErrorReason["EncryptionTypeMismatch"] = 8] = "EncryptionTypeMismatch";
  DataStreamErrorReason[DataStreamErrorReason["HeaderTooLarge"] = 9] = "HeaderTooLarge";
  DataStreamErrorReason[DataStreamErrorReason["PayloadTooLarge"] = 10] = "PayloadTooLarge";
})(DataStreamErrorReason || (DataStreamErrorReason = {}));
var MediaDeviceFailure;
(function(MediaDeviceFailure) {
  MediaDeviceFailure["PermissionDenied"] = "PermissionDenied";
  MediaDeviceFailure["NotFound"] = "NotFound";
  MediaDeviceFailure["DeviceInUse"] = "DeviceInUse";
  MediaDeviceFailure["Other"] = "Other";
})(MediaDeviceFailure || (MediaDeviceFailure = {}));
(function(MediaDeviceFailure) {
  function getFailure(error) {
    if (error && "name" in error) {
      if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
        return MediaDeviceFailure.NotFound;
      }
      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        return MediaDeviceFailure.PermissionDenied;
      }
      if (error.name === "NotReadableError" || error.name === "TrackStartError") {
        return MediaDeviceFailure.DeviceInUse;
      }
      return MediaDeviceFailure.Other;
    }
  }
  MediaDeviceFailure.getFailure = getFailure;
})(MediaDeviceFailure || (MediaDeviceFailure = {}));
var CryptorErrorReason;
(function(CryptorErrorReason) {
  CryptorErrorReason[CryptorErrorReason["InvalidKey"] = 0] = "InvalidKey";
  CryptorErrorReason[CryptorErrorReason["MissingKey"] = 1] = "MissingKey";
  CryptorErrorReason[CryptorErrorReason["InternalError"] = 2] = "InternalError";
})(CryptorErrorReason || (CryptorErrorReason = {}));

class CryptorError extends LivekitError {
  constructor(message) {
    let reason = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : CryptorErrorReason.InternalError;
    let participantIdentity = arguments.length > 2 ? arguments[2] : undefined;
    super(40, message);
    this.reason = reason;
    this.participantIdentity = participantIdentity;
  }
}
var KeyProviderEvent;
(function(KeyProviderEvent) {
  KeyProviderEvent["SetKey"] = "setKey";
  KeyProviderEvent["RatchetRequest"] = "ratchetRequest";
  KeyProviderEvent["KeyRatcheted"] = "keyRatcheted";
})(KeyProviderEvent || (KeyProviderEvent = {}));
var KeyHandlerEvent;
(function(KeyHandlerEvent) {
  KeyHandlerEvent["KeyRatcheted"] = "keyRatcheted";
})(KeyHandlerEvent || (KeyHandlerEvent = {}));
var EncryptionEvent;
(function(EncryptionEvent) {
  EncryptionEvent["ParticipantEncryptionStatusChanged"] = "participantEncryptionStatusChanged";
  EncryptionEvent["EncryptionError"] = "encryptionError";
})(EncryptionEvent || (EncryptionEvent = {}));
var CryptorEvent;
(function(CryptorEvent) {
  CryptorEvent["Error"] = "cryptorError";
})(CryptorEvent || (CryptorEvent = {}));
var _a;
var _b;

class TypedPromise extends (_b = Promise) {
  constructor(executor) {
    super(executor);
  }
  catch(onrejected) {
    return super.catch(onrejected);
  }
  static reject(reason) {
    return super.reject(reason);
  }
  static all(values) {
    return super.all(values);
  }
  static race(values) {
    return super.race(values);
  }
}
_a = TypedPromise;
TypedPromise.resolve = (value) => {
  return Reflect.get(_b, "resolve", _a).call(_a, value);
};
var commonVersionIdentifier = /version\/(\d+(\.?_?\d+)+)/i;
var browserDetails;
function getBrowser(userAgent) {
  let force = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : true;
  if (typeof navigator === "undefined") {
    return;
  }
  const ua = navigator.userAgent.toLowerCase();
  if (browserDetails === undefined || force) {
    const browser = browsersList.find((_ref) => {
      let test = _ref.test;
      return test.test(ua);
    });
    browserDetails = browser === null || browser === undefined ? undefined : browser.describe(ua);
  }
  return browserDetails;
}
var browsersList = [
  {
    test: /firefox|iceweasel|fxios/i,
    describe(ua) {
      const browser = {
        name: "Firefox",
        version: getMatch(/(?:firefox|iceweasel|fxios)[\s/](\d+(\.?_?\d+)+)/i, ua),
        os: ua.toLowerCase().includes("fxios") ? "iOS" : undefined,
        osVersion: getOSVersion(ua)
      };
      return browser;
    }
  },
  {
    test: /chrom|crios|crmo/i,
    describe(ua) {
      const browser = {
        name: "Chrome",
        version: getMatch(/(?:chrome|chromium|crios|crmo)\/(\d+(\.?_?\d+)+)/i, ua),
        os: ua.toLowerCase().includes("crios") ? "iOS" : undefined,
        osVersion: getOSVersion(ua)
      };
      return browser;
    }
  },
  {
    test: /safari|applewebkit/i,
    describe(ua) {
      const browser = {
        name: "Safari",
        version: getMatch(commonVersionIdentifier, ua),
        os: ua.includes("mobile/") ? "iOS" : "macOS",
        osVersion: getOSVersion(ua)
      };
      return browser;
    }
  }
];
function getMatch(exp, ua) {
  let id = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : 1;
  const match = ua.match(exp);
  return match && match.length >= id && match[id] || "";
}
function getOSVersion(ua) {
  return ua.includes("mac os") ? getMatch(/\(.+?(\d+_\d+(:?_\d+)?)/, ua, 1).replace(/_/g, ".") : undefined;
}
var events = { exports: {} };
var hasRequiredEvents;
function requireEvents() {
  if (hasRequiredEvents)
    return events.exports;
  hasRequiredEvents = 1;
  var R = typeof Reflect === "object" ? Reflect : null;
  var ReflectApply = R && typeof R.apply === "function" ? R.apply : function ReflectApply(target, receiver, args) {
    return Function.prototype.apply.call(target, receiver, args);
  };
  var ReflectOwnKeys;
  if (R && typeof R.ownKeys === "function") {
    ReflectOwnKeys = R.ownKeys;
  } else if (Object.getOwnPropertySymbols) {
    ReflectOwnKeys = function ReflectOwnKeys(target) {
      return Object.getOwnPropertyNames(target).concat(Object.getOwnPropertySymbols(target));
    };
  } else {
    ReflectOwnKeys = function ReflectOwnKeys(target) {
      return Object.getOwnPropertyNames(target);
    };
  }
  function ProcessEmitWarning(warning) {
    if (console && console.warn)
      console.warn(warning);
  }
  var NumberIsNaN = Number.isNaN || function NumberIsNaN(value) {
    return value !== value;
  };
  function EventEmitter() {
    EventEmitter.init.call(this);
  }
  events.exports = EventEmitter;
  events.exports.once = once;
  EventEmitter.EventEmitter = EventEmitter;
  EventEmitter.prototype._events = undefined;
  EventEmitter.prototype._eventsCount = 0;
  EventEmitter.prototype._maxListeners = undefined;
  var defaultMaxListeners = 10;
  function checkListener(listener) {
    if (typeof listener !== "function") {
      throw new TypeError('The "listener" argument must be of type Function. Received type ' + typeof listener);
    }
  }
  Object.defineProperty(EventEmitter, "defaultMaxListeners", {
    enumerable: true,
    get: function() {
      return defaultMaxListeners;
    },
    set: function(arg) {
      if (typeof arg !== "number" || arg < 0 || NumberIsNaN(arg)) {
        throw new RangeError('The value of "defaultMaxListeners" is out of range. It must be a non-negative number. Received ' + arg + ".");
      }
      defaultMaxListeners = arg;
    }
  });
  EventEmitter.init = function() {
    if (this._events === undefined || this._events === Object.getPrototypeOf(this)._events) {
      this._events = Object.create(null);
      this._eventsCount = 0;
    }
    this._maxListeners = this._maxListeners || undefined;
  };
  EventEmitter.prototype.setMaxListeners = function setMaxListeners(n) {
    if (typeof n !== "number" || n < 0 || NumberIsNaN(n)) {
      throw new RangeError('The value of "n" is out of range. It must be a non-negative number. Received ' + n + ".");
    }
    this._maxListeners = n;
    return this;
  };
  function _getMaxListeners(that) {
    if (that._maxListeners === undefined)
      return EventEmitter.defaultMaxListeners;
    return that._maxListeners;
  }
  EventEmitter.prototype.getMaxListeners = function getMaxListeners() {
    return _getMaxListeners(this);
  };
  EventEmitter.prototype.emit = function emit(type) {
    var args = [];
    for (var i = 1;i < arguments.length; i++)
      args.push(arguments[i]);
    var doError = type === "error";
    var events = this._events;
    if (events !== undefined)
      doError = doError && events.error === undefined;
    else if (!doError)
      return false;
    if (doError) {
      var er;
      if (args.length > 0)
        er = args[0];
      if (er instanceof Error) {
        throw er;
      }
      var err = new Error("Unhandled error." + (er ? " (" + er.message + ")" : ""));
      err.context = er;
      throw err;
    }
    var handler = events[type];
    if (handler === undefined)
      return false;
    if (typeof handler === "function") {
      ReflectApply(handler, this, args);
    } else {
      var len = handler.length;
      var listeners = arrayClone(handler, len);
      for (var i = 0;i < len; ++i)
        ReflectApply(listeners[i], this, args);
    }
    return true;
  };
  function _addListener(target, type, listener, prepend) {
    var m;
    var events;
    var existing;
    checkListener(listener);
    events = target._events;
    if (events === undefined) {
      events = target._events = Object.create(null);
      target._eventsCount = 0;
    } else {
      if (events.newListener !== undefined) {
        target.emit("newListener", type, listener.listener ? listener.listener : listener);
        events = target._events;
      }
      existing = events[type];
    }
    if (existing === undefined) {
      existing = events[type] = listener;
      ++target._eventsCount;
    } else {
      if (typeof existing === "function") {
        existing = events[type] = prepend ? [listener, existing] : [existing, listener];
      } else if (prepend) {
        existing.unshift(listener);
      } else {
        existing.push(listener);
      }
      m = _getMaxListeners(target);
      if (m > 0 && existing.length > m && !existing.warned) {
        existing.warned = true;
        var w = new Error("Possible EventEmitter memory leak detected. " + existing.length + " " + String(type) + " listeners " + "added. Use emitter.setMaxListeners() to " + "increase limit");
        w.name = "MaxListenersExceededWarning";
        w.emitter = target;
        w.type = type;
        w.count = existing.length;
        ProcessEmitWarning(w);
      }
    }
    return target;
  }
  EventEmitter.prototype.addListener = function addListener(type, listener) {
    return _addListener(this, type, listener, false);
  };
  EventEmitter.prototype.on = EventEmitter.prototype.addListener;
  EventEmitter.prototype.prependListener = function prependListener(type, listener) {
    return _addListener(this, type, listener, true);
  };
  function onceWrapper() {
    if (!this.fired) {
      this.target.removeListener(this.type, this.wrapFn);
      this.fired = true;
      if (arguments.length === 0)
        return this.listener.call(this.target);
      return this.listener.apply(this.target, arguments);
    }
  }
  function _onceWrap(target, type, listener) {
    var state = {
      fired: false,
      wrapFn: undefined,
      target,
      type,
      listener
    };
    var wrapped = onceWrapper.bind(state);
    wrapped.listener = listener;
    state.wrapFn = wrapped;
    return wrapped;
  }
  EventEmitter.prototype.once = function once(type, listener) {
    checkListener(listener);
    this.on(type, _onceWrap(this, type, listener));
    return this;
  };
  EventEmitter.prototype.prependOnceListener = function prependOnceListener(type, listener) {
    checkListener(listener);
    this.prependListener(type, _onceWrap(this, type, listener));
    return this;
  };
  EventEmitter.prototype.removeListener = function removeListener(type, listener) {
    var list, events, position, i, originalListener;
    checkListener(listener);
    events = this._events;
    if (events === undefined)
      return this;
    list = events[type];
    if (list === undefined)
      return this;
    if (list === listener || list.listener === listener) {
      if (--this._eventsCount === 0)
        this._events = Object.create(null);
      else {
        delete events[type];
        if (events.removeListener)
          this.emit("removeListener", type, list.listener || listener);
      }
    } else if (typeof list !== "function") {
      position = -1;
      for (i = list.length - 1;i >= 0; i--) {
        if (list[i] === listener || list[i].listener === listener) {
          originalListener = list[i].listener;
          position = i;
          break;
        }
      }
      if (position < 0)
        return this;
      if (position === 0)
        list.shift();
      else {
        spliceOne(list, position);
      }
      if (list.length === 1)
        events[type] = list[0];
      if (events.removeListener !== undefined)
        this.emit("removeListener", type, originalListener || listener);
    }
    return this;
  };
  EventEmitter.prototype.off = EventEmitter.prototype.removeListener;
  EventEmitter.prototype.removeAllListeners = function removeAllListeners(type) {
    var listeners, events, i;
    events = this._events;
    if (events === undefined)
      return this;
    if (events.removeListener === undefined) {
      if (arguments.length === 0) {
        this._events = Object.create(null);
        this._eventsCount = 0;
      } else if (events[type] !== undefined) {
        if (--this._eventsCount === 0)
          this._events = Object.create(null);
        else
          delete events[type];
      }
      return this;
    }
    if (arguments.length === 0) {
      var keys = Object.keys(events);
      var key;
      for (i = 0;i < keys.length; ++i) {
        key = keys[i];
        if (key === "removeListener")
          continue;
        this.removeAllListeners(key);
      }
      this.removeAllListeners("removeListener");
      this._events = Object.create(null);
      this._eventsCount = 0;
      return this;
    }
    listeners = events[type];
    if (typeof listeners === "function") {
      this.removeListener(type, listeners);
    } else if (listeners !== undefined) {
      for (i = listeners.length - 1;i >= 0; i--) {
        this.removeListener(type, listeners[i]);
      }
    }
    return this;
  };
  function _listeners(target, type, unwrap) {
    var events = target._events;
    if (events === undefined)
      return [];
    var evlistener = events[type];
    if (evlistener === undefined)
      return [];
    if (typeof evlistener === "function")
      return unwrap ? [evlistener.listener || evlistener] : [evlistener];
    return unwrap ? unwrapListeners(evlistener) : arrayClone(evlistener, evlistener.length);
  }
  EventEmitter.prototype.listeners = function listeners(type) {
    return _listeners(this, type, true);
  };
  EventEmitter.prototype.rawListeners = function rawListeners(type) {
    return _listeners(this, type, false);
  };
  EventEmitter.listenerCount = function(emitter, type) {
    if (typeof emitter.listenerCount === "function") {
      return emitter.listenerCount(type);
    } else {
      return listenerCount.call(emitter, type);
    }
  };
  EventEmitter.prototype.listenerCount = listenerCount;
  function listenerCount(type) {
    var events = this._events;
    if (events !== undefined) {
      var evlistener = events[type];
      if (typeof evlistener === "function") {
        return 1;
      } else if (evlistener !== undefined) {
        return evlistener.length;
      }
    }
    return 0;
  }
  EventEmitter.prototype.eventNames = function eventNames() {
    return this._eventsCount > 0 ? ReflectOwnKeys(this._events) : [];
  };
  function arrayClone(arr, n) {
    var copy = new Array(n);
    for (var i = 0;i < n; ++i)
      copy[i] = arr[i];
    return copy;
  }
  function spliceOne(list, index) {
    for (;index + 1 < list.length; index++)
      list[index] = list[index + 1];
    list.pop();
  }
  function unwrapListeners(arr) {
    var ret = new Array(arr.length);
    for (var i = 0;i < ret.length; ++i) {
      ret[i] = arr[i].listener || arr[i];
    }
    return ret;
  }
  function once(emitter, name) {
    return new Promise(function(resolve, reject) {
      function errorListener(err) {
        emitter.removeListener(name, resolver);
        reject(err);
      }
      function resolver() {
        if (typeof emitter.removeListener === "function") {
          emitter.removeListener("error", errorListener);
        }
        resolve([].slice.call(arguments));
      }
      eventTargetAgnosticAddListener(emitter, name, resolver, {
        once: true
      });
      if (name !== "error") {
        addErrorHandlerIfEventEmitter(emitter, errorListener, {
          once: true
        });
      }
    });
  }
  function addErrorHandlerIfEventEmitter(emitter, handler, flags) {
    if (typeof emitter.on === "function") {
      eventTargetAgnosticAddListener(emitter, "error", handler, flags);
    }
  }
  function eventTargetAgnosticAddListener(emitter, name, listener, flags) {
    if (typeof emitter.on === "function") {
      if (flags.once) {
        emitter.once(name, listener);
      } else {
        emitter.on(name, listener);
      }
    } else if (typeof emitter.addEventListener === "function") {
      emitter.addEventListener(name, function wrapListener(arg) {
        if (flags.once) {
          emitter.removeEventListener(name, wrapListener);
        }
        listener(arg);
      });
    } else {
      throw new TypeError('The "emitter" argument must be of type EventEmitter. Received type ' + typeof emitter);
    }
  }
  return events.exports;
}
var eventsExports = requireEvents();
var RoomEvent;
(function(RoomEvent) {
  RoomEvent["Connected"] = "connected";
  RoomEvent["Reconnecting"] = "reconnecting";
  RoomEvent["SignalReconnecting"] = "signalReconnecting";
  RoomEvent["Reconnected"] = "reconnected";
  RoomEvent["Disconnected"] = "disconnected";
  RoomEvent["ConnectionStateChanged"] = "connectionStateChanged";
  RoomEvent["Moved"] = "moved";
  RoomEvent["MediaDevicesChanged"] = "mediaDevicesChanged";
  RoomEvent["ParticipantConnected"] = "participantConnected";
  RoomEvent["ParticipantDisconnected"] = "participantDisconnected";
  RoomEvent["TrackPublished"] = "trackPublished";
  RoomEvent["TrackSubscribed"] = "trackSubscribed";
  RoomEvent["TrackSubscriptionFailed"] = "trackSubscriptionFailed";
  RoomEvent["TrackUnpublished"] = "trackUnpublished";
  RoomEvent["TrackUnsubscribed"] = "trackUnsubscribed";
  RoomEvent["TrackMuted"] = "trackMuted";
  RoomEvent["TrackUnmuted"] = "trackUnmuted";
  RoomEvent["LocalTrackPublished"] = "localTrackPublished";
  RoomEvent["LocalTrackUnpublished"] = "localTrackUnpublished";
  RoomEvent["LocalAudioSilenceDetected"] = "localAudioSilenceDetected";
  RoomEvent["ActiveSpeakersChanged"] = "activeSpeakersChanged";
  RoomEvent["ParticipantMetadataChanged"] = "participantMetadataChanged";
  RoomEvent["ParticipantNameChanged"] = "participantNameChanged";
  RoomEvent["ParticipantAttributesChanged"] = "participantAttributesChanged";
  RoomEvent["ParticipantActive"] = "participantActive";
  RoomEvent["RoomMetadataChanged"] = "roomMetadataChanged";
  RoomEvent["DataReceived"] = "dataReceived";
  RoomEvent["SipDTMFReceived"] = "sipDTMFReceived";
  RoomEvent["TranscriptionReceived"] = "transcriptionReceived";
  RoomEvent["ConnectionQualityChanged"] = "connectionQualityChanged";
  RoomEvent["TrackStreamStateChanged"] = "trackStreamStateChanged";
  RoomEvent["TrackSubscriptionPermissionChanged"] = "trackSubscriptionPermissionChanged";
  RoomEvent["TrackSubscriptionStatusChanged"] = "trackSubscriptionStatusChanged";
  RoomEvent["AudioPlaybackStatusChanged"] = "audioPlaybackChanged";
  RoomEvent["VideoPlaybackStatusChanged"] = "videoPlaybackChanged";
  RoomEvent["MediaDevicesError"] = "mediaDevicesError";
  RoomEvent["ParticipantPermissionsChanged"] = "participantPermissionsChanged";
  RoomEvent["SignalConnected"] = "signalConnected";
  RoomEvent["RecordingStatusChanged"] = "recordingStatusChanged";
  RoomEvent["ParticipantEncryptionStatusChanged"] = "participantEncryptionStatusChanged";
  RoomEvent["EncryptionError"] = "encryptionError";
  RoomEvent["DCBufferStatusChanged"] = "dcBufferStatusChanged";
  RoomEvent["ActiveDeviceChanged"] = "activeDeviceChanged";
  RoomEvent["ChatMessage"] = "chatMessage";
  RoomEvent["LocalTrackSubscribed"] = "localTrackSubscribed";
  RoomEvent["MetricsReceived"] = "metricsReceived";
  RoomEvent["DataTrackPublished"] = "dataTrackPublished";
  RoomEvent["DataTrackUnpublished"] = "dataTrackUnpublished";
  RoomEvent["LocalDataTrackPublished"] = "localDataTrackPublished";
  RoomEvent["LocalDataTrackUnpublished"] = "localDataTrackUnpublished";
})(RoomEvent || (RoomEvent = {}));
var ParticipantEvent;
(function(ParticipantEvent) {
  ParticipantEvent["TrackPublished"] = "trackPublished";
  ParticipantEvent["TrackSubscribed"] = "trackSubscribed";
  ParticipantEvent["TrackSubscriptionFailed"] = "trackSubscriptionFailed";
  ParticipantEvent["TrackUnpublished"] = "trackUnpublished";
  ParticipantEvent["TrackUnsubscribed"] = "trackUnsubscribed";
  ParticipantEvent["TrackMuted"] = "trackMuted";
  ParticipantEvent["TrackUnmuted"] = "trackUnmuted";
  ParticipantEvent["LocalTrackPublished"] = "localTrackPublished";
  ParticipantEvent["LocalTrackUnpublished"] = "localTrackUnpublished";
  ParticipantEvent["LocalTrackCpuConstrained"] = "localTrackCpuConstrained";
  ParticipantEvent["LocalSenderCreated"] = "localSenderCreated";
  ParticipantEvent["ParticipantMetadataChanged"] = "participantMetadataChanged";
  ParticipantEvent["ParticipantNameChanged"] = "participantNameChanged";
  ParticipantEvent["DataReceived"] = "dataReceived";
  ParticipantEvent["SipDTMFReceived"] = "sipDTMFReceived";
  ParticipantEvent["TranscriptionReceived"] = "transcriptionReceived";
  ParticipantEvent["IsSpeakingChanged"] = "isSpeakingChanged";
  ParticipantEvent["ConnectionQualityChanged"] = "connectionQualityChanged";
  ParticipantEvent["TrackStreamStateChanged"] = "trackStreamStateChanged";
  ParticipantEvent["TrackSubscriptionPermissionChanged"] = "trackSubscriptionPermissionChanged";
  ParticipantEvent["TrackSubscriptionStatusChanged"] = "trackSubscriptionStatusChanged";
  ParticipantEvent["TrackCpuConstrained"] = "trackCpuConstrained";
  ParticipantEvent["MediaDevicesError"] = "mediaDevicesError";
  ParticipantEvent["AudioStreamAcquired"] = "audioStreamAcquired";
  ParticipantEvent["ParticipantPermissionsChanged"] = "participantPermissionsChanged";
  ParticipantEvent["PCTrackAdded"] = "pcTrackAdded";
  ParticipantEvent["AttributesChanged"] = "attributesChanged";
  ParticipantEvent["LocalTrackSubscribed"] = "localTrackSubscribed";
  ParticipantEvent["ChatMessage"] = "chatMessage";
  ParticipantEvent["Active"] = "active";
})(ParticipantEvent || (ParticipantEvent = {}));
var EngineEvent;
(function(EngineEvent) {
  EngineEvent["TransportsCreated"] = "transportsCreated";
  EngineEvent["Connected"] = "connected";
  EngineEvent["Disconnected"] = "disconnected";
  EngineEvent["Resuming"] = "resuming";
  EngineEvent["Resumed"] = "resumed";
  EngineEvent["Restarting"] = "restarting";
  EngineEvent["Restarted"] = "restarted";
  EngineEvent["SignalResumed"] = "signalResumed";
  EngineEvent["SignalRestarted"] = "signalRestarted";
  EngineEvent["Closing"] = "closing";
  EngineEvent["MediaTrackAdded"] = "mediaTrackAdded";
  EngineEvent["ActiveSpeakersUpdate"] = "activeSpeakersUpdate";
  EngineEvent["DataPacketReceived"] = "dataPacketReceived";
  EngineEvent["RTPVideoMapUpdate"] = "rtpVideoMapUpdate";
  EngineEvent["DCBufferStatusChanged"] = "dcBufferStatusChanged";
  EngineEvent["ParticipantUpdate"] = "participantUpdate";
  EngineEvent["RoomUpdate"] = "roomUpdate";
  EngineEvent["SpeakersChanged"] = "speakersChanged";
  EngineEvent["StreamStateChanged"] = "streamStateChanged";
  EngineEvent["ConnectionQualityUpdate"] = "connectionQualityUpdate";
  EngineEvent["SubscriptionError"] = "subscriptionError";
  EngineEvent["SubscriptionPermissionUpdate"] = "subscriptionPermissionUpdate";
  EngineEvent["RemoteMute"] = "remoteMute";
  EngineEvent["SubscribedQualityUpdate"] = "subscribedQualityUpdate";
  EngineEvent["LocalTrackUnpublished"] = "localTrackUnpublished";
  EngineEvent["LocalTrackSubscribed"] = "localTrackSubscribed";
  EngineEvent["Offline"] = "offline";
  EngineEvent["SignalRequestResponse"] = "signalRequestResponse";
  EngineEvent["SignalConnected"] = "signalConnected";
  EngineEvent["RoomMoved"] = "roomMoved";
  EngineEvent["PublishDataTrackResponse"] = "publishDataTrackResponse";
  EngineEvent["UnPublishDataTrackResponse"] = "unPublishDataTrackResponse";
  EngineEvent["DataTrackSubscriberHandles"] = "dataTrackSubscriberHandles";
  EngineEvent["DataTrackPacketReceived"] = "dataTrackPacketReceived";
  EngineEvent["Joined"] = "joined";
  EngineEvent["TokenRefreshed"] = "tokenRefreshed";
  EngineEvent["ServerRegionsReported"] = "serverRegionsReported";
  EngineEvent["RequestSubscribedCodecRefresh"] = "requestSubscribedCodecRefresh";
})(EngineEvent || (EngineEvent = {}));
var TrackEvent;
(function(TrackEvent) {
  TrackEvent["Message"] = "message";
  TrackEvent["Muted"] = "muted";
  TrackEvent["Unmuted"] = "unmuted";
  TrackEvent["Restarted"] = "restarted";
  TrackEvent["Ended"] = "ended";
  TrackEvent["Subscribed"] = "subscribed";
  TrackEvent["Unsubscribed"] = "unsubscribed";
  TrackEvent["CpuConstrained"] = "cpuConstrained";
  TrackEvent["UpdateSettings"] = "updateSettings";
  TrackEvent["UpdateSubscription"] = "updateSubscription";
  TrackEvent["AudioPlaybackStarted"] = "audioPlaybackStarted";
  TrackEvent["AudioPlaybackFailed"] = "audioPlaybackFailed";
  TrackEvent["AudioSilenceDetected"] = "audioSilenceDetected";
  TrackEvent["VisibilityChanged"] = "visibilityChanged";
  TrackEvent["VideoDimensionsChanged"] = "videoDimensionsChanged";
  TrackEvent["VideoPlaybackStarted"] = "videoPlaybackStarted";
  TrackEvent["VideoPlaybackFailed"] = "videoPlaybackFailed";
  TrackEvent["ElementAttached"] = "elementAttached";
  TrackEvent["ElementDetached"] = "elementDetached";
  TrackEvent["UpstreamPaused"] = "upstreamPaused";
  TrackEvent["UpstreamResumed"] = "upstreamResumed";
  TrackEvent["SubscriptionPermissionChanged"] = "subscriptionPermissionChanged";
  TrackEvent["SubscriptionStatusChanged"] = "subscriptionStatusChanged";
  TrackEvent["SubscriptionFailed"] = "subscriptionFailed";
  TrackEvent["TrackProcessorUpdate"] = "trackProcessorUpdate";
  TrackEvent["AudioTrackFeatureUpdate"] = "audioTrackFeatureUpdate";
  TrackEvent["TranscriptionReceived"] = "transcriptionReceived";
  TrackEvent["TimeSyncUpdate"] = "timeSyncUpdate";
  TrackEvent["PreConnectBufferFlushed"] = "preConnectBufferFlushed";
})(TrackEvent || (TrackEvent = {}));
function compact(summary) {
  const compacted = {};
  for (const _ref of Object.entries(summary)) {
    var _ref2 = _slicedToArray(_ref, 2);
    const key = _ref2[0];
    const value = _ref2[1];
    if (value !== undefined) {
      compacted[key] = value;
    }
  }
  return compacted;
}
function resolution(width, height) {
  return width && height ? "".concat(width, "x").concat(height) : undefined;
}
function round(seconds) {
  return Math.round(seconds * 1e4) / 1e4;
}
function jitterBuffer(stat) {
  const delay = stat.jitterBufferDelay;
  const emitted = stat.jitterBufferEmittedCount;
  return delay !== undefined && emitted ? round(delay / emitted) : undefined;
}
function playoutDelay(stat, playout) {
  if (stat.playoutDelay !== undefined) {
    return round(stat.playoutDelay);
  }
  const total = playout === null || playout === undefined ? undefined : playout.totalPlayoutDelay;
  const samples = playout === null || playout === undefined ? undefined : playout.totalSamplesCount;
  return total !== undefined && samples ? round(total / samples) : undefined;
}
function summarizeStatsReport(report) {
  var _a, _b;
  const byId = new Map;
  const candidatePairs = [];
  const inbound = [];
  const outbound = [];
  let transport;
  report.forEach((stat) => byId.set(stat.id, stat));
  const codecOf = (stat) => {
    var _a;
    return stat.codecId ? (_a = byId.get(stat.codecId)) === null || _a === undefined ? undefined : _a.mimeType : undefined;
  };
  const relatedOf = (stat, key) => stat[key] ? byId.get(stat[key]) : undefined;
  report.forEach((stat) => {
    switch (stat.type) {
      case "inbound-rtp": {
        const playout = relatedOf(stat, "playoutId");
        inbound.push(compact({
          kind: stat.kind,
          ssrc: stat.ssrc,
          mid: stat.mid,
          trackId: stat.trackIdentifier,
          codec: codecOf(stat),
          decoder: stat.decoderImplementation,
          resolution: resolution(stat.frameWidth, stat.frameHeight),
          fps: stat.framesPerSecond,
          bytesReceived: stat.bytesReceived,
          packetsReceived: stat.packetsReceived,
          packetsLost: stat.packetsLost,
          packetsDiscarded: stat.packetsDiscarded,
          framesReceived: stat.framesReceived,
          framesDecoded: stat.framesDecoded,
          framesDropped: stat.framesDropped,
          keyFramesDecoded: stat.keyFramesDecoded,
          freezeCount: stat.freezeCount,
          totalFreezesDuration: stat.totalFreezesDuration,
          pauseCount: stat.pauseCount,
          nackCount: stat.nackCount,
          pliCount: stat.pliCount,
          firCount: stat.firCount,
          jitter: stat.jitter,
          jitterBuffer: jitterBuffer(stat),
          playoutDelay: playoutDelay(stat, playout),
          audioLevel: stat.audioLevel,
          totalSamplesReceived: stat.totalSamplesReceived,
          concealedSamples: stat.concealedSamples
        }));
        break;
      }
      case "outbound-rtp": {
        const remote = relatedOf(stat, "remoteId");
        const source = relatedOf(stat, "mediaSourceId");
        outbound.push(compact({
          kind: stat.kind,
          ssrc: stat.ssrc,
          mid: stat.mid,
          rid: stat.rid,
          trackId: source === null || source === undefined ? undefined : source.trackIdentifier,
          active: stat.active,
          codec: codecOf(stat),
          encoder: stat.encoderImplementation,
          resolution: resolution(stat.frameWidth, stat.frameHeight),
          fps: stat.framesPerSecond,
          captureResolution: resolution(source === null || source === undefined ? undefined : source.width, source === null || source === undefined ? undefined : source.height),
          captureFps: source === null || source === undefined ? undefined : source.framesPerSecond,
          audioLevel: source === null || source === undefined ? undefined : source.audioLevel,
          targetBitrate: stat.targetBitrate,
          bytesSent: stat.bytesSent,
          packetsSent: stat.packetsSent,
          retransmittedPacketsSent: stat.retransmittedPacketsSent,
          framesEncoded: stat.framesEncoded,
          keyFramesEncoded: stat.keyFramesEncoded,
          limitedBy: stat.qualityLimitationReason === "none" ? undefined : stat.qualityLimitationReason,
          nackCount: stat.nackCount,
          pliCount: stat.pliCount,
          firCount: stat.firCount,
          remotePacketsLost: remote === null || remote === undefined ? undefined : remote.packetsLost,
          remoteFractionLost: remote === null || remote === undefined ? undefined : remote.fractionLost,
          remoteJitter: remote === null || remote === undefined ? undefined : remote.jitter,
          remoteRoundTripTime: remote === null || remote === undefined ? undefined : remote.roundTripTime
        }));
        break;
      }
      case "transport":
        transport = stat;
        break;
      case "candidate-pair":
        candidatePairs.push(stat);
        break;
    }
  });
  const selectedPairId = transport === null || transport === undefined ? undefined : transport.selectedCandidatePairId;
  const pair = (_b = (_a = selectedPairId ? byId.get(selectedPairId) : undefined) !== null && _a !== undefined ? _a : candidatePairs.find((candidate) => candidate.selected)) !== null && _b !== undefined ? _b : candidatePairs.find((candidate) => candidate.nominated);
  const local = (pair === null || pair === undefined ? undefined : pair.localCandidateId) ? byId.get(pair.localCandidateId) : undefined;
  const remote = (pair === null || pair === undefined ? undefined : pair.remoteCandidateId) ? byId.get(pair.remoteCandidateId) : undefined;
  const connection = compact({
    ice: transport === null || transport === undefined ? undefined : transport.iceState,
    dtls: transport === null || transport === undefined ? undefined : transport.dtlsState,
    route: local && remote ? "".concat(local.candidateType, "/").concat(local.protocol, " -> ").concat(remote.candidateType) : undefined,
    network: local === null || local === undefined ? undefined : local.networkType,
    currentRoundTripTime: pair === null || pair === undefined ? undefined : pair.currentRoundTripTime,
    availableOutgoingBitrate: pair === null || pair === undefined ? undefined : pair.availableOutgoingBitrate,
    availableIncomingBitrate: pair === null || pair === undefined ? undefined : pair.availableIncomingBitrate,
    bytesSent: pair === null || pair === undefined ? undefined : pair.bytesSent,
    bytesReceived: pair === null || pair === undefined ? undefined : pair.bytesReceived,
    candidatePairChanges: transport === null || transport === undefined ? undefined : transport.selectedCandidatePairChanges
  });
  return {
    connection: Object.keys(connection).length > 0 ? connection : undefined,
    outbound: outbound.length > 0 ? outbound : undefined,
    inbound: inbound.length > 0 ? inbound : undefined
  };
}

class VideoPreset {
  constructor(widthOrOptions, height, maxBitrate, maxFramerate, priority) {
    if (typeof widthOrOptions === "object") {
      this.width = widthOrOptions.width;
      this.height = widthOrOptions.height;
      this.aspectRatio = widthOrOptions.aspectRatio;
      this.encoding = {
        maxBitrate: widthOrOptions.maxBitrate,
        maxFramerate: widthOrOptions.maxFramerate,
        priority: widthOrOptions.priority
      };
    } else if (height !== undefined && maxBitrate !== undefined) {
      this.width = widthOrOptions;
      this.height = height;
      this.aspectRatio = widthOrOptions / height;
      this.encoding = {
        maxBitrate,
        maxFramerate,
        priority
      };
    } else {
      throw new TypeError("Unsupported options: provide at least width, height and maxBitrate");
    }
  }
  get resolution() {
    return {
      width: this.width,
      height: this.height,
      frameRate: this.encoding.maxFramerate,
      aspectRatio: this.aspectRatio
    };
  }
}
var videoCodecs = ["vp8", "h264", "vp9", "av1", "h265"];
var BackupCodecPolicy;
(function(BackupCodecPolicy) {
  BackupCodecPolicy[BackupCodecPolicy["PREFER_REGRESSION"] = 0] = "PREFER_REGRESSION";
  BackupCodecPolicy[BackupCodecPolicy["SIMULCAST"] = 1] = "SIMULCAST";
  BackupCodecPolicy[BackupCodecPolicy["REGRESSION"] = 2] = "REGRESSION";
})(BackupCodecPolicy || (BackupCodecPolicy = {}));
var AudioPresets;
(function(AudioPresets) {
  AudioPresets.telephone = {
    maxBitrate: 12000
  };
  AudioPresets.speech = {
    maxBitrate: 24000
  };
  AudioPresets.music = {
    maxBitrate: 48000
  };
  AudioPresets.musicStereo = {
    maxBitrate: 64000
  };
  AudioPresets.musicHighQuality = {
    maxBitrate: 96000
  };
  AudioPresets.musicHighQualityStereo = {
    maxBitrate: 128000
  };
})(AudioPresets || (AudioPresets = {}));
new VideoPreset(160, 90, 90000, 20), new VideoPreset(320, 180, 160000, 20), new VideoPreset(384, 216, 180000, 20), new VideoPreset(640, 360, 450000, 20), new VideoPreset(960, 540, 800000, 25), new VideoPreset(1280, 720, 1700000, 30), new VideoPreset(1920, 1080, 3000000, 30), new VideoPreset(2560, 1440, 5000000, 30), new VideoPreset(3840, 2160, 8000000, 30);
new VideoPreset(160, 120, 70000, 20), new VideoPreset(240, 180, 125000, 20), new VideoPreset(320, 240, 140000, 20), new VideoPreset(480, 360, 330000, 20), new VideoPreset(640, 480, 500000, 20), new VideoPreset(720, 540, 600000, 25), new VideoPreset(960, 720, 1300000, 30), new VideoPreset(1440, 1080, 2300000, 30), new VideoPreset(1920, 1440, 3800000, 30);
new VideoPreset(640, 360, 200000, 3, "medium"), new VideoPreset(640, 360, 400000, 15, "medium"), new VideoPreset(1280, 720, 800000, 5, "medium"), new VideoPreset(1280, 720, 1500000, 15, "medium"), new VideoPreset(1280, 720, 2000000, 30, "medium"), new VideoPreset(1920, 1080, 2500000, 15, "medium"), new VideoPreset(1920, 1080, 5000000, 30, "medium"), new VideoPreset(0, 0, 7000000, 30, "medium");
function mimeTypeToVideoCodecString(mimeType) {
  return mimeType.split("/")[1].toLowerCase();
}
function getLogContextFromTrack(track) {
  if ("mediaStreamTrack" in track) {
    return {
      trackID: track.sid,
      source: track.source,
      muted: track.isMuted,
      enabled: track.mediaStreamTrack.enabled,
      kind: track.kind,
      streamID: track.mediaStreamID,
      streamTrackID: track.mediaStreamTrack.id
    };
  } else {
    return {
      trackID: track.trackSid,
      enabled: track.isEnabled,
      muted: track.isMuted,
      trackInfo: Object.assign({
        mimeType: track.mimeType,
        name: track.trackName,
        encrypted: track.isEncrypted,
        kind: track.kind,
        source: track.source
      }, track.track ? getLogContextFromTrack(track.track) : {})
    };
  }
}
var BACKGROUND_REACTION_DELAY = 5000;
var recycledElements = [];
var VideoQuality;
(function(VideoQuality) {
  VideoQuality[VideoQuality["LOW"] = 0] = "LOW";
  VideoQuality[VideoQuality["MEDIUM"] = 1] = "MEDIUM";
  VideoQuality[VideoQuality["HIGH"] = 2] = "HIGH";
})(VideoQuality || (VideoQuality = {}));

class Track extends eventsExports.EventEmitter {
  get streamState() {
    return this._streamState;
  }
  setStreamState(value) {
    if (this._streamState !== value) {
      this.log.debug("stream state changed: ".concat(this._streamState, " -> ").concat(value));
    }
    this._streamState = value;
  }
  constructor(mediaTrack, kind) {
    let loggerOptions = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};
    var _a;
    super();
    this.attachedElements = [];
    this.isMuted = false;
    this._streamState = Track.StreamState.Active;
    this.isInBackground = false;
    this._currentBitrate = 0;
    this.finalStatsLogged = false;
    this.log = livekitLogger;
    this.appVisibilityChangedListener = () => {
      if (this.backgroundTimeout) {
        clearTimeout(this.backgroundTimeout);
      }
      if (document.visibilityState === "hidden") {
        this.backgroundTimeout = setTimeout(() => this.handleAppVisibilityChanged(), BACKGROUND_REACTION_DELAY);
      } else {
        this.handleAppVisibilityChanged();
      }
    };
    this.loggerContextCb = loggerOptions.loggerContextCb;
    this.log = getLogger((_a = loggerOptions.loggerName) !== null && _a !== undefined ? _a : LoggerNames.Track, () => this.logContext);
    this.setMaxListeners(100);
    this.kind = kind;
    this._mediaStreamTrack = mediaTrack;
    this._mediaStreamID = mediaTrack.id;
    this.source = Track.Source.Unknown;
  }
  get logContext() {
    var _a;
    return Object.assign(Object.assign({}, (_a = this.loggerContextCb) === null || _a === undefined ? undefined : _a.call(this)), getLogContextFromTrack(this));
  }
  get currentBitrate() {
    return this._currentBitrate;
  }
  get mediaStreamTrack() {
    return this._mediaStreamTrack;
  }
  get mediaStreamID() {
    return this._mediaStreamID;
  }
  attach(element) {
    let elementType = "audio";
    if (this.kind === Track.Kind.Video) {
      elementType = "video";
    }
    if (this.attachedElements.length === 0 && this.kind === Track.Kind.Video) {
      this.addAppVisibilityListener();
    }
    if (!element) {
      if (elementType === "audio") {
        recycledElements.forEach((e) => {
          if (e.parentElement === null && !element) {
            element = e;
          }
        });
        if (element) {
          recycledElements.splice(recycledElements.indexOf(element), 1);
        }
      }
      if (!element) {
        element = document.createElement(elementType);
      }
    }
    if (!this.attachedElements.includes(element)) {
      this.attachedElements.push(element);
    }
    attachToElement(this.mediaStreamTrack, element);
    const allMediaStreamTracks = element.srcObject.getTracks();
    const hasAudio = allMediaStreamTracks.some((tr) => tr.kind === "audio");
    element.play().then(() => {
      this.emit(hasAudio ? TrackEvent.AudioPlaybackStarted : TrackEvent.VideoPlaybackStarted);
    }).catch((e) => {
      if (e.name === "NotAllowedError") {
        this.emit(hasAudio ? TrackEvent.AudioPlaybackFailed : TrackEvent.VideoPlaybackFailed, e);
      } else if (e.name === "AbortError") {
        this.log.debug("".concat(hasAudio ? "audio" : "video", " playback aborted, likely due to new play request"));
      } else {
        this.log.warn("could not playback ".concat(hasAudio ? "audio" : "video"), {
          error: e
        });
      }
      if (hasAudio && element && allMediaStreamTracks.some((tr) => tr.kind === "video") && e.name === "NotAllowedError") {
        element.muted = true;
        element.play().catch(() => {});
      }
    });
    this.emit(TrackEvent.ElementAttached, element);
    return element;
  }
  detach(element) {
    try {
      if (element) {
        detachTrack(this.mediaStreamTrack, element);
        const idx = this.attachedElements.indexOf(element);
        if (idx >= 0) {
          this.attachedElements.splice(idx, 1);
          this.recycleElement(element);
          this.emit(TrackEvent.ElementDetached, element);
        }
        return element;
      }
      const detached = [];
      this.attachedElements.forEach((elm) => {
        detachTrack(this.mediaStreamTrack, elm);
        detached.push(elm);
        this.recycleElement(elm);
        this.emit(TrackEvent.ElementDetached, elm);
      });
      this.attachedElements = [];
      return detached;
    } finally {
      if (this.attachedElements.length === 0) {
        this.removeAppVisibilityListener();
      }
    }
  }
  stop() {
    this.log.debug("stopping track");
    this.stopMonitor();
    this._mediaStreamTrack.stop();
  }
  enable() {
    this._mediaStreamTrack.enabled = true;
  }
  disable() {
    this._mediaStreamTrack.enabled = false;
  }
  stopMonitor() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }
    if (this.timeSyncHandle !== undefined) {
      cancelAnimationFrame(this.timeSyncHandle);
      this.timeSyncHandle = undefined;
    }
    this.logFinalStats();
  }
  logFinalStats() {
    if (this.finalStatsLogged) {
      return;
    }
    this.finalStatsLogged = true;
    this.getRTCStatsReport().then((report) => {
      if (report) {
        this.log.info("final track stats", summarizeStatsReport(report));
      }
    }).catch((error) => this.log.debug("could not collect final track stats", {
      error
    }));
  }
  updateLoggerOptions(loggerOptions) {
    if (loggerOptions.loggerContextCb) {
      this.loggerContextCb = loggerOptions.loggerContextCb;
    }
    if (loggerOptions.loggerName) {
      this.log = getLogger(loggerOptions.loggerName, () => this.logContext);
    }
  }
  recycleElement(element) {
    if (element instanceof HTMLAudioElement) {
      let shouldCache = true;
      element.pause();
      recycledElements.forEach((e) => {
        if (!e.parentElement) {
          shouldCache = false;
        }
      });
      if (shouldCache) {
        recycledElements.push(element);
      }
    }
  }
  handleAppVisibilityChanged() {
    return __awaiter(this, undefined, undefined, function* () {
      this.isInBackground = document.visibilityState === "hidden";
      if (!this.isInBackground && this.kind === Track.Kind.Video) {
        setTimeout(() => this.attachedElements.forEach((el) => el.play().catch(() => {})), 0);
      }
    });
  }
  addAppVisibilityListener() {
    if (isWeb()) {
      this.isInBackground = document.visibilityState === "hidden";
      document.addEventListener("visibilitychange", this.appVisibilityChangedListener);
    } else {
      this.isInBackground = false;
    }
  }
  removeAppVisibilityListener() {
    if (isWeb()) {
      document.removeEventListener("visibilitychange", this.appVisibilityChangedListener);
    }
  }
}
function attachToElement(track, element) {
  let mediaStream;
  if (element.srcObject instanceof MediaStream) {
    mediaStream = element.srcObject;
  } else {
    mediaStream = new MediaStream;
  }
  let existingTracks;
  if (track.kind === "audio") {
    existingTracks = mediaStream.getAudioTracks();
  } else {
    existingTracks = mediaStream.getVideoTracks();
  }
  if (!existingTracks.includes(track)) {
    existingTracks.forEach((et) => {
      mediaStream.removeTrack(et);
    });
    mediaStream.addTrack(track);
  }
  if (!isSafari() || !(element instanceof HTMLVideoElement)) {
    element.autoplay = true;
  }
  element.muted = mediaStream.getAudioTracks().length === 0;
  if (element instanceof HTMLVideoElement) {
    element.playsInline = true;
  }
  if (element.srcObject !== mediaStream) {
    element.srcObject = mediaStream;
    if ((isSafari() || isFireFox()) && element instanceof HTMLVideoElement) {
      setTimeout(() => {
        element.srcObject = mediaStream;
        element.play().catch(() => {});
      }, 0);
    }
  }
}
function detachTrack(track, element) {
  if (element.srcObject instanceof MediaStream) {
    const mediaStream = element.srcObject;
    mediaStream.removeTrack(track);
    if (mediaStream.getTracks().length > 0) {
      element.srcObject = mediaStream;
    } else {
      element.srcObject = null;
    }
  }
}
(function(Track) {
  let Kind;
  (function(Kind) {
    Kind["Audio"] = "audio";
    Kind["Video"] = "video";
    Kind["Unknown"] = "unknown";
  })(Kind = Track.Kind || (Track.Kind = {}));
  let Source;
  (function(Source) {
    Source["Camera"] = "camera";
    Source["Microphone"] = "microphone";
    Source["ScreenShare"] = "screen_share";
    Source["ScreenShareAudio"] = "screen_share_audio";
    Source["Unknown"] = "unknown";
  })(Source = Track.Source || (Track.Source = {}));
  let StreamState$1;
  (function(StreamState) {
    StreamState["Active"] = "active";
    StreamState["Paused"] = "paused";
    StreamState["Unknown"] = "unknown";
  })(StreamState$1 = Track.StreamState || (Track.StreamState = {}));
  function kindToProto(k) {
    switch (k) {
      case Kind.Audio:
        return TrackType.AUDIO;
      case Kind.Video:
        return TrackType.VIDEO;
      default:
        return TrackType.DATA;
    }
  }
  Track.kindToProto = kindToProto;
  function kindFromProto(t) {
    switch (t) {
      case TrackType.AUDIO:
        return Kind.Audio;
      case TrackType.VIDEO:
        return Kind.Video;
      default:
        return Kind.Unknown;
    }
  }
  Track.kindFromProto = kindFromProto;
  function sourceToProto(s) {
    switch (s) {
      case Source.Camera:
        return TrackSource.CAMERA;
      case Source.Microphone:
        return TrackSource.MICROPHONE;
      case Source.ScreenShare:
        return TrackSource.SCREEN_SHARE;
      case Source.ScreenShareAudio:
        return TrackSource.SCREEN_SHARE_AUDIO;
      default:
        return TrackSource.UNKNOWN;
    }
  }
  Track.sourceToProto = sourceToProto;
  function sourceFromProto(s) {
    switch (s) {
      case TrackSource.CAMERA:
        return Source.Camera;
      case TrackSource.MICROPHONE:
        return Source.Microphone;
      case TrackSource.SCREEN_SHARE:
        return Source.ScreenShare;
      case TrackSource.SCREEN_SHARE_AUDIO:
        return Source.ScreenShareAudio;
      default:
        return Source.Unknown;
    }
  }
  Track.sourceFromProto = sourceFromProto;
  function streamStateFromProto(s) {
    switch (s) {
      case StreamState.ACTIVE:
        return StreamState$1.Active;
      case StreamState.PAUSED:
        return StreamState$1.Paused;
      default:
        return StreamState$1.Unknown;
    }
  }
  Track.streamStateFromProto = streamStateFromProto;
})(Track || (Track = {}));
function isFireFox() {
  var _a;
  return ((_a = getBrowser()) === null || _a === undefined ? undefined : _a.name) === "Firefox";
}
function isSafari() {
  var _a;
  return ((_a = getBrowser()) === null || _a === undefined ? undefined : _a.name) === "Safari";
}
function isWeb() {
  return typeof document !== "undefined";
}
function getErrorDescription(error, errorCategory) {
  if (error instanceof Error) {
    if (error.name && error.message) {
      return "".concat(error.name, ": ").concat(error.message);
    }
    return error.name;
  }
  return "Encountered unknown ".concat(errorCategory, " error: ").concat(String(error));
}
function isVideoFrame(frame) {
  return "type" in frame;
}
function importKey(keyBytes_1) {
  return __awaiter(this, arguments, undefined, function(keyBytes) {
    let algorithm = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {
      name: ENCRYPTION_ALGORITHM
    };
    let usage = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : "encrypt";
    return function* () {
      return crypto.subtle.importKey("raw", keyBytes, algorithm, false, usage === "derive" ? ["deriveBits", "deriveKey"] : ["encrypt", "decrypt"]);
    }();
  });
}
function getAlgoOptions(algorithmName, salt) {
  const textEncoder = new TextEncoder;
  const encodedSalt = textEncoder.encode(salt);
  switch (algorithmName) {
    case "HKDF":
      return {
        name: "HKDF",
        salt: encodedSalt,
        hash: "SHA-256",
        info: new ArrayBuffer(128)
      };
    case "PBKDF2": {
      return {
        name: "PBKDF2",
        salt: encodedSalt,
        hash: "SHA-256",
        iterations: 1e5
      };
    }
    default:
      throw new Error("algorithm ".concat(algorithmName, " is currently unsupported"));
  }
}
function deriveKeys(material, options) {
  return __awaiter(this, undefined, undefined, function* () {
    const algorithmOptions = getAlgoOptions(material.algorithm.name, options.ratchetSalt);
    const encryptionKey = yield crypto.subtle.deriveKey(algorithmOptions, material, {
      name: ENCRYPTION_ALGORITHM,
      length: options.keySize
    }, false, ["encrypt", "decrypt"]);
    return {
      material,
      encryptionKey
    };
  });
}
function ratchet(material, salt) {
  return __awaiter(this, undefined, undefined, function* () {
    const algorithmOptions = getAlgoOptions(material.algorithm.name, salt);
    return crypto.subtle.deriveBits(algorithmOptions, material, 256);
  });
}
function needsRbspUnescaping(frameData) {
  for (var i = 0;i < frameData.length - 3; i++) {
    if (frameData[i] == 0 && frameData[i + 1] == 0 && frameData[i + 2] == 3)
      return true;
  }
  return false;
}
function parseRbsp(stream) {
  const dataOut = [];
  var length = stream.length;
  for (var i = 0;i < stream.length; ) {
    if (length - i >= 3 && !stream[i] && !stream[i + 1] && stream[i + 2] == 3) {
      dataOut.push(stream[i++]);
      dataOut.push(stream[i++]);
      i++;
    } else {
      dataOut.push(stream[i++]);
    }
  }
  return new Uint8Array(dataOut);
}
var kZerosInStartSequence = 2;
var kEmulationByte = 3;
function writeRbsp(data_in) {
  const dataOut = [];
  var numConsecutiveZeros = 0;
  for (var i = 0;i < data_in.length; ++i) {
    var byte = data_in[i];
    if (byte <= kEmulationByte && numConsecutiveZeros >= kZerosInStartSequence) {
      dataOut.push(kEmulationByte);
      numConsecutiveZeros = 0;
    }
    dataOut.push(byte);
    if (byte == 0) {
      ++numConsecutiveZeros;
    } else {
      numConsecutiveZeros = 0;
    }
  }
  return new Uint8Array(dataOut);
}

class DataCryptor {
  static makeIV(timestamp) {
    const iv = new ArrayBuffer(12);
    const ivView = new DataView(iv);
    const randomBytes = crypto.getRandomValues(new Uint32Array(1));
    ivView.setUint32(0, randomBytes[0]);
    ivView.setUint32(4, timestamp);
    ivView.setUint32(8, timestamp - DataCryptor.sendCount % 65535);
    DataCryptor.sendCount++;
    return iv;
  }
  static encrypt(data, keys) {
    return __awaiter(this, undefined, undefined, function* () {
      const iv = DataCryptor.makeIV(performance.now());
      const keySet = yield keys.getKeySet();
      if (!keySet) {
        throw new Error("No key set found");
      }
      const cipherText = yield crypto.subtle.encrypt({
        name: ENCRYPTION_ALGORITHM,
        iv
      }, keySet.encryptionKey, new Uint8Array(data));
      return {
        payload: new Uint8Array(cipherText),
        iv: new Uint8Array(iv),
        keyIndex: keys.getCurrentKeyIndex()
      };
    });
  }
  static decrypt(data_1, iv_1, keys_1) {
    return __awaiter(this, arguments, undefined, function(data, iv, keys) {
      let keyIndex = arguments.length > 3 && arguments[3] !== undefined ? arguments[3] : 0;
      let initialMaterial = arguments.length > 4 ? arguments[4] : undefined;
      let ratchetOpts = arguments.length > 5 && arguments[5] !== undefined ? arguments[5] : {
        ratchetCount: 0
      };
      return function* () {
        const keySet = yield keys.getKeySet(keyIndex);
        if (!keySet) {
          throw new Error("No key set found");
        }
        try {
          const plainText = yield crypto.subtle.decrypt({
            name: ENCRYPTION_ALGORITHM,
            iv
          }, keySet.encryptionKey, new Uint8Array(data));
          return {
            payload: new Uint8Array(plainText)
          };
        } catch (error) {
          if (keys.keyProviderOptions.ratchetWindowSize > 0) {
            if (ratchetOpts.ratchetCount < keys.keyProviderOptions.ratchetWindowSize) {
              workerLogger.debug("DataCryptor: ratcheting key attempt ".concat(ratchetOpts.ratchetCount, " of ").concat(keys.keyProviderOptions.ratchetWindowSize, ", for data packet"));
              let ratchetedKeySet;
              let ratchetResult;
              if ((initialMaterial !== null && initialMaterial !== undefined ? initialMaterial : keySet) === keys.getKeySet(keyIndex)) {
                ratchetResult = yield keys.ratchetKey(keyIndex, false);
                ratchetedKeySet = yield deriveKeys(ratchetResult.cryptoKey, keys.keyProviderOptions);
              }
              const decryptedData = yield DataCryptor.decrypt(data, iv, keys, keyIndex, initialMaterial, {
                ratchetCount: ratchetOpts.ratchetCount + 1,
                encryptionKey: ratchetedKeySet === null || ratchetedKeySet === undefined ? undefined : ratchetedKeySet.encryptionKey
              });
              if (decryptedData && ratchetedKeySet) {
                if ((initialMaterial !== null && initialMaterial !== undefined ? initialMaterial : keySet) === keys.getKeySet(keyIndex)) {
                  keys.setKeySet(ratchetedKeySet, keyIndex, ratchetResult);
                  keys.setCurrentKeyIndex(keyIndex);
                }
              }
              return decryptedData;
            } else {
              workerLogger.warn("DataCryptor: maximum ratchet attempts exceeded");
              throw new CryptorError("DataCryptor: valid key missing for participant ".concat(keys.participantIdentity), CryptorErrorReason.InvalidKey, keys.participantIdentity);
            }
          } else {
            throw new CryptorError("DataCryptor: Decryption failed: ".concat(getErrorDescription(error, "decryption")), CryptorErrorReason.InvalidKey, keys.participantIdentity);
          }
        }
      }();
    });
  }
}
DataCryptor.sendCount = 0;

class ErrorRateLimiter {
  constructor() {
    let throttleMs = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : 1000;
    let windowMs = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 60000;
    let maxPerWindow = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : 5;
    this.throttleMs = throttleMs;
    this.windowMs = windowMs;
    this.maxPerWindow = maxPerWindow;
    this.lastAt = new Map;
    this.counts = new Map;
  }
  reset() {
    this.lastAt.clear();
    this.counts.clear();
  }
  countFor(key) {
    var _a;
    return (_a = this.counts.get(key)) !== null && _a !== undefined ? _a : 0;
  }
  shouldEmit(key, onSuppress) {
    var _a, _b;
    const now = Date.now();
    const last = (_a = this.lastAt.get(key)) !== null && _a !== undefined ? _a : 0;
    const count = (_b = this.counts.get(key)) !== null && _b !== undefined ? _b : 0;
    if (now - last > this.windowMs) {
      this.counts.set(key, 0);
      this.lastAt.set(key, now);
      return true;
    }
    if (now - last < this.throttleMs)
      return false;
    if (count >= this.maxPerWindow) {
      if (count === this.maxPerWindow) {
        onSuppress === null || onSuppress === undefined || onSuppress();
        this.counts.set(key, count + 1);
      }
      return false;
    }
    this.lastAt.set(key, now);
    this.counts.set(key, count + 1);
    return true;
  }
}
function hasFrameMetadataPublishOptions(options) {
  return !!((options === null || options === undefined ? undefined : options.timestamp) || (options === null || options === undefined ? undefined : options.frameId));
}
var PACKET_TRAILER_MAGIC = Uint8Array.from([76, 75, 84, 83]);
var PACKET_TRAILER_TIMESTAMP_TAG = 1;
var PACKET_TRAILER_FRAME_ID_TAG = 2;
var PACKET_TRAILER_USER_DATA_TAG = 3;
var PACKET_TRAILER_ENVELOPE_SIZE = 5;
var TIMESTAMP_TLV_SIZE = 10;
var FRAME_ID_TLV_SIZE = 6;
function appendPacketTrailer(data, userTimestamp, frameId) {
  const hasTimestamp = userTimestamp !== BigInt(0);
  const hasFrameId = frameId !== 0;
  if (!hasTimestamp && !hasFrameId) {
    return data;
  }
  const trailerLength = (hasTimestamp ? TIMESTAMP_TLV_SIZE : 0) + (hasFrameId ? FRAME_ID_TLV_SIZE : 0) + PACKET_TRAILER_ENVELOPE_SIZE;
  const result = new Uint8Array(data.length + trailerLength);
  let offset = 0;
  result.set(data, offset);
  offset += data.length;
  if (hasTimestamp) {
    result[offset++] = PACKET_TRAILER_TIMESTAMP_TAG ^ 255;
    result[offset++] = 8 ^ 255;
    writeUint64Xor(result, offset, userTimestamp);
    offset += 8;
  }
  if (hasFrameId) {
    result[offset++] = PACKET_TRAILER_FRAME_ID_TAG ^ 255;
    result[offset++] = 4 ^ 255;
    writeUint32Xor(result, offset, frameId);
    offset += 4;
  }
  result[offset++] = trailerLength ^ 255;
  result.set(PACKET_TRAILER_MAGIC, offset);
  return result;
}
function appendPacketTrailerToEncodedFrame(frame, options, frameId) {
  if (!hasFrameMetadataPublishOptions(options) || frame.data.byteLength === 0) {
    return false;
  }
  const userTimestamp = (options === null || options === undefined ? undefined : options.timestamp) ? BigInt(Date.now()) * BigInt(1000) : BigInt(0);
  const packetTrailerFrameId = (options === null || options === undefined ? undefined : options.frameId) ? frameId : 0;
  const data = new Uint8Array(frame.data);
  const result = appendPacketTrailer(data, userTimestamp, packetTrailerFrameId);
  if (result.byteLength === data.byteLength) {
    return false;
  }
  frame.data = result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
  return true;
}
function extractPacketTrailer(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < PACKET_TRAILER_ENVELOPE_SIZE) {
    return {
      data: bytes
    };
  }
  const magicOffset = bytes.length - PACKET_TRAILER_MAGIC.length;
  if (!matchesMagic(bytes, magicOffset)) {
    return {
      data: bytes
    };
  }
  const trailerLength = bytes[bytes.length - PACKET_TRAILER_ENVELOPE_SIZE] ^ 255;
  if (trailerLength < PACKET_TRAILER_ENVELOPE_SIZE || trailerLength > bytes.length) {
    return {
      data: bytes
    };
  }
  const trailerStart = bytes.length - trailerLength;
  const trailerEnd = bytes.length - PACKET_TRAILER_ENVELOPE_SIZE;
  const strippedData = bytes.subarray(0, trailerStart);
  let offset = trailerStart;
  let foundAny = false;
  const metadata = {
    userTimestamp: BigInt(0),
    frameId: 0
  };
  while (offset + 2 <= trailerEnd) {
    const tag = bytes[offset++] ^ 255;
    const length = bytes[offset++] ^ 255;
    if (offset + length > trailerEnd) {
      break;
    }
    if (tag === PACKET_TRAILER_TIMESTAMP_TAG && length === 8) {
      metadata.userTimestamp = readUint64Xor(bytes, offset);
      foundAny = true;
    } else if (tag === PACKET_TRAILER_FRAME_ID_TAG && length === 4) {
      metadata.frameId = readUint32Xor(bytes, offset, length);
      foundAny = true;
    } else if (tag === PACKET_TRAILER_USER_DATA_TAG) {
      const userData = new Uint8Array(length);
      for (let index = 0;index < length; index += 1) {
        userData[index] = bytes[offset + index] ^ 255;
      }
      metadata.userData = userData;
      foundAny = true;
    }
    offset += length;
  }
  if (!foundAny) {
    return {
      data: bytes
    };
  }
  return {
    data: strippedData,
    metadata
  };
}
function matchesMagic(data, offset) {
  for (let index = 0;index < PACKET_TRAILER_MAGIC.length; index += 1) {
    if (data[offset + index] !== PACKET_TRAILER_MAGIC[index]) {
      return false;
    }
  }
  return true;
}
function readUint64Xor(data, offset) {
  const hi = BigInt(((data[offset] ^ 255) << 24 | (data[offset + 1] ^ 255) << 16 | (data[offset + 2] ^ 255) << 8 | data[offset + 3] ^ 255) >>> 0);
  const lo = BigInt(((data[offset + 4] ^ 255) << 24 | (data[offset + 5] ^ 255) << 16 | (data[offset + 6] ^ 255) << 8 | data[offset + 7] ^ 255) >>> 0);
  return hi << BigInt(32) | lo;
}
function readUint32Xor(data, offset, length) {
  let value = 0;
  for (let index = 0;index < length; index += 1) {
    value = value << 8 | data[offset + index] ^ 255;
  }
  return value >>> 0;
}
function writeUint64Xor(target, offset, value) {
  const hi = Number(value >> BigInt(32) & BigInt(4294967295));
  const lo = Number(value & BigInt(4294967295));
  target[offset] = hi >>> 24 ^ 255;
  target[offset + 1] = hi >>> 16 & 255 ^ 255;
  target[offset + 2] = hi >>> 8 & 255 ^ 255;
  target[offset + 3] = hi & 255 ^ 255;
  target[offset + 4] = lo >>> 24 ^ 255;
  target[offset + 5] = lo >>> 16 & 255 ^ 255;
  target[offset + 6] = lo >>> 8 & 255 ^ 255;
  target[offset + 7] = lo & 255 ^ 255;
}
function writeUint32Xor(target, offset, value) {
  for (let index = 3;index >= 0; index -= 1) {
    target[offset + (3 - index)] = value >> index * 8 & 255 ^ 255;
  }
}
function getFrameRtpTimestamp(frame) {
  try {
    const metadata = frame.getMetadata();
    if (typeof metadata.rtpTimestamp === "number") {
      return metadata.rtpTimestamp;
    }
    if (typeof metadata.timestamp === "number") {
      return metadata.timestamp;
    }
  } catch (_a) {}
  if (typeof frame.timestamp === "number") {
    return frame.timestamp;
  }
  return;
}
function getFrameSsrc(frame) {
  try {
    const metadata = frame.getMetadata();
    if (typeof metadata.synchronizationSource === "number") {
      return metadata.synchronizationSource;
    }
  } catch (_a) {}
  return 0;
}
function processPacketTrailer(frame, trackId) {
  if (frame.data.byteLength === 0) {
    return {};
  }
  const result = extractPacketTrailer(frame.data);
  if (!result.metadata) {
    return {};
  }
  const strippedData = result.data.buffer.slice(result.data.byteOffset, result.data.byteOffset + result.data.byteLength);
  const rtpTimestamp = getFrameRtpTimestamp(frame);
  if (rtpTimestamp === undefined || !trackId) {
    return {
      data: strippedData
    };
  }
  return {
    data: strippedData,
    payload: {
      trackId,
      rtpTimestamp,
      ssrc: getFrameSsrc(frame),
      metadata: result.metadata
    }
  };
}
var kH264NaluTypeMask = 31;
var H264NALUType;
(function(H264NALUType) {
  H264NALUType[H264NALUType["SLICE_NON_IDR"] = 1] = "SLICE_NON_IDR";
  H264NALUType[H264NALUType["SLICE_PARTITION_A"] = 2] = "SLICE_PARTITION_A";
  H264NALUType[H264NALUType["SLICE_PARTITION_B"] = 3] = "SLICE_PARTITION_B";
  H264NALUType[H264NALUType["SLICE_PARTITION_C"] = 4] = "SLICE_PARTITION_C";
  H264NALUType[H264NALUType["SLICE_IDR"] = 5] = "SLICE_IDR";
  H264NALUType[H264NALUType["SEI"] = 6] = "SEI";
  H264NALUType[H264NALUType["SPS"] = 7] = "SPS";
  H264NALUType[H264NALUType["PPS"] = 8] = "PPS";
  H264NALUType[H264NALUType["AUD"] = 9] = "AUD";
  H264NALUType[H264NALUType["END_SEQ"] = 10] = "END_SEQ";
  H264NALUType[H264NALUType["END_STREAM"] = 11] = "END_STREAM";
  H264NALUType[H264NALUType["FILLER_DATA"] = 12] = "FILLER_DATA";
  H264NALUType[H264NALUType["SPS_EXT"] = 13] = "SPS_EXT";
  H264NALUType[H264NALUType["PREFIX_NALU"] = 14] = "PREFIX_NALU";
  H264NALUType[H264NALUType["SUBSET_SPS"] = 15] = "SUBSET_SPS";
  H264NALUType[H264NALUType["DPS"] = 16] = "DPS";
  H264NALUType[H264NALUType["SLICE_AUX"] = 19] = "SLICE_AUX";
  H264NALUType[H264NALUType["SLICE_EXT"] = 20] = "SLICE_EXT";
  H264NALUType[H264NALUType["SLICE_LAYER_EXT"] = 21] = "SLICE_LAYER_EXT";
})(H264NALUType || (H264NALUType = {}));
var H265NALUType;
(function(H265NALUType) {
  H265NALUType[H265NALUType["TRAIL_N"] = 0] = "TRAIL_N";
  H265NALUType[H265NALUType["TRAIL_R"] = 1] = "TRAIL_R";
  H265NALUType[H265NALUType["TSA_N"] = 2] = "TSA_N";
  H265NALUType[H265NALUType["TSA_R"] = 3] = "TSA_R";
  H265NALUType[H265NALUType["STSA_N"] = 4] = "STSA_N";
  H265NALUType[H265NALUType["STSA_R"] = 5] = "STSA_R";
  H265NALUType[H265NALUType["RADL_N"] = 6] = "RADL_N";
  H265NALUType[H265NALUType["RADL_R"] = 7] = "RADL_R";
  H265NALUType[H265NALUType["RASL_N"] = 8] = "RASL_N";
  H265NALUType[H265NALUType["RASL_R"] = 9] = "RASL_R";
  H265NALUType[H265NALUType["BLA_W_LP"] = 16] = "BLA_W_LP";
  H265NALUType[H265NALUType["BLA_W_RADL"] = 17] = "BLA_W_RADL";
  H265NALUType[H265NALUType["BLA_N_LP"] = 18] = "BLA_N_LP";
  H265NALUType[H265NALUType["IDR_W_RADL"] = 19] = "IDR_W_RADL";
  H265NALUType[H265NALUType["IDR_N_LP"] = 20] = "IDR_N_LP";
  H265NALUType[H265NALUType["CRA_NUT"] = 21] = "CRA_NUT";
  H265NALUType[H265NALUType["VPS_NUT"] = 32] = "VPS_NUT";
  H265NALUType[H265NALUType["SPS_NUT"] = 33] = "SPS_NUT";
  H265NALUType[H265NALUType["PPS_NUT"] = 34] = "PPS_NUT";
  H265NALUType[H265NALUType["AUD_NUT"] = 35] = "AUD_NUT";
  H265NALUType[H265NALUType["EOS_NUT"] = 36] = "EOS_NUT";
  H265NALUType[H265NALUType["EOB_NUT"] = 37] = "EOB_NUT";
  H265NALUType[H265NALUType["FD_NUT"] = 38] = "FD_NUT";
  H265NALUType[H265NALUType["PREFIX_SEI_NUT"] = 39] = "PREFIX_SEI_NUT";
  H265NALUType[H265NALUType["SUFFIX_SEI_NUT"] = 40] = "SUFFIX_SEI_NUT";
})(H265NALUType || (H265NALUType = {}));
function parseH264NALUType(startByte) {
  return startByte & kH264NaluTypeMask;
}
function parseH265NALUType(firstByte) {
  return firstByte >> 1 & 63;
}
function isH264SliceNALU(naluType) {
  return naluType === H264NALUType.SLICE_IDR || naluType === H264NALUType.SLICE_NON_IDR;
}
function isH265SliceNALU(naluType) {
  return naluType === H265NALUType.TRAIL_N || naluType === H265NALUType.TRAIL_R || naluType === H265NALUType.TSA_N || naluType === H265NALUType.TSA_R || naluType === H265NALUType.STSA_N || naluType === H265NALUType.STSA_R || naluType === H265NALUType.RADL_N || naluType === H265NALUType.RADL_R || naluType === H265NALUType.RASL_N || naluType === H265NALUType.RASL_R || naluType === H265NALUType.BLA_W_LP || naluType === H265NALUType.BLA_W_RADL || naluType === H265NALUType.BLA_N_LP || naluType === H265NALUType.IDR_W_RADL || naluType === H265NALUType.IDR_N_LP || naluType === H265NALUType.CRA_NUT;
}
function detectCodecFromNALUs(data, naluIndices) {
  for (const naluIndex of naluIndices) {
    if (isH264SliceNALU(parseH264NALUType(data[naluIndex])))
      return "h264";
  }
  for (const naluIndex of naluIndices) {
    if (isH265SliceNALU(parseH265NALUType(data[naluIndex])))
      return "h265";
  }
  return "unknown";
}
function findSliceNALUUnencryptedBytes(data, naluIndices, codec) {
  for (const index of naluIndices) {
    if (codec === "h265") {
      const type = parseH265NALUType(data[index]);
      if (isH265SliceNALU(type)) {
        return index + 2;
      }
    } else {
      const type = parseH264NALUType(data[index]);
      if (isH264SliceNALU(type)) {
        return index + 2;
      }
    }
  }
  return null;
}
function findNALUIndices(stream) {
  const result = [];
  let start = 0, pos = 0, searchLength = stream.length - 3;
  while (pos < searchLength) {
    while (pos < searchLength) {
      if (pos < searchLength - 1 && stream[pos] === 0 && stream[pos + 1] === 0 && stream[pos + 2] === 0 && stream[pos + 3] === 1) {
        break;
      }
      if (stream[pos] === 0 && stream[pos + 1] === 0 && stream[pos + 2] === 1) {
        break;
      }
      pos++;
    }
    if (pos >= searchLength)
      pos = stream.length;
    let end = pos;
    while (end > start && stream[end - 1] === 0)
      end--;
    if (start === 0) {
      if (end !== start)
        throw TypeError("byte stream contains leading data");
    } else {
      result.push(start);
    }
    let startCodeLength = 3;
    if (pos < stream.length - 3 && stream[pos] === 0 && stream[pos + 1] === 0 && stream[pos + 2] === 0 && stream[pos + 3] === 1) {
      startCodeLength = 4;
    }
    start = pos = pos + startCodeLength;
  }
  return result;
}
function processNALUsForEncryption(data, knownCodec) {
  const naluIndices = findNALUIndices(data);
  let detectedCodec = detectCodecFromNALUs(data, naluIndices);
  if (detectedCodec === "unknown") {
    detectedCodec = knownCodec !== null && knownCodec !== undefined ? knownCodec : "unknown";
  }
  if (detectedCodec === "unknown") {
    return {
      unencryptedBytes: 0,
      detectedCodec,
      requiresNALUProcessing: false
    };
  }
  const unencryptedBytes = findSliceNALUUnencryptedBytes(data, naluIndices, detectedCodec);
  if (unencryptedBytes === null) {
    throw new TypeError("Could not find NALU");
  }
  return {
    unencryptedBytes,
    detectedCodec,
    requiresNALUProcessing: true
  };
}
function normalizeAnnexBStartCodes(data) {
  const shortStartCodes = [];
  for (let i = 0;i + 2 < data.length; ) {
    if (data[i + 2] === 0) {
      i += 1;
      continue;
    }
    if (data[i + 2] === 1 && data[i] === 0 && data[i + 1] === 0 && (i === 0 || data[i - 1] !== 0)) {
      shortStartCodes.push(i);
    }
    i += 3;
  }
  if (shortStartCodes.length === 0) {
    return data;
  }
  const result = new Uint8Array(data.length + shortStartCodes.length);
  let from = 0;
  for (let inserted = 0;inserted < shortStartCodes.length; inserted++) {
    const to = shortStartCodes[inserted];
    result.set(data.subarray(from, to), from + inserted);
    from = to;
  }
  result.set(data.subarray(from), from + shortStartCodes.length);
  return result;
}
function cryptoHash(data) {
  return __awaiter(this, undefined, undefined, function* () {
    const hashBuffer = yield crypto.subtle.digest("SHA-256", data);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray).map((b) => b.toString(16).padStart(2, "0")).join("");
  });
}
var CryptoHashes = {
  VP8KeyFrame8x8: "ef0161653d8b2b23aad46624b420af1d03ce48950e9fc85718028f91b50f9219",
  H264KeyFrame2x2SPS: "f0a0e09647d891d6d50aa898bce7108090375d0d55e50a2bb21147afee558e44",
  H264KeyFrame2x2PPS: "61d9665eed71b6d424ae9539330a3bdd5cb386d4d781c808219a6e36750493a7",
  H264KeyFrame2x2IDR: "faffc26b68a2fc09096fa20f3351e706398b6f838a7500c8063472c2e476e90d",
  OpusSilenceFrame: "aad8d31fc56b2802ca500e58c2fb9d0b29ad71bb7cb52cd6530251eade188988"
};
function identifySifPayload(data) {
  return __awaiter(this, undefined, undefined, function* () {
    const hash = yield cryptoHash(data);
    switch (hash) {
      case CryptoHashes.VP8KeyFrame8x8:
        return "vp8";
      case CryptoHashes.H264KeyFrame2x2SPS:
        return "h264";
      case CryptoHashes.H264KeyFrame2x2PPS:
        return "h264";
      case CryptoHashes.H264KeyFrame2x2IDR:
        return "h264";
      case CryptoHashes.OpusSilenceFrame:
        return "opus";
      default:
        return null;
    }
  });
}
var encryptionEnabledMap = new Map;

class BaseFrameCryptor extends eventsExports.EventEmitter {
  encodeFunction(encodedFrame, controller) {
    throw Error("not implemented for subclass");
  }
  decodeFunction(encodedFrame, controller) {
    throw Error("not implemented for subclass");
  }
}

class FrameCryptor extends BaseFrameCryptor {
  constructor(opts) {
    var _a;
    super();
    this.hasFrameMetadata = false;
    this.frameMetadataFrameId = 0;
    this.errorLimiter = new ErrorRateLimiter;
    this.UNDECRYPTED_TRACK_GRACE_MS = 2000;
    this.loggedNALUFallbacks = new Set;
    this.sendCounts = new Map;
    this.keys = opts.keys;
    this.participantIdentity = opts.participantIdentity;
    this.rtpMap = new Map;
    this.keyProviderOptions = opts.keyProviderOptions;
    this.sifTrailer = (_a = opts.sifTrailer) !== null && _a !== undefined ? _a : Uint8Array.from([]);
  }
  get logContext() {
    return {
      participant: this.participantIdentity,
      mediaTrackId: this.trackId,
      fallbackCodec: this.videoCodec
    };
  }
  setParticipant(id, keys) {
    workerLogger.debug("setting new participant on cryptor", Object.assign(Object.assign({}, this.logContext), {
      newParticipant: id,
      hadPreviousParticipant: !!this.participantIdentity
    }));
    if (this.participantIdentity && this.participantIdentity !== id) {
      workerLogger.warn("cryptor has already a participant set, cleaning up before switching", {
        oldParticipant: this.participantIdentity,
        newParticipant: id,
        trackId: this.trackId
      });
      this.unsetParticipant();
    }
    this.participantIdentity = id;
    this.keys = keys;
  }
  unsetParticipant() {
    workerLogger.debug("unsetting participant", this.logContext);
    clearTimeout(this.undecryptedTrackTimeout);
    this.undecryptedTrackTimeout = undefined;
    this.participantIdentity = undefined;
    this.errorLimiter.reset();
  }
  isEnabled() {
    if (this.participantIdentity) {
      return encryptionEnabledMap.get(this.participantIdentity);
    } else {
      return;
    }
  }
  getParticipantIdentity() {
    return this.participantIdentity;
  }
  getTrackId() {
    return this.trackId;
  }
  setTrackId(trackId) {
    if (this.trackId === trackId) {
      return;
    }
    workerLogger.debug("re-pointing cryptor at new trackId", Object.assign(Object.assign({}, this.logContext), {
      newTrackId: trackId
    }));
    this.trackId = trackId;
  }
  hasActiveTransform() {
    return !!this.currentTransform;
  }
  scheduleUndecryptedTrackWatchdog(operation) {
    clearTimeout(this.undecryptedTrackTimeout);
    this.undecryptedTrackTimeout = undefined;
    if (operation !== "decode") {
      return;
    }
    this.undecryptedTrackTimeout = setTimeout(() => {
      if (this.currentTransform || !this.isEnabled()) {
        return;
      }
      workerLogger.warn("encrypted track has no active decrypt transform", this.logContext);
      this.emitThrottledError(new CryptorError("no active decrypt transform for encrypted track ".concat(this.trackId), CryptorErrorReason.InternalError, this.participantIdentity));
    }, this.UNDECRYPTED_TRACK_GRACE_MS);
  }
  ensureTransform() {
    if (this.currentTransform) {
      return true;
    }
    if (!this.retainedStreams || this.trackId === undefined) {
      workerLogger.warn("no streams retained, cannot re-establish transform", this.logContext);
      return false;
    }
    const _this$retainedStreams = this.retainedStreams, { readable, writable, operation } = _this$retainedStreams;
    workerLogger.info("re-establishing transform", Object.assign(Object.assign({}, this.logContext), {
      operation
    }));
    return this.setupTransform(operation, readable, writable, this.trackId);
  }
  setVideoCodec(codec) {
    this.videoCodec = codec;
  }
  setRtpMap(map) {
    this.rtpMap = map;
  }
  setHasFrameMetadata(hasFrameMetadata) {
    this.hasFrameMetadata = hasFrameMetadata;
  }
  setFrameMetadataOpts(frameMetadata) {
    this.frameMetadataOpts = frameMetadata;
    this.frameMetadataFrameId = 0;
  }
  setupTransform(operation, readable, writable, trackId, codec, frameMetadata) {
    var _a;
    if (codec) {
      workerLogger.info("setting codec on cryptor to", {
        codec
      });
      this.videoCodec = codec;
    }
    if (operation === "encode") {
      this.setFrameMetadataOpts(frameMetadata);
    }
    workerLogger.debug("Setting up frame cryptor transform", Object.assign({
      operation,
      passedTrackId: trackId,
      codec,
      hasCurrentTransform: !!this.currentTransform
    }, this.logContext));
    this.trackId = trackId;
    this.retainedStreams = {
      readable,
      writable,
      operation
    };
    clearTimeout(this.undecryptedTrackTimeout);
    const symbol = Symbol("transform");
    const transformFn = operation === "encode" ? this.encodeFunction : this.decodeFunction;
    const transformStream = new TransformStream({
      transform: transformFn.bind(this)
    });
    this.currentTransform = {
      readable,
      writable,
      transformer: transformStream,
      trackId,
      symbol
    };
    try {
      readable.pipeThrough(transformStream).pipeTo(writable).catch((e) => {
        if (e instanceof TypeError && e.message === "Destination stream closed") {
          workerLogger.debug("destination stream closed");
        } else {
          workerLogger.warn("transform error", Object.assign({
            error: e
          }, this.logContext));
          this.emit(CryptorEvent.Error, e instanceof CryptorError ? e : new CryptorError(e.message, undefined, this.participantIdentity));
        }
      }).finally(() => {
        var _a;
        if (((_a = this.currentTransform) === null || _a === undefined ? undefined : _a.symbol) === symbol) {
          workerLogger.debug("transform completed", Object.assign(Object.assign({}, this.logContext), {
            trackId
          }));
          this.currentTransform = undefined;
        }
        this.scheduleUndecryptedTrackWatchdog(operation);
      });
    } catch (e) {
      if (((_a = this.currentTransform) === null || _a === undefined ? undefined : _a.symbol) === symbol) {
        this.currentTransform = undefined;
      }
      workerLogger.error("failed to set up transform", Object.assign({
        error: e
      }, this.logContext));
      this.emit(CryptorEvent.Error, e instanceof CryptorError ? e : new CryptorError(e.message, CryptorErrorReason.InternalError, this.participantIdentity));
      return false;
    }
    return true;
  }
  setSifTrailer(trailer) {
    workerLogger.debug("setting SIF trailer", Object.assign(Object.assign({}, this.logContext), {
      trailer
    }));
    this.sifTrailer = trailer;
  }
  emitThrottledError(error) {
    const errorKey = "".concat(this.participantIdentity, "-").concat(error.reason, "-decrypt");
    const emit = this.errorLimiter.shouldEmit(errorKey, () => {
      workerLogger.warn("Suppressing further decryption errors for ".concat(this.participantIdentity), Object.assign(Object.assign({}, this.logContext), {
        errorKey
      }));
    });
    if (!emit)
      return;
    const count = this.errorLimiter.countFor(errorKey);
    if (count > 1) {
      workerLogger.debug("Decryption error (".concat(count, " occurrences in window)"), Object.assign(Object.assign({}, this.logContext), {
        reason: CryptorErrorReason[error.reason]
      }));
    }
    this.emit(CryptorEvent.Error, error);
  }
  encodeFunction(encodedFrame, controller) {
    return __awaiter(this, undefined, undefined, function* () {
      var _a;
      if (encodedFrame.data.byteLength === 0) {
        return controller.enqueue(encodedFrame);
      }
      if (!this.isEnabled()) {
        this.appendFrameMetadata(encodedFrame);
        return controller.enqueue(encodedFrame);
      }
      const keySet = this.keys.getKeySet();
      if (!keySet) {
        this.emitThrottledError(new CryptorError("key set not found for ".concat(this.participantIdentity, " at index ").concat(this.keys.getCurrentKeyIndex()), CryptorErrorReason.MissingKey, this.participantIdentity));
        return;
      }
      const encryptionKey = keySet.encryptionKey;
      const keyIndex = this.keys.getCurrentKeyIndex();
      if (encryptionKey) {
        const iv = this.makeIV((_a = encodedFrame.getMetadata().synchronizationSource) !== null && _a !== undefined ? _a : -1, encodedFrame.timestamp);
        let frameInfo = this.getUnencryptedBytes(encodedFrame);
        let frameHeader = new Uint8Array(encodedFrame.data, 0, frameInfo.unencryptedBytes);
        if (frameInfo.requiresNALUProcessing) {
          frameHeader = normalizeAnnexBStartCodes(frameHeader);
        }
        const frameTrailer = new Uint8Array(2);
        frameTrailer[0] = IV_LENGTH;
        frameTrailer[1] = keyIndex;
        try {
          const cipherText = yield crypto.subtle.encrypt({
            name: ENCRYPTION_ALGORITHM,
            iv,
            additionalData: frameHeader
          }, encryptionKey, new Uint8Array(encodedFrame.data, frameInfo.unencryptedBytes));
          let newDataWithoutHeader = new Uint8Array(cipherText.byteLength + iv.byteLength + frameTrailer.byteLength);
          newDataWithoutHeader.set(new Uint8Array(cipherText));
          newDataWithoutHeader.set(new Uint8Array(iv), cipherText.byteLength);
          newDataWithoutHeader.set(frameTrailer, cipherText.byteLength + iv.byteLength);
          if (frameInfo.requiresNALUProcessing) {
            newDataWithoutHeader = writeRbsp(newDataWithoutHeader);
          }
          var newData = new Uint8Array(frameHeader.byteLength + newDataWithoutHeader.byteLength);
          newData.set(frameHeader);
          newData.set(newDataWithoutHeader, frameHeader.byteLength);
          encodedFrame.data = newData.buffer;
          this.appendFrameMetadata(encodedFrame);
          return controller.enqueue(encodedFrame);
        } catch (e) {
          workerLogger.error("error while encrypting", Object.assign(Object.assign({}, this.logContext), {
            error: e
          }));
        }
      } else {
        workerLogger.debug("failed to encrypt, emitting error", this.logContext);
        this.emitThrottledError(new CryptorError("encryption key missing for encoding", CryptorErrorReason.MissingKey, this.participantIdentity));
      }
    });
  }
  appendFrameMetadata(encodedFrame) {
    var _a;
    if (!hasFrameMetadataPublishOptions(this.frameMetadataOpts) || !isVideoFrame(encodedFrame)) {
      return;
    }
    if ((_a = this.frameMetadataOpts) === null || _a === undefined ? undefined : _a.frameId) {
      this.frameMetadataFrameId = this.frameMetadataFrameId === 4294967295 ? 1 : this.frameMetadataFrameId + 1;
    }
    appendPacketTrailerToEncodedFrame(encodedFrame, this.frameMetadataOpts, this.frameMetadataFrameId);
  }
  decodeFunction(encodedFrame, controller) {
    return __awaiter(this, undefined, undefined, function* () {
      if (this.hasFrameMetadata && isVideoFrame(encodedFrame)) {
        try {
          const ptResult = processPacketTrailer(encodedFrame, this.trackId);
          if (ptResult.data) {
            encodedFrame.data = ptResult.data;
          }
          if (ptResult.payload && this.participantIdentity) {
            const msg = {
              kind: "packetTrailerMetadata",
              data: ptResult.payload
            };
            postMessage(msg);
          }
        } catch (_a) {}
      }
      if (encodedFrame.data.byteLength === 0) {
        return controller.enqueue(encodedFrame);
      }
      const encryptionEnabled = this.isEnabled();
      if (encryptionEnabled === undefined) {
        if (this.participantIdentity === undefined) {
          workerLogger.debug("dropping frame for unassigned cryptor", this.logContext);
          return;
        }
        this.emitThrottledError(new CryptorError("encryption state unknown for track ".concat(this.trackId, ", dropping frame"), CryptorErrorReason.InternalError, this.participantIdentity));
        return;
      }
      if (!encryptionEnabled) {
        return controller.enqueue(encodedFrame);
      }
      if (isFrameServerInjected(encodedFrame.data, this.sifTrailer)) {
        encodedFrame.data = encodedFrame.data.slice(0, encodedFrame.data.byteLength - this.sifTrailer.byteLength);
        if (yield identifySifPayload(encodedFrame.data)) {
          workerLogger.debug("enqueue SIF", this.logContext);
          return controller.enqueue(encodedFrame);
        } else {
          workerLogger.warn("Unexpected SIF frame payload, dropping frame", this.logContext);
          return;
        }
      }
      const data = new Uint8Array(encodedFrame.data);
      const keyIndex = data[encodedFrame.data.byteLength - 1];
      if (this.keys.hasInvalidKeyAtIndex(keyIndex)) {
        return;
      }
      if (this.keys.getKeySet(keyIndex)) {
        try {
          const decodedFrame = yield this.decryptFrame(encodedFrame, keyIndex);
          this.keys.decryptionSuccess(keyIndex);
          if (decodedFrame) {
            return controller.enqueue(decodedFrame);
          }
        } catch (error) {
          if (error instanceof CryptorError && error.reason === CryptorErrorReason.InvalidKey) {
            if (this.keys.hasValidKey) {
              this.emitThrottledError(error);
              this.keys.decryptionFailure(keyIndex);
            }
          } else {
            workerLogger.warn("decoding frame failed", {
              error
            });
          }
        }
      } else {
        workerLogger.warn("skipping decryption due to missing key at index ".concat(keyIndex));
        this.emitThrottledError(new CryptorError("missing key at index ".concat(keyIndex, " for participant ").concat(this.participantIdentity), CryptorErrorReason.MissingKey, this.participantIdentity));
        this.keys.decryptionFailure(keyIndex);
      }
    });
  }
  decryptFrame(encodedFrame_1, keyIndex_1) {
    return __awaiter(this, arguments, undefined, function(encodedFrame, keyIndex) {
      var _this = this;
      let initialMaterial = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : undefined;
      let ratchetOpts = arguments.length > 3 && arguments[3] !== undefined ? arguments[3] : {
        ratchetCount: 0
      };
      return function* () {
        var _a;
        const keySet = _this.keys.getKeySet(keyIndex);
        if (!ratchetOpts.encryptionKey && !keySet) {
          throw new TypeError("no encryption key found for decryption of ".concat(_this.participantIdentity));
        }
        let frameInfo = _this.getUnencryptedBytes(encodedFrame);
        try {
          const frameHeader = new Uint8Array(encodedFrame.data, 0, frameInfo.unencryptedBytes);
          var encryptedData = new Uint8Array(encodedFrame.data, frameHeader.length, encodedFrame.data.byteLength - frameHeader.length);
          if (frameInfo.requiresNALUProcessing && needsRbspUnescaping(encryptedData)) {
            encryptedData = parseRbsp(encryptedData);
            const newUint8 = new Uint8Array(frameHeader.byteLength + encryptedData.byteLength);
            newUint8.set(frameHeader);
            newUint8.set(encryptedData, frameHeader.byteLength);
            encodedFrame.data = newUint8.buffer;
          }
          const frameTrailer = new Uint8Array(encodedFrame.data, encodedFrame.data.byteLength - 2, 2);
          const ivLength = frameTrailer[0];
          const iv = new Uint8Array(encodedFrame.data, encodedFrame.data.byteLength - ivLength - frameTrailer.byteLength, ivLength);
          const cipherTextStart = frameHeader.byteLength;
          const cipherTextLength = encodedFrame.data.byteLength - (frameHeader.byteLength + ivLength + frameTrailer.byteLength);
          const plainText = yield crypto.subtle.decrypt({
            name: ENCRYPTION_ALGORITHM,
            iv,
            additionalData: new Uint8Array(encodedFrame.data, 0, frameHeader.byteLength)
          }, (_a = ratchetOpts.encryptionKey) !== null && _a !== undefined ? _a : keySet.encryptionKey, new Uint8Array(encodedFrame.data, cipherTextStart, cipherTextLength));
          const newData = new ArrayBuffer(frameHeader.byteLength + plainText.byteLength);
          const newUint8 = new Uint8Array(newData);
          newUint8.set(new Uint8Array(encodedFrame.data, 0, frameHeader.byteLength));
          newUint8.set(new Uint8Array(plainText), frameHeader.byteLength);
          encodedFrame.data = newData;
          return encodedFrame;
        } catch (error) {
          if (_this.keyProviderOptions.ratchetWindowSize > 0) {
            if (ratchetOpts.ratchetCount < _this.keyProviderOptions.ratchetWindowSize) {
              workerLogger.debug("ratcheting key attempt ".concat(ratchetOpts.ratchetCount, " of ").concat(_this.keyProviderOptions.ratchetWindowSize, ", for kind ").concat(encodedFrame instanceof RTCEncodedAudioFrame ? "audio" : "video"));
              let ratchetedKeySet;
              let ratchetResult;
              if ((initialMaterial !== null && initialMaterial !== undefined ? initialMaterial : keySet) === _this.keys.getKeySet(keyIndex)) {
                ratchetResult = yield _this.keys.ratchetKey(keyIndex, false);
                ratchetedKeySet = yield deriveKeys(ratchetResult.cryptoKey, _this.keyProviderOptions);
              }
              const frame = yield _this.decryptFrame(encodedFrame, keyIndex, initialMaterial || keySet, {
                ratchetCount: ratchetOpts.ratchetCount + 1,
                encryptionKey: ratchetedKeySet === null || ratchetedKeySet === undefined ? undefined : ratchetedKeySet.encryptionKey
              });
              if (frame && ratchetedKeySet) {
                if ((initialMaterial !== null && initialMaterial !== undefined ? initialMaterial : keySet) === _this.keys.getKeySet(keyIndex)) {
                  _this.keys.setKeySet(ratchetedKeySet, keyIndex, ratchetResult);
                  _this.keys.setCurrentKeyIndex(keyIndex);
                }
              }
              return frame;
            } else {
              workerLogger.warn("maximum ratchet attempts exceeded");
              throw new CryptorError("valid key missing for participant ".concat(_this.participantIdentity), CryptorErrorReason.InvalidKey, _this.participantIdentity);
            }
          } else {
            throw new CryptorError("Decryption failed: ".concat(getErrorDescription(error, "decryption")), CryptorErrorReason.InvalidKey, _this.participantIdentity);
          }
        }
      }();
    });
  }
  makeIV(synchronizationSource, timestamp) {
    var _a;
    const iv = new ArrayBuffer(IV_LENGTH);
    const ivView = new DataView(iv);
    if (!this.sendCounts.has(synchronizationSource)) {
      this.sendCounts.set(synchronizationSource, Math.floor(Math.random() * 65535));
    }
    const sendCount = (_a = this.sendCounts.get(synchronizationSource)) !== null && _a !== undefined ? _a : 0;
    ivView.setUint32(0, synchronizationSource);
    ivView.setUint32(4, timestamp);
    ivView.setUint32(8, timestamp - sendCount % 65535);
    this.sendCounts.set(synchronizationSource, sendCount + 1);
    return iv;
  }
  getUnencryptedBytes(frame) {
    var _a;
    if (!isVideoFrame(frame)) {
      return {
        unencryptedBytes: UNENCRYPTED_BYTES.audio,
        requiresNALUProcessing: false
      };
    }
    const detectedCodec = (_a = this.getVideoCodec(frame)) !== null && _a !== undefined ? _a : this.videoCodec;
    if (detectedCodec !== this.detectedCodec) {
      workerLogger.debug("detected different codec", Object.assign({
        detectedCodec,
        oldCodec: this.detectedCodec
      }, this.logContext));
      this.detectedCodec = detectedCodec;
    }
    if (detectedCodec === "av1") {
      throw new Error("".concat(detectedCodec, " is not yet supported for end to end encryption"));
    }
    if (detectedCodec === "vp8") {
      return {
        unencryptedBytes: UNENCRYPTED_BYTES[frame.type],
        requiresNALUProcessing: false
      };
    }
    if (detectedCodec === "vp9") {
      return {
        unencryptedBytes: 0,
        requiresNALUProcessing: false
      };
    }
    const payloadType = frame.getMetadata().payloadType;
    const fallbackKey = "".concat(this.participantIdentity, "-").concat(this.trackId, "-").concat(payloadType);
    try {
      const knownCodec = detectedCodec === "h264" || detectedCodec === "h265" ? detectedCodec : undefined;
      const naluResult = processNALUsForEncryption(new Uint8Array(frame.data), knownCodec);
      if (naluResult.requiresNALUProcessing) {
        this.loggedNALUFallbacks.delete(fallbackKey);
        return {
          unencryptedBytes: naluResult.unencryptedBytes,
          requiresNALUProcessing: true
        };
      }
    } catch (e) {
      this.logNALUFallbackOnce(fallbackKey, frame, payloadType, detectedCodec, e);
    }
    return {
      unencryptedBytes: UNENCRYPTED_BYTES[frame.type],
      requiresNALUProcessing: false
    };
  }
  logNALUFallbackOnce(fallbackKey, frame, payloadType, detectedCodec, error) {
    if (this.loggedNALUFallbacks.has(fallbackKey)) {
      return;
    }
    this.loggedNALUFallbacks.add(fallbackKey);
    workerLogger.warn("NALU processing failed, falling back to VP8 handling", Object.assign({
      error,
      payloadType,
      detectedCodec,
      frameType: frame.type,
      byteLength: frame.data.byteLength,
      firstBytes: Array.from(new Uint8Array(frame.data, 0, Math.min(16, frame.data.byteLength))).map((b) => b.toString(16).padStart(2, "0")).join(" ")
    }, this.logContext));
  }
  getVideoCodec(frame) {
    const metadata = frame.getMetadata();
    if (metadata.mimeType) {
      const maybeKnownCodec = mimeTypeToVideoCodecString(metadata.mimeType);
      if (videoCodecs.includes(maybeKnownCodec)) {
        return maybeKnownCodec;
      }
    }
    if (this.rtpMap.size === 0) {
      return;
    }
    const payloadType = metadata.payloadType;
    const codec = payloadType ? this.rtpMap.get(payloadType) : undefined;
    return codec;
  }
}
function isFrameServerInjected(frameData, trailerBytes) {
  if (trailerBytes.byteLength === 0) {
    return false;
  }
  const frameTrailer = new Uint8Array(frameData.slice(frameData.byteLength - trailerBytes.byteLength));
  return trailerBytes.every((value, index) => value === frameTrailer[index]);
}

class ParticipantKeyHandler extends eventsExports.EventEmitter {
  get hasValidKey() {
    return !this.hasInvalidKeyAtIndex(this.currentKeyIndex);
  }
  constructor(participantIdentity, keyProviderOptions) {
    super();
    this.currentKeyIndex = 0;
    if (keyProviderOptions.keyringSize < 1 || keyProviderOptions.keyringSize > 256) {
      throw new TypeError("Keyring size needs to be between 1 and 256");
    }
    this.cryptoKeyRing = new Array(keyProviderOptions.keyringSize).fill(undefined);
    this.decryptionFailureCounts = new Array(keyProviderOptions.keyringSize).fill(0);
    this.keyProviderOptions = keyProviderOptions;
    this.ratchetPromiseMap = new Map;
    this.participantIdentity = participantIdentity;
  }
  hasInvalidKeyAtIndex(keyIndex) {
    return this.keyProviderOptions.failureTolerance >= 0 && this.decryptionFailureCounts[keyIndex] > this.keyProviderOptions.failureTolerance;
  }
  decryptionFailure() {
    let keyIndex = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : this.currentKeyIndex;
    if (this.keyProviderOptions.failureTolerance < 0) {
      return;
    }
    this.decryptionFailureCounts[keyIndex] += 1;
    if (this.decryptionFailureCounts[keyIndex] > this.keyProviderOptions.failureTolerance) {
      workerLogger.warn("key for ".concat(this.participantIdentity, " at index ").concat(keyIndex, " is being marked as invalid"));
    }
  }
  decryptionSuccess() {
    let keyIndex = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : this.currentKeyIndex;
    this.resetKeyStatus(keyIndex);
  }
  resetKeyStatus(keyIndex) {
    if (keyIndex === undefined) {
      this.decryptionFailureCounts.fill(0);
    } else {
      this.decryptionFailureCounts[keyIndex] = 0;
    }
  }
  ratchetKey(keyIndex) {
    let setKey = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : true;
    const currentKeyIndex = keyIndex !== null && keyIndex !== undefined ? keyIndex : this.getCurrentKeyIndex();
    const existingPromise = this.ratchetPromiseMap.get(currentKeyIndex);
    if (typeof existingPromise !== "undefined") {
      return existingPromise;
    }
    const ratchetPromise = new Promise((resolve, reject) => __awaiter(this, undefined, undefined, function* () {
      try {
        const keySet = this.getKeySet(currentKeyIndex);
        if (!keySet) {
          throw new TypeError("Cannot ratchet key without a valid keyset of participant ".concat(this.participantIdentity));
        }
        const currentMaterial = keySet.material;
        const chainKey = yield ratchet(currentMaterial, this.keyProviderOptions.ratchetSalt);
        const newMaterial = yield importKey(chainKey, currentMaterial.algorithm.name, "derive");
        const ratchetResult = {
          chainKey,
          cryptoKey: newMaterial
        };
        if (setKey) {
          yield this.setKeyFromMaterial(newMaterial, currentKeyIndex, ratchetResult);
        }
        resolve(ratchetResult);
      } catch (e) {
        reject(e);
      } finally {
        this.ratchetPromiseMap.delete(currentKeyIndex);
      }
    }));
    this.ratchetPromiseMap.set(currentKeyIndex, ratchetPromise);
    return ratchetPromise;
  }
  setKey(material_1) {
    return __awaiter(this, arguments, undefined, function(material) {
      var _this = this;
      let keyIndex = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 0;
      let updateCurrentKeyIndex = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : true;
      return function* () {
        yield _this.setKeyFromMaterial(material, keyIndex, null, updateCurrentKeyIndex);
        if (updateCurrentKeyIndex) {
          _this.resetKeyStatus(keyIndex);
        }
      }();
    });
  }
  setKeyFromMaterial(material_1, keyIndex_1) {
    return __awaiter(this, arguments, undefined, function(material, keyIndex) {
      var _this2 = this;
      let ratchetedResult = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : null;
      let updateCurrentKeyIndex = arguments.length > 3 && arguments[3] !== undefined ? arguments[3] : true;
      return function* () {
        const keySet = yield deriveKeys(material, _this2.keyProviderOptions);
        const newIndex = keyIndex >= 0 ? keyIndex % _this2.cryptoKeyRing.length : _this2.currentKeyIndex;
        workerLogger.debug("setting new key with index ".concat(keyIndex), {
          usage: material.usages,
          algorithm: material.algorithm,
          ratchetSalt: _this2.keyProviderOptions.ratchetSalt
        });
        _this2.setKeySet(keySet, newIndex, ratchetedResult);
        if (newIndex >= 0 && updateCurrentKeyIndex)
          _this2.currentKeyIndex = newIndex;
      }();
    });
  }
  setKeySet(keySet, keyIndex) {
    let ratchetedResult = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : null;
    this.cryptoKeyRing[keyIndex % this.cryptoKeyRing.length] = keySet;
    if (ratchetedResult) {
      this.emit(KeyHandlerEvent.KeyRatcheted, ratchetedResult, this.participantIdentity, keyIndex);
    }
  }
  setCurrentKeyIndex(index) {
    return __awaiter(this, undefined, undefined, function* () {
      this.currentKeyIndex = index % this.cryptoKeyRing.length;
      this.resetKeyStatus(index);
    });
  }
  getCurrentKeyIndex() {
    return this.currentKeyIndex;
  }
  getKeySet(keyIndex) {
    return this.cryptoKeyRing[keyIndex !== null && keyIndex !== undefined ? keyIndex : this.currentKeyIndex];
  }
}
var participantCryptors = [];
var participantKeys = new Map;
var sharedKeyHandler;
var messageQueue = new AsyncQueue;
var isEncryptionEnabled = false;
var useSharedKey = false;
var sifTrailer;
var keyProviderOptions = KEY_PROVIDER_DEFAULTS;
var rtpMap = new Map;
var dataDecryptErrorLimiter = new ErrorRateLimiter;
workerLogger.setDefaultLevel("info");
workerLogger.methodFactory = (methodName) => (msg, context) => {
  postMessage({
    kind: "log",
    data: {
      level: methodName,
      msg,
      context
    }
  });
};
workerLogger.setLevel(workerLogger.getLevel());
onmessage = (ev) => {
  messageQueue.run(() => __awaiter(undefined, undefined, undefined, function* () {
    const _ev$data = ev.data, { kind, data } = _ev$data;
    switch (kind) {
      case "init":
        workerLogger.setLevel(data.loglevel);
        workerLogger.info("e2ee worker initialized");
        keyProviderOptions = data.keyProviderOptions;
        useSharedKey = !!data.keyProviderOptions.sharedKey;
        const ackMsg = {
          kind: "initAck",
          data: {
            enabled: isEncryptionEnabled
          }
        };
        postMessage(ackMsg);
        break;
      case "setLogLevel":
        workerLogger.setLevel(data.level);
        break;
      case "enable":
        setEncryptionEnabled(data.enabled, data.participantIdentity);
        workerLogger.info("updated e2ee enabled status for ".concat(data.participantIdentity, " to ").concat(data.enabled));
        postMessage(ev.data);
        break;
      case "decode":
        let cryptor = getTrackCryptor(data.participantIdentity, data.trackId);
        cryptor.setHasFrameMetadata(data.hasPacketTrailer);
        cryptor.setupTransform(kind, data.readableStream, data.writableStream, data.trackId, data.codec);
        break;
      case "encode":
        let pubCryptor = getTrackCryptor(data.participantIdentity, data.trackId);
        pubCryptor.setHasFrameMetadata(data.hasPacketTrailer);
        pubCryptor.setupTransform(kind, data.readableStream, data.writableStream, data.trackId, data.codec, data.packetTrailer);
        break;
      case "encryptDataRequest":
        const _yield$DataCryptor$en = yield DataCryptor.encrypt(data.payload, getParticipantKeyHandler(data.participantIdentity)), { payload: encryptedPayload, iv, keyIndex } = _yield$DataCryptor$en;
        postMessage({
          kind: "encryptDataResponse",
          data: {
            payload: encryptedPayload,
            iv,
            keyIndex,
            uuid: data.uuid
          }
        });
        break;
      case "decryptDataRequest":
        try {
          const _yield$DataCryptor$de = yield DataCryptor.decrypt(data.payload, data.iv, getParticipantKeyHandler(data.participantIdentity), data.keyIndex), decryptedPayload = _yield$DataCryptor$de.payload;
          postMessage({
            kind: "decryptDataResponse",
            data: {
              payload: decryptedPayload,
              uuid: data.uuid
            }
          });
        } catch (error) {
          const errorKey = "".concat(data.participantIdentity, "-datadecrypt");
          const shouldLog = dataDecryptErrorLimiter.shouldEmit(errorKey, () => {
            workerLogger.warn("Suppressing further data decryption errors for ".concat(data.participantIdentity), {
              errorKey
            });
          });
          if (shouldLog) {
            workerLogger.error("DataCryptor decryption failed", {
              error,
              participantIdentity: data.participantIdentity,
              uuid: data.uuid
            });
          }
          postMessage({
            kind: "error",
            data: {
              error: error instanceof Error ? error : new Error(String(error)),
              uuid: data.uuid
            }
          });
        }
        break;
      case "setKey":
        if (useSharedKey) {
          yield setSharedKey(data.key, data.keyIndex, data.updateCurrentKeyIndex);
        } else if (data.participantIdentity) {
          workerLogger.info("set participant sender key ".concat(data.participantIdentity, " index ").concat(data.keyIndex));
          yield getParticipantKeyHandler(data.participantIdentity).setKey(data.key, data.keyIndex, data.updateCurrentKeyIndex);
        } else {
          workerLogger.error("no participant Id was provided and shared key usage is disabled");
        }
        break;
      case "removeTransform":
        unsetCryptorParticipant(data.trackId, data.participantIdentity);
        break;
      case "updateCodec":
        const trackCryptor = getTrackCryptor(data.participantIdentity, data.trackId, data.previousTrackId);
        if (data.codec) {
          trackCryptor.setVideoCodec(data.codec);
        }
        trackCryptor.setHasFrameMetadata(data.hasPacketTrailer);
        workerLogger.info("updated codec", {
          participantIdentity: data.participantIdentity,
          trackId: data.trackId,
          previousTrackId: data.previousTrackId,
          codec: data.codec,
          hasPacketTrailer: data.hasPacketTrailer
        });
        if (data.previousTrackId !== undefined && !trackCryptor.ensureTransform()) {
          workerLogger.error("could not re-establish transform for reused receiver", {
            participantIdentity: data.participantIdentity,
            trackId: data.trackId,
            previousTrackId: data.previousTrackId
          });
        }
        break;
      case "setRTPMap":
        rtpMap = data.map;
        participantCryptors.forEach((cr) => {
          if (cr.getParticipantIdentity() === data.participantIdentity) {
            cr.setRtpMap(data.map);
          }
        });
        break;
      case "ratchetRequest":
        handleRatchetRequest(data);
        break;
      case "setSifTrailer":
        handleSifTrailer(data.trailer);
        break;
    }
  }));
};
function handleRatchetRequest(data) {
  return __awaiter(this, undefined, undefined, function* () {
    if (useSharedKey) {
      const keyHandler = getSharedKeyHandler();
      yield keyHandler.ratchetKey(data.keyIndex);
      keyHandler.resetKeyStatus();
    } else if (data.participantIdentity) {
      const keyHandler = getParticipantKeyHandler(data.participantIdentity);
      yield keyHandler.ratchetKey(data.keyIndex);
      keyHandler.resetKeyStatus();
    } else {
      workerLogger.error("no participant Id was provided for ratchet request and shared key usage is disabled");
    }
  });
}
function getTrackCryptor(participantIdentity, trackId, previousTrackId) {
  let cryptors = participantCryptors.filter((c) => c.getTrackId() === trackId);
  if (cryptors.length === 0 && previousTrackId !== undefined && previousTrackId !== trackId) {
    const previous = participantCryptors.filter((c) => c.getTrackId() === previousTrackId);
    if (previous.length > 0) {
      workerLogger.info("reusing cryptor from previous trackId", {
        participantIdentity,
        trackId,
        previousTrackId
      });
      previous[0].setTrackId(trackId);
      cryptors = previous;
    }
  }
  if (cryptors.length > 1) {
    const debugInfo = cryptors.map((c) => {
      return {
        participant: c.getParticipantIdentity()
      };
    }).join(",");
    workerLogger.error("Found multiple cryptors for the same trackID ".concat(trackId, ". target participant: ").concat(participantIdentity, " "), {
      participants: debugInfo
    });
  }
  let cryptor = cryptors[0];
  if (!cryptor) {
    workerLogger.info("creating new cryptor for", {
      participantIdentity,
      trackId
    });
    if (!keyProviderOptions) {
      throw Error("Missing keyProvider options");
    }
    cryptor = new FrameCryptor({
      participantIdentity,
      keys: getParticipantKeyHandler(participantIdentity),
      keyProviderOptions,
      sifTrailer
    });
    cryptor.setRtpMap(rtpMap);
    setupCryptorErrorEvents(cryptor);
    participantCryptors.push(cryptor);
  } else if (participantIdentity !== cryptor.getParticipantIdentity()) {
    cryptor.setParticipant(participantIdentity, getParticipantKeyHandler(participantIdentity));
  }
  return cryptor;
}
function getParticipantKeyHandler(participantIdentity) {
  if (useSharedKey) {
    return getSharedKeyHandler();
  }
  let keys = participantKeys.get(participantIdentity);
  if (!keys) {
    keys = new ParticipantKeyHandler(participantIdentity, keyProviderOptions);
    keys.on(KeyHandlerEvent.KeyRatcheted, emitRatchetedKeys);
    participantKeys.set(participantIdentity, keys);
  }
  return keys;
}
function getSharedKeyHandler() {
  if (!sharedKeyHandler) {
    workerLogger.debug("creating new shared key handler");
    sharedKeyHandler = new ParticipantKeyHandler("shared-key", keyProviderOptions);
  }
  return sharedKeyHandler;
}
function unsetCryptorParticipant(trackId, participantIdentity) {
  const cryptors = participantCryptors.filter((c) => c.getParticipantIdentity() === participantIdentity && c.getTrackId() === trackId);
  if (cryptors.length > 1) {
    workerLogger.error("Found multiple cryptors for the same participant and trackID combination", {
      trackId,
      participantIdentity
    });
  }
  const cryptor = cryptors[0];
  if (!cryptor) {
    workerLogger.warn("Could not unset participant on cryptor", {
      trackId,
      participantIdentity
    });
  } else {
    cryptor.unsetParticipant();
  }
}
function setEncryptionEnabled(enable, participantIdentity) {
  workerLogger.debug("setting encryption enabled for all tracks of ".concat(participantIdentity), {
    enable
  });
  encryptionEnabledMap.set(participantIdentity, enable);
}
function setSharedKey(key, index, updateCurrentKeyIndex) {
  return __awaiter(this, undefined, undefined, function* () {
    workerLogger.info("set shared key", {
      index
    });
    yield getSharedKeyHandler().setKey(key, index, updateCurrentKeyIndex);
  });
}
function setupCryptorErrorEvents(cryptor) {
  cryptor.on(CryptorEvent.Error, (error) => {
    const msg = {
      kind: "error",
      data: {
        error: new Error("".concat(CryptorErrorReason[error.reason], ": ").concat(error.message)),
        participantIdentity: error.participantIdentity
      }
    };
    postMessage(msg);
  });
}
function emitRatchetedKeys(ratchetResult, participantIdentity, keyIndex) {
  const msg = {
    kind: "ratchetKey",
    data: {
      participantIdentity,
      keyIndex,
      ratchetResult
    }
  };
  postMessage(msg);
}
function handleSifTrailer(trailer) {
  sifTrailer = trailer;
  participantCryptors.forEach((c) => {
    c.setSifTrailer(trailer);
  });
}
if (self.RTCTransformEvent) {
  self.onrtctransform = (event) => {
    const transformer = event.transformer;
    const options = transformer.options;
    const { kind, participantIdentity, trackId, codec, hasPacketTrailer } = options;
    messageQueue.run(() => __awaiter(undefined, undefined, undefined, function* () {
      const cryptor = getTrackCryptor(participantIdentity, trackId);
      cryptor.setHasFrameMetadata(hasPacketTrailer);
      workerLogger.debug("onrtctransform setup", {
        participantIdentity,
        trackId,
        codec
      });
      cryptor.setupTransform(kind, transformer.readable, transformer.writable, trackId, codec, kind === "encode" ? options.packetTrailer : undefined);
    }));
  };
}

//# debugId=9804B11C977D073F64756E2164756E21
//# sourceMappingURL=lkE2ee.worker-ajvtxkb3.js.map
