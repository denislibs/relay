import {
  __commonJS
} from "./main-s48bdnny.js";

// node_modules/.bun/@mediapipe+selfie_segmentation@0.1.1675465747/node_modules/@mediapipe/selfie_segmentation/selfie_segmentation.js
var require_selfie_segmentation = __commonJS(function(exports) {
  (function() {
    var x;
    function aa(a) {
      var b = 0;
      return function() {
        return b < a.length ? { done: false, value: a[b++] } : { done: true };
      };
    }
    var ba = typeof Object.defineProperties == "function" ? Object.defineProperty : function(a, b, c) {
      if (a == Array.prototype || a == Object.prototype)
        return a;
      a[b] = c.value;
      return a;
    };
    function ca(a) {
      a = [typeof globalThis == "object" && globalThis, a, typeof window == "object" && window, typeof self == "object" && self, typeof global == "object" && global];
      for (var b = 0;b < a.length; ++b) {
        var c = a[b];
        if (c && c.Math == Math)
          return c;
      }
      throw Error("Cannot find global object");
    }
    var y = ca(this);
    function z(a, b) {
      if (b)
        a: {
          var c = y;
          a = a.split(".");
          for (var d = 0;d < a.length - 1; d++) {
            var e = a[d];
            if (!(e in c))
              break a;
            c = c[e];
          }
          a = a[a.length - 1];
          d = c[a];
          b = b(d);
          b != d && b != null && ba(c, a, { configurable: true, writable: true, value: b });
        }
    }
    z("Symbol", function(a) {
      function b(g) {
        if (this instanceof b)
          throw new TypeError("Symbol is not a constructor");
        return new c(d + (g || "") + "_" + e++, g);
      }
      function c(g, f) {
        this.h = g;
        ba(this, "description", { configurable: true, writable: true, value: f });
      }
      if (a)
        return a;
      c.prototype.toString = function() {
        return this.h;
      };
      var d = "jscomp_symbol_" + (1e9 * Math.random() >>> 0) + "_", e = 0;
      return b;
    });
    z("Symbol.iterator", function(a) {
      if (a)
        return a;
      a = Symbol("Symbol.iterator");
      for (var b = "Array Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array Float32Array Float64Array".split(" "), c = 0;c < b.length; c++) {
        var d = y[b[c]];
        typeof d === "function" && typeof d.prototype[a] != "function" && ba(d.prototype, a, { configurable: true, writable: true, value: function() {
          return da(aa(this));
        } });
      }
      return a;
    });
    function da(a) {
      a = { next: a };
      a[Symbol.iterator] = function() {
        return this;
      };
      return a;
    }
    function A(a) {
      var b = typeof Symbol != "undefined" && Symbol.iterator && a[Symbol.iterator];
      return b ? b.call(a) : { next: aa(a) };
    }
    function ea(a) {
      if (!(a instanceof Array)) {
        a = A(a);
        for (var b, c = [];!(b = a.next()).done; )
          c.push(b.value);
        a = c;
      }
      return a;
    }
    var fa = typeof Object.assign == "function" ? Object.assign : function(a, b) {
      for (var c = 1;c < arguments.length; c++) {
        var d = arguments[c];
        if (d)
          for (var e in d)
            Object.prototype.hasOwnProperty.call(d, e) && (a[e] = d[e]);
      }
      return a;
    };
    z("Object.assign", function(a) {
      return a || fa;
    });
    var ha = typeof Object.create == "function" ? Object.create : function(a) {
      function b() {}
      b.prototype = a;
      return new b;
    }, ia;
    if (typeof Object.setPrototypeOf == "function")
      ia = Object.setPrototypeOf;
    else {
      var ja;
      a: {
        var ka = { a: true }, la = {};
        try {
          la.__proto__ = ka;
          ja = la.a;
          break a;
        } catch (a) {}
        ja = false;
      }
      ia = ja ? function(a, b) {
        a.__proto__ = b;
        if (a.__proto__ !== b)
          throw new TypeError(a + " is not extensible");
        return a;
      } : null;
    }
    var ma = ia;
    function na(a, b) {
      a.prototype = ha(b.prototype);
      a.prototype.constructor = a;
      if (ma)
        ma(a, b);
      else
        for (var c in b)
          if (c != "prototype")
            if (Object.defineProperties) {
              var d = Object.getOwnPropertyDescriptor(b, c);
              d && Object.defineProperty(a, c, d);
            } else
              a[c] = b[c];
      a.za = b.prototype;
    }
    function oa() {
      this.m = false;
      this.j = null;
      this.i = undefined;
      this.h = 1;
      this.v = this.s = 0;
      this.l = null;
    }
    function pa(a) {
      if (a.m)
        throw new TypeError("Generator is already running");
      a.m = true;
    }
    oa.prototype.u = function(a) {
      this.i = a;
    };
    function qa(a, b) {
      a.l = { ma: b, na: true };
      a.h = a.s || a.v;
    }
    oa.prototype.return = function(a) {
      this.l = { return: a };
      this.h = this.v;
    };
    function D(a, b, c) {
      a.h = c;
      return { value: b };
    }
    function ra(a) {
      this.h = new oa;
      this.i = a;
    }
    function sa(a, b) {
      pa(a.h);
      var c = a.h.j;
      if (c)
        return ta(a, "return" in c ? c["return"] : function(d) {
          return { value: d, done: true };
        }, b, a.h.return);
      a.h.return(b);
      return ua(a);
    }
    function ta(a, b, c, d) {
      try {
        var e = b.call(a.h.j, c);
        if (!(e instanceof Object))
          throw new TypeError("Iterator result " + e + " is not an object");
        if (!e.done)
          return a.h.m = false, e;
        var g = e.value;
      } catch (f) {
        return a.h.j = null, qa(a.h, f), ua(a);
      }
      a.h.j = null;
      d.call(a.h, g);
      return ua(a);
    }
    function ua(a) {
      for (;a.h.h; )
        try {
          var b = a.i(a.h);
          if (b)
            return a.h.m = false, { value: b.value, done: false };
        } catch (c) {
          a.h.i = undefined, qa(a.h, c);
        }
      a.h.m = false;
      if (a.h.l) {
        b = a.h.l;
        a.h.l = null;
        if (b.na)
          throw b.ma;
        return { value: b.return, done: true };
      }
      return { value: undefined, done: true };
    }
    function va(a) {
      this.next = function(b) {
        pa(a.h);
        a.h.j ? b = ta(a, a.h.j.next, b, a.h.u) : (a.h.u(b), b = ua(a));
        return b;
      };
      this.throw = function(b) {
        pa(a.h);
        a.h.j ? b = ta(a, a.h.j["throw"], b, a.h.u) : (qa(a.h, b), b = ua(a));
        return b;
      };
      this.return = function(b) {
        return sa(a, b);
      };
      this[Symbol.iterator] = function() {
        return this;
      };
    }
    function wa(a) {
      function b(d) {
        return a.next(d);
      }
      function c(d) {
        return a.throw(d);
      }
      return new Promise(function(d, e) {
        function g(f) {
          f.done ? d(f.value) : Promise.resolve(f.value).then(b, c).then(g, e);
        }
        g(a.next());
      });
    }
    function E(a) {
      return wa(new va(new ra(a)));
    }
    z("Promise", function(a) {
      function b(f) {
        this.i = 0;
        this.j = undefined;
        this.h = [];
        this.u = false;
        var h = this.l();
        try {
          f(h.resolve, h.reject);
        } catch (k) {
          h.reject(k);
        }
      }
      function c() {
        this.h = null;
      }
      function d(f) {
        return f instanceof b ? f : new b(function(h) {
          h(f);
        });
      }
      if (a)
        return a;
      c.prototype.i = function(f) {
        if (this.h == null) {
          this.h = [];
          var h = this;
          this.j(function() {
            h.m();
          });
        }
        this.h.push(f);
      };
      var e = y.setTimeout;
      c.prototype.j = function(f) {
        e(f, 0);
      };
      c.prototype.m = function() {
        for (;this.h && this.h.length; ) {
          var f = this.h;
          this.h = [];
          for (var h = 0;h < f.length; ++h) {
            var k = f[h];
            f[h] = null;
            try {
              k();
            } catch (l) {
              this.l(l);
            }
          }
        }
        this.h = null;
      };
      c.prototype.l = function(f) {
        this.j(function() {
          throw f;
        });
      };
      b.prototype.l = function() {
        function f(l) {
          return function(m) {
            k || (k = true, l.call(h, m));
          };
        }
        var h = this, k = false;
        return { resolve: f(this.I), reject: f(this.m) };
      };
      b.prototype.I = function(f) {
        if (f === this)
          this.m(new TypeError("A Promise cannot resolve to itself"));
        else if (f instanceof b)
          this.L(f);
        else {
          a:
            switch (typeof f) {
              case "object":
                var h = f != null;
                break a;
              case "function":
                h = true;
                break a;
              default:
                h = false;
            }
          h ? this.F(f) : this.s(f);
        }
      };
      b.prototype.F = function(f) {
        var h = undefined;
        try {
          h = f.then;
        } catch (k) {
          this.m(k);
          return;
        }
        typeof h == "function" ? this.M(h, f) : this.s(f);
      };
      b.prototype.m = function(f) {
        this.v(2, f);
      };
      b.prototype.s = function(f) {
        this.v(1, f);
      };
      b.prototype.v = function(f, h) {
        if (this.i != 0)
          throw Error("Cannot settle(" + f + ", " + h + "): Promise already settled in state" + this.i);
        this.i = f;
        this.j = h;
        this.i === 2 && this.K();
        this.H();
      };
      b.prototype.K = function() {
        var f = this;
        e(function() {
          if (f.D()) {
            var h = y.console;
            typeof h !== "undefined" && h.error(f.j);
          }
        }, 1);
      };
      b.prototype.D = function() {
        if (this.u)
          return false;
        var { CustomEvent: f, Event: h, dispatchEvent: k } = y;
        if (typeof k === "undefined")
          return true;
        typeof f === "function" ? f = new f("unhandledrejection", { cancelable: true }) : typeof h === "function" ? f = new h("unhandledrejection", { cancelable: true }) : (f = y.document.createEvent("CustomEvent"), f.initCustomEvent("unhandledrejection", false, true, f));
        f.promise = this;
        f.reason = this.j;
        return k(f);
      };
      b.prototype.H = function() {
        if (this.h != null) {
          for (var f = 0;f < this.h.length; ++f)
            g.i(this.h[f]);
          this.h = null;
        }
      };
      var g = new c;
      b.prototype.L = function(f) {
        var h = this.l();
        f.T(h.resolve, h.reject);
      };
      b.prototype.M = function(f, h) {
        var k = this.l();
        try {
          f.call(h, k.resolve, k.reject);
        } catch (l) {
          k.reject(l);
        }
      };
      b.prototype.then = function(f, h) {
        function k(p, n) {
          return typeof p == "function" ? function(q) {
            try {
              l(p(q));
            } catch (t) {
              m(t);
            }
          } : n;
        }
        var l, m, r = new b(function(p, n) {
          l = p;
          m = n;
        });
        this.T(k(f, l), k(h, m));
        return r;
      };
      b.prototype.catch = function(f) {
        return this.then(undefined, f);
      };
      b.prototype.T = function(f, h) {
        function k() {
          switch (l.i) {
            case 1:
              f(l.j);
              break;
            case 2:
              h(l.j);
              break;
            default:
              throw Error("Unexpected state: " + l.i);
          }
        }
        var l = this;
        this.h == null ? g.i(k) : this.h.push(k);
        this.u = true;
      };
      b.resolve = d;
      b.reject = function(f) {
        return new b(function(h, k) {
          k(f);
        });
      };
      b.race = function(f) {
        return new b(function(h, k) {
          for (var l = A(f), m = l.next();!m.done; m = l.next())
            d(m.value).T(h, k);
        });
      };
      b.all = function(f) {
        var h = A(f), k = h.next();
        return k.done ? d([]) : new b(function(l, m) {
          function r(q) {
            return function(t) {
              p[q] = t;
              n--;
              n == 0 && l(p);
            };
          }
          var p = [], n = 0;
          do
            p.push(undefined), n++, d(k.value).T(r(p.length - 1), m), k = h.next();
          while (!k.done);
        });
      };
      return b;
    });
    function xa(a, b) {
      a instanceof String && (a += "");
      var c = 0, d = false, e = { next: function() {
        if (!d && c < a.length) {
          var g = c++;
          return { value: b(g, a[g]), done: false };
        }
        d = true;
        return { done: true, value: undefined };
      } };
      e[Symbol.iterator] = function() {
        return e;
      };
      return e;
    }
    z("Array.prototype.keys", function(a) {
      return a ? a : function() {
        return xa(this, function(b) {
          return b;
        });
      };
    });
    z("Array.prototype.fill", function(a) {
      return a ? a : function(b, c, d) {
        var e = this.length || 0;
        0 > c && (c = Math.max(0, e + c));
        if (d == null || d > e)
          d = e;
        d = Number(d);
        0 > d && (d = Math.max(0, e + d));
        for (c = Number(c || 0);c < d; c++)
          this[c] = b;
        return this;
      };
    });
    function F(a) {
      return a ? a : Array.prototype.fill;
    }
    z("Int8Array.prototype.fill", F);
    z("Uint8Array.prototype.fill", F);
    z("Uint8ClampedArray.prototype.fill", F);
    z("Int16Array.prototype.fill", F);
    z("Uint16Array.prototype.fill", F);
    z("Int32Array.prototype.fill", F);
    z("Uint32Array.prototype.fill", F);
    z("Float32Array.prototype.fill", F);
    z("Float64Array.prototype.fill", F);
    z("Object.is", function(a) {
      return a ? a : function(b, c) {
        return b === c ? b !== 0 || 1 / b === 1 / c : b !== b && c !== c;
      };
    });
    z("Array.prototype.includes", function(a) {
      return a ? a : function(b, c) {
        var d = this;
        d instanceof String && (d = String(d));
        var e = d.length;
        c = c || 0;
        for (0 > c && (c = Math.max(c + e, 0));c < e; c++) {
          var g = d[c];
          if (g === b || Object.is(g, b))
            return true;
        }
        return false;
      };
    });
    z("String.prototype.includes", function(a) {
      return a ? a : function(b, c) {
        if (this == null)
          throw new TypeError("The 'this' value for String.prototype.includes must not be null or undefined");
        if (b instanceof RegExp)
          throw new TypeError("First argument to String.prototype.includes must not be a regular expression");
        return this.indexOf(b, c || 0) !== -1;
      };
    });
    var ya = this || self;
    function Aa(a, b) {
      a = a.split(".");
      var c = ya;
      a[0] in c || typeof c.execScript == "undefined" || c.execScript("var " + a[0]);
      for (var d;a.length && (d = a.shift()); )
        a.length || b === undefined ? c[d] && c[d] !== Object.prototype[d] ? c = c[d] : c = c[d] = {} : c[d] = b;
    }
    function Ba(a) {
      var b;
      a: {
        if (b = ya.navigator) {
          if (b = b.userAgent)
            break a;
        }
        b = "";
      }
      return b.indexOf(a) != -1;
    }
    var Ca = Array.prototype.map ? function(a, b) {
      return Array.prototype.map.call(a, b, undefined);
    } : function(a, b) {
      for (var c = a.length, d = Array(c), e = typeof a === "string" ? a.split("") : a, g = 0;g < c; g++)
        g in e && (d[g] = b.call(undefined, e[g], g, a));
      return d;
    };
    var Da = {}, Ea = null;
    function Fa(a) {
      var b = a.length, c = 3 * b / 4;
      c % 3 ? c = Math.floor(c) : "=.".indexOf(a[b - 1]) != -1 && (c = "=.".indexOf(a[b - 2]) != -1 ? c - 2 : c - 1);
      var d = new Uint8Array(c), e = 0;
      Ga(a, function(g) {
        d[e++] = g;
      });
      return e !== c ? d.subarray(0, e) : d;
    }
    function Ga(a, b) {
      function c(k) {
        for (;d < a.length; ) {
          var l = a.charAt(d++), m = Ea[l];
          if (m != null)
            return m;
          if (!/^[\s\xa0]*$/.test(l))
            throw Error("Unknown base64 encoding at char: " + l);
        }
        return k;
      }
      Ha();
      for (var d = 0;; ) {
        var e = c(-1), g = c(0), f = c(64), h = c(64);
        if (h === 64 && e === -1)
          break;
        b(e << 2 | g >> 4);
        f != 64 && (b(g << 4 & 240 | f >> 2), h != 64 && b(f << 6 & 192 | h));
      }
    }
    function Ha() {
      if (!Ea) {
        Ea = {};
        for (var a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".split(""), b = ["+/=", "+/", "-_=", "-_.", "-_"], c = 0;5 > c; c++) {
          var d = a.concat(b[c].split(""));
          Da[c] = d;
          for (var e = 0;e < d.length; e++) {
            var g = d[e];
            Ea[g] === undefined && (Ea[g] = e);
          }
        }
      }
    }
    var Ia = typeof Uint8Array !== "undefined", Ja = !(Ba("Trident") || Ba("MSIE")) && typeof ya.btoa === "function";
    function Ka(a) {
      if (!Ja) {
        var b;
        b === undefined && (b = 0);
        Ha();
        b = Da[b];
        for (var c = Array(Math.floor(a.length / 3)), d = b[64] || "", e = 0, g = 0;e < a.length - 2; e += 3) {
          var f = a[e], h = a[e + 1], k = a[e + 2], l = b[f >> 2];
          f = b[(f & 3) << 4 | h >> 4];
          h = b[(h & 15) << 2 | k >> 6];
          k = b[k & 63];
          c[g++] = l + f + h + k;
        }
        l = 0;
        k = d;
        switch (a.length - e) {
          case 2:
            l = a[e + 1], k = b[(l & 15) << 2] || d;
          case 1:
            a = a[e], c[g] = b[a >> 2] + b[(a & 3) << 4 | l >> 4] + k + d;
        }
        return c.join("");
      }
      for (b = "";10240 < a.length; )
        b += String.fromCharCode.apply(null, a.subarray(0, 10240)), a = a.subarray(10240);
      b += String.fromCharCode.apply(null, a);
      return btoa(b);
    }
    var La = RegExp("[-_.]", "g");
    function Ma(a) {
      switch (a) {
        case "-":
          return "+";
        case "_":
          return "/";
        case ".":
          return "=";
        default:
          return "";
      }
    }
    function Na(a) {
      if (!Ja)
        return Fa(a);
      La.test(a) && (a = a.replace(La, Ma));
      a = atob(a);
      for (var b = new Uint8Array(a.length), c = 0;c < a.length; c++)
        b[c] = a.charCodeAt(c);
      return b;
    }
    var Oa;
    function Pa() {
      return Oa || (Oa = new Uint8Array(0));
    }
    var Qa = {};
    var Ra = typeof Uint8Array.prototype.slice === "function", G = 0, H = 0;
    function Sa(a) {
      var b = 0 > a;
      a = Math.abs(a);
      var c = a >>> 0;
      a = Math.floor((a - c) / 4294967296);
      b && (c = A(Ta(c, a)), b = c.next().value, a = c.next().value, c = b);
      G = c >>> 0;
      H = a >>> 0;
    }
    var Ua = typeof BigInt === "function";
    function Ta(a, b) {
      b = ~b;
      a ? a = ~a + 1 : b += 1;
      return [a, b];
    }
    function Va(a, b) {
      this.i = a >>> 0;
      this.h = b >>> 0;
    }
    function Wa(a) {
      if (!a)
        return Xa || (Xa = new Va(0, 0));
      if (!/^-?\d+$/.test(a))
        return null;
      if (16 > a.length)
        Sa(Number(a));
      else if (Ua)
        a = BigInt(a), G = Number(a & BigInt(4294967295)) >>> 0, H = Number(a >> BigInt(32) & BigInt(4294967295));
      else {
        var b = +(a[0] === "-");
        H = G = 0;
        for (var c = a.length, d = b, e = (c - b) % 6 + b;e <= c; d = e, e += 6)
          d = Number(a.slice(d, e)), H *= 1e6, G = 1e6 * G + d, 4294967296 <= G && (H += G / 4294967296 | 0, G %= 4294967296);
        b && (b = A(Ta(G, H)), a = b.next().value, b = b.next().value, G = a, H = b);
      }
      return new Va(G, H);
    }
    var Xa;
    function Ya(a, b) {
      return Error("Invalid wire type: " + a + " (at position " + b + ")");
    }
    function Za() {
      return Error("Failed to read varint, encoding is invalid.");
    }
    function $a(a, b) {
      return Error("Tried to read past the end of the data " + b + " > " + a);
    }
    function K() {
      throw Error("Invalid UTF8");
    }
    function ab(a, b) {
      b = String.fromCharCode.apply(null, b);
      return a == null ? b : a + b;
    }
    var bb = undefined, cb, db = typeof TextDecoder !== "undefined", eb, fb = typeof TextEncoder !== "undefined";
    var gb;
    function hb(a) {
      if (a !== Qa)
        throw Error("illegal external caller");
    }
    function ib(a, b) {
      hb(b);
      this.V = a;
      if (a != null && a.length === 0)
        throw Error("ByteString should be constructed with non-empty values");
    }
    function jb() {
      return gb || (gb = new ib(null, Qa));
    }
    function kb(a) {
      hb(Qa);
      var b = a.V;
      b = b == null || Ia && b != null && b instanceof Uint8Array ? b : typeof b === "string" ? Na(b) : null;
      return b == null ? b : a.V = b;
    }
    function lb(a) {
      if (typeof a === "string")
        return { buffer: Na(a), C: false };
      if (Array.isArray(a))
        return { buffer: new Uint8Array(a), C: false };
      if (a.constructor === Uint8Array)
        return { buffer: a, C: false };
      if (a.constructor === ArrayBuffer)
        return { buffer: new Uint8Array(a), C: false };
      if (a.constructor === ib)
        return { buffer: kb(a) || Pa(), C: true };
      if (a instanceof Uint8Array)
        return { buffer: new Uint8Array(a.buffer, a.byteOffset, a.byteLength), C: false };
      throw Error("Type not convertible to a Uint8Array, expected a Uint8Array, an ArrayBuffer, a base64 encoded string, a ByteString or an Array of numbers");
    }
    function mb(a, b) {
      this.i = null;
      this.m = false;
      this.h = this.j = this.l = 0;
      nb(this, a, b);
    }
    function nb(a, b, c) {
      c = c === undefined ? {} : c;
      a.S = c.S === undefined ? false : c.S;
      b && (b = lb(b), a.i = b.buffer, a.m = b.C, a.l = 0, a.j = a.i.length, a.h = a.l);
    }
    mb.prototype.reset = function() {
      this.h = this.l;
    };
    function L(a, b) {
      a.h = b;
      if (b > a.j)
        throw $a(a.j, b);
    }
    function ob(a) {
      var { i: b, h: c } = a, d = b[c++], e = d & 127;
      if (d & 128 && (d = b[c++], e |= (d & 127) << 7, d & 128 && (d = b[c++], e |= (d & 127) << 14, d & 128 && (d = b[c++], e |= (d & 127) << 21, d & 128 && (d = b[c++], e |= d << 28, d & 128 && b[c++] & 128 && b[c++] & 128 && b[c++] & 128 && b[c++] & 128 && b[c++] & 128)))))
        throw Za();
      L(a, c);
      return e;
    }
    function pb(a, b) {
      if (0 > b)
        throw Error("Tried to read a negative byte length: " + b);
      var c = a.h, d = c + b;
      if (d > a.j)
        throw $a(b, a.j - c);
      a.h = d;
      return c;
    }
    var qb = [];
    function rb() {
      this.h = [];
    }
    rb.prototype.length = function() {
      return this.h.length;
    };
    rb.prototype.end = function() {
      var a = this.h;
      this.h = [];
      return a;
    };
    function sb(a, b, c) {
      for (;0 < c || 127 < b; )
        a.h.push(b & 127 | 128), b = (b >>> 7 | c << 25) >>> 0, c >>>= 7;
      a.h.push(b);
    }
    function M(a, b) {
      for (;127 < b; )
        a.h.push(b & 127 | 128), b >>>= 7;
      a.h.push(b);
    }
    function tb(a, b) {
      if (qb.length) {
        var c = qb.pop();
        nb(c, a, b);
        a = c;
      } else
        a = new mb(a, b);
      this.h = a;
      this.j = this.h.h;
      this.i = this.l = -1;
      this.setOptions(b);
    }
    tb.prototype.setOptions = function(a) {
      a = a === undefined ? {} : a;
      this.ca = a.ca === undefined ? false : a.ca;
    };
    tb.prototype.reset = function() {
      this.h.reset();
      this.j = this.h.h;
      this.i = this.l = -1;
    };
    function ub(a) {
      var b = a.h;
      if (b.h == b.j)
        return false;
      a.j = a.h.h;
      var c = ob(a.h) >>> 0;
      b = c >>> 3;
      c &= 7;
      if (!(0 <= c && 5 >= c))
        throw Ya(c, a.j);
      if (1 > b)
        throw Error("Invalid field number: " + b + " (at position " + a.j + ")");
      a.l = b;
      a.i = c;
      return true;
    }
    function vb(a) {
      switch (a.i) {
        case 0:
          if (a.i != 0)
            vb(a);
          else
            a: {
              a = a.h;
              for (var b = a.h, c = b + 10, d = a.i;b < c; )
                if ((d[b++] & 128) === 0) {
                  L(a, b);
                  break a;
                }
              throw Za();
            }
          break;
        case 1:
          a = a.h;
          L(a, a.h + 8);
          break;
        case 2:
          a.i != 2 ? vb(a) : (b = ob(a.h) >>> 0, a = a.h, L(a, a.h + b));
          break;
        case 5:
          a = a.h;
          L(a, a.h + 4);
          break;
        case 3:
          b = a.l;
          do {
            if (!ub(a))
              throw Error("Unmatched start-group tag: stream EOF");
            if (a.i == 4) {
              if (a.l != b)
                throw Error("Unmatched end-group tag");
              break;
            }
            vb(a);
          } while (1);
          break;
        default:
          throw Ya(a.i, a.j);
      }
    }
    var wb = [];
    function xb() {
      this.j = [];
      this.i = 0;
      this.h = new rb;
    }
    function N(a, b) {
      b.length !== 0 && (a.j.push(b), a.i += b.length);
    }
    function yb(a, b) {
      if (b = b.R) {
        N(a, a.h.end());
        for (var c = 0;c < b.length; c++)
          N(a, kb(b[c]) || Pa());
      }
    }
    var O = typeof Symbol === "function" && typeof Symbol() === "symbol" ? Symbol() : undefined;
    function P(a, b) {
      if (O)
        return a[O] |= b;
      if (a.A !== undefined)
        return a.A |= b;
      Object.defineProperties(a, { A: { value: b, configurable: true, writable: true, enumerable: false } });
      return b;
    }
    function zb(a, b) {
      O ? a[O] && (a[O] &= ~b) : a.A !== undefined && (a.A &= ~b);
    }
    function Q(a) {
      var b;
      O ? b = a[O] : b = a.A;
      return b == null ? 0 : b;
    }
    function R(a, b) {
      O ? a[O] = b : a.A !== undefined ? a.A = b : Object.defineProperties(a, { A: { value: b, configurable: true, writable: true, enumerable: false } });
    }
    function Ab(a) {
      P(a, 1);
      return a;
    }
    function Bb(a, b) {
      R(b, (a | 0) & -51);
    }
    function Cb(a, b) {
      R(b, (a | 18) & -41);
    }
    var Db = {};
    function Eb(a) {
      return a !== null && typeof a === "object" && !Array.isArray(a) && a.constructor === Object;
    }
    var Fb, Gb = [];
    R(Gb, 23);
    Fb = Object.freeze(Gb);
    function Hb(a) {
      if (Q(a.o) & 2)
        throw Error("Cannot mutate an immutable Message");
    }
    function Ib(a) {
      var b = a.length;
      (b = b ? a[b - 1] : undefined) && Eb(b) ? b.g = 1 : (b = {}, a.push((b.g = 1, b)));
    }
    function Jb(a) {
      var b = a.i + a.G;
      return a.B || (a.B = a.o[b] = {});
    }
    function S(a, b) {
      return b === -1 ? null : b >= a.i ? a.B ? a.B[b] : undefined : a.o[b + a.G];
    }
    function U(a, b, c, d) {
      Hb(a);
      Kb(a, b, c, d);
    }
    function Kb(a, b, c, d) {
      a.j && (a.j = undefined);
      b >= a.i || d ? Jb(a)[b] = c : (a.o[b + a.G] = c, (a = a.B) && (b in a) && delete a[b]);
    }
    function Lb(a, b, c, d) {
      var e = S(a, b);
      Array.isArray(e) || (e = Fb);
      var g = Q(e);
      g & 1 || Ab(e);
      if (d)
        g & 2 || P(e, 2), c & 1 || Object.freeze(e);
      else {
        d = !(c & 2);
        var f = g & 2;
        c & 1 || !f ? d && g & 16 && !f && zb(e, 16) : (e = Ab(Array.prototype.slice.call(e)), Kb(a, b, e));
      }
      return e;
    }
    function Mb(a, b) {
      var c = S(a, b);
      var d = c == null ? c : typeof c === "number" || c === "NaN" || c === "Infinity" || c === "-Infinity" ? Number(c) : undefined;
      d != null && d !== c && Kb(a, b, d);
      return d;
    }
    function Nb(a, b, c, d, e) {
      a.h || (a.h = {});
      var g = a.h[c], f = Lb(a, c, 3, e);
      if (!g) {
        var h = f;
        g = [];
        var k = !!(Q(a.o) & 16);
        f = !!(Q(h) & 2);
        var l = h;
        !e && f && (h = Array.prototype.slice.call(h));
        for (var m = f, r = 0;r < h.length; r++) {
          var p = h[r];
          var n = b, q = false;
          q = q === undefined ? false : q;
          p = Array.isArray(p) ? new n(p) : q ? new n : undefined;
          if (p !== undefined) {
            n = p.o;
            var t = q = Q(n);
            f && (t |= 2);
            k && (t |= 16);
            t != q && R(n, t);
            n = t;
            m = m || !!(2 & n);
            g.push(p);
          }
        }
        a.h[c] = g;
        k = Q(h);
        b = k | 33;
        b = m ? b & -9 : b | 8;
        k != b && (m = h, Object.isFrozen(m) && (m = Array.prototype.slice.call(m)), R(m, b), h = m);
        l !== h && Kb(a, c, h);
        (e || d && f) && P(g, 2);
        d && Object.freeze(g);
        return g;
      }
      e || (e = Object.isFrozen(g), d && !e ? Object.freeze(g) : !d && e && (g = Array.prototype.slice.call(g), a.h[c] = g));
      return g;
    }
    function Ob(a, b, c) {
      var d = !!(Q(a.o) & 2);
      b = Nb(a, b, c, d, d);
      a = Lb(a, c, 3, d);
      if (!(d || Q(a) & 8)) {
        for (d = 0;d < b.length; d++) {
          c = b[d];
          if (Q(c.o) & 2) {
            var e = Pb(c, false);
            e.j = c;
          } else
            e = c;
          c !== e && (b[d] = e, a[d] = e.o);
        }
        P(a, 8);
      }
      return b;
    }
    function V(a, b, c) {
      if (c != null && typeof c !== "number")
        throw Error("Value of float/double field must be a number|null|undefined, found " + typeof c + ": " + c);
      U(a, b, c);
    }
    function Qb(a, b, c, d, e) {
      Hb(a);
      var g = Nb(a, c, b, false, false);
      c = d != null ? d : new c;
      a = Lb(a, b, 2, false);
      e != null ? (g.splice(e, 0, c), a.splice(e, 0, c.o)) : (g.push(c), a.push(c.o));
      c.C() && zb(a, 8);
      return c;
    }
    function Rb(a, b) {
      return a == null ? b : a;
    }
    function W(a, b, c) {
      c = c === undefined ? 0 : c;
      return Rb(Mb(a, b), c);
    }
    var Sb;
    function Tb(a) {
      switch (typeof a) {
        case "number":
          return isFinite(a) ? a : String(a);
        case "object":
          if (a)
            if (Array.isArray(a)) {
              if ((Q(a) & 128) !== 0)
                return a = Array.prototype.slice.call(a), Ib(a), a;
            } else {
              if (Ia && a != null && a instanceof Uint8Array)
                return Ka(a);
              if (a instanceof ib) {
                var b = a.V;
                return b == null ? "" : typeof b === "string" ? b : a.V = Ka(b);
              }
            }
      }
      return a;
    }
    function Ub(a, b, c, d) {
      if (a != null) {
        if (Array.isArray(a))
          a = Vb(a, b, c, d !== undefined);
        else if (Eb(a)) {
          var e = {}, g;
          for (g in a)
            e[g] = Ub(a[g], b, c, d);
          a = e;
        } else
          a = b(a, d);
        return a;
      }
    }
    function Vb(a, b, c, d) {
      var e = Q(a);
      d = d ? !!(e & 16) : undefined;
      a = Array.prototype.slice.call(a);
      for (var g = 0;g < a.length; g++)
        a[g] = Ub(a[g], b, c, d);
      c(e, a);
      return a;
    }
    function Wb(a) {
      return a.ja === Db ? a.toJSON() : Tb(a);
    }
    function Xb(a, b) {
      a & 128 && Ib(b);
    }
    function Yb(a, b, c) {
      c = c === undefined ? Cb : c;
      if (a != null) {
        if (Ia && a instanceof Uint8Array)
          return a.length ? new ib(new Uint8Array(a), Qa) : jb();
        if (Array.isArray(a)) {
          var d = Q(a);
          if (d & 2)
            return a;
          if (b && !(d & 32) && (d & 16 || d === 0))
            return R(a, d | 2), a;
          a = Vb(a, Yb, d & 4 ? Cb : c, true);
          b = Q(a);
          b & 4 && b & 2 && Object.freeze(a);
          return a;
        }
        return a.ja === Db ? Zb(a) : a;
      }
    }
    function $b(a, b, c, d, e, g, f) {
      if (a = a.h && a.h[c]) {
        d = Q(a);
        d & 2 ? d = a : (g = Ca(a, Zb), Cb(d, g), Object.freeze(g), d = g);
        Hb(b);
        f = d == null ? Fb : Ab([]);
        if (d != null) {
          g = !!d.length;
          for (a = 0;a < d.length; a++) {
            var h = d[a];
            g = g && !(Q(h.o) & 2);
            f[a] = h.o;
          }
          g = (g ? 8 : 0) | 1;
          a = Q(f);
          (a & g) !== g && (Object.isFrozen(f) && (f = Array.prototype.slice.call(f)), R(f, a | g));
          b.h || (b.h = {});
          b.h[c] = d;
        } else
          b.h && (b.h[c] = undefined);
        Kb(b, c, f, e);
      } else
        U(b, c, Yb(d, g, f), e);
    }
    function Zb(a) {
      if (Q(a.o) & 2)
        return a;
      a = Pb(a, true);
      P(a.o, 2);
      return a;
    }
    function Pb(a, b) {
      var c = a.o, d = [];
      P(d, 16);
      var e = a.constructor.h;
      e && d.push(e);
      e = a.B;
      if (e) {
        d.length = c.length;
        d.fill(undefined, d.length, c.length);
        var g = {};
        d[d.length - 1] = g;
      }
      (Q(c) & 128) !== 0 && Ib(d);
      b = b || a.C() ? Cb : Bb;
      g = a.constructor;
      Sb = d;
      d = new g(d);
      Sb = undefined;
      a.R && (d.R = a.R.slice());
      g = !!(Q(c) & 16);
      for (var f = e ? c.length - 1 : c.length, h = 0;h < f; h++)
        $b(a, d, h - a.G, c[h], false, g, b);
      if (e)
        for (var k in e)
          $b(a, d, +k, e[k], true, g, b);
      return d;
    }
    function X(a, b, c) {
      a == null && (a = Sb);
      Sb = undefined;
      var d = this.constructor.i || 0, e = 0 < d, g = this.constructor.h, f = false;
      if (a == null) {
        a = g ? [g] : [];
        var h = 48;
        var k = true;
        e && (d = 0, h |= 128);
        R(a, h);
      } else {
        if (!Array.isArray(a))
          throw Error();
        if (g && g !== a[0])
          throw Error();
        var l = h = P(a, 0);
        if (k = (16 & l) !== 0)
          (f = (32 & l) !== 0) || (l |= 32);
        if (e)
          if (128 & l)
            d = 0;
          else {
            if (0 < a.length) {
              var m = a[a.length - 1];
              if (Eb(m) && "g" in m) {
                d = 0;
                l |= 128;
                delete m.g;
                var r = true, p;
                for (p in m) {
                  r = false;
                  break;
                }
                r && a.pop();
              }
            }
          }
        else if (128 & l)
          throw Error();
        h !== l && R(a, l);
      }
      this.G = (g ? 0 : -1) - d;
      this.h = undefined;
      this.o = a;
      a: {
        g = this.o.length;
        d = g - 1;
        if (g && (g = this.o[d], Eb(g))) {
          this.B = g;
          this.i = d - this.G;
          break a;
        }
        b !== undefined && -1 < b ? (this.i = Math.max(b, d + 1 - this.G), this.B = undefined) : this.i = Number.MAX_VALUE;
      }
      if (!e && this.B && "g" in this.B)
        throw Error('Unexpected "g" flag in sparse object of message that is not a group type.');
      if (c) {
        b = k && !f && true;
        e = this.i;
        var n;
        for (k = 0;k < c.length; k++)
          f = c[k], f < e ? (f += this.G, (d = a[f]) ? ac(d, b) : a[f] = Fb) : (n || (n = Jb(this)), (d = n[f]) ? ac(d, b) : n[f] = Fb);
      }
    }
    X.prototype.toJSON = function() {
      return Vb(this.o, Wb, Xb);
    };
    X.prototype.C = function() {
      return !!(Q(this.o) & 2);
    };
    function ac(a, b) {
      if (Array.isArray(a)) {
        var c = Q(a), d = 1;
        !b || c & 2 || (d |= 16);
        (c & d) !== d && R(a, c | d);
      }
    }
    X.prototype.ja = Db;
    X.prototype.toString = function() {
      return this.o.toString();
    };
    function bc(a, b, c) {
      if (c) {
        var d = {}, e;
        for (e in c) {
          var g = c[e], f = g.ra;
          f || (d.J = g.xa || g.oa.W, g.ia ? (d.aa = cc(g.ia), f = function(h) {
            return function(k, l, m) {
              return h.J(k, l, m, h.aa);
            };
          }(d)) : g.ka ? (d.Z = dc(g.da.P, g.ka), f = function(h) {
            return function(k, l, m) {
              return h.J(k, l, m, h.Z);
            };
          }(d)) : f = d.J, g.ra = f);
          f(b, a, g.da);
          d = { J: d.J, aa: d.aa, Z: d.Z };
        }
      }
      yb(b, a);
    }
    var ec = Symbol();
    function fc(a, b, c) {
      return a[ec] || (a[ec] = function(d, e) {
        return b(d, e, c);
      });
    }
    function gc(a) {
      var b = a[ec];
      if (!b) {
        var c = hc(a);
        b = function(d, e) {
          return ic(d, e, c);
        };
        a[ec] = b;
      }
      return b;
    }
    function jc(a) {
      var b = a.ia;
      if (b)
        return gc(b);
      if (b = a.wa)
        return fc(a.da.P, b, a.ka);
    }
    function kc(a) {
      var b = jc(a), c = a.da, d = a.oa.U;
      return b ? function(e, g) {
        return d(e, g, c, b);
      } : function(e, g) {
        return d(e, g, c);
      };
    }
    function lc(a, b) {
      var c = a[b];
      typeof c == "function" && c.length === 0 && (c = c(), a[b] = c);
      return Array.isArray(c) && ((mc in c) || (nc in c) || 0 < c.length && typeof c[0] == "function") ? c : undefined;
    }
    function oc(a, b, c, d, e, g) {
      b.P = a[0];
      var f = 1;
      if (a.length > f && typeof a[f] !== "number") {
        var h = a[f++];
        c(b, h);
      }
      for (;f < a.length; ) {
        c = a[f++];
        for (var k = f + 1;k < a.length && typeof a[k] !== "number"; )
          k++;
        h = a[f++];
        k -= f;
        switch (k) {
          case 0:
            d(b, c, h);
            break;
          case 1:
            (k = lc(a, f)) ? (f++, e(b, c, h, k)) : d(b, c, h, a[f++]);
            break;
          case 2:
            k = f++;
            k = lc(a, k);
            e(b, c, h, k, a[f++]);
            break;
          case 3:
            g(b, c, h, a[f++], a[f++], a[f++]);
            break;
          case 4:
            g(b, c, h, a[f++], a[f++], a[f++], a[f++]);
            break;
          default:
            throw Error("unexpected number of binary field arguments: " + k);
        }
      }
      return b;
    }
    var pc = Symbol();
    function cc(a) {
      var b = a[pc];
      if (!b) {
        var c = qc(a);
        b = function(d, e) {
          return rc(d, e, c);
        };
        a[pc] = b;
      }
      return b;
    }
    function dc(a, b) {
      var c = a[pc];
      c || (c = function(d, e) {
        return bc(d, e, b);
      }, a[pc] = c);
      return c;
    }
    var nc = Symbol();
    function sc(a, b) {
      a.push(b);
    }
    function tc(a, b, c) {
      a.push(b, c.W);
    }
    function uc(a, b, c, d) {
      var e = cc(d), g = qc(d).P, f = c.W;
      a.push(b, function(h, k, l) {
        return f(h, k, l, g, e);
      });
    }
    function vc(a, b, c, d, e, g) {
      var f = dc(d, g), h = c.W;
      a.push(b, function(k, l, m) {
        return h(k, l, m, d, f);
      });
    }
    function qc(a) {
      var b = a[nc];
      if (b)
        return b;
      b = oc(a, a[nc] = [], sc, tc, uc, vc);
      mc in a && nc in a && (a.length = 0);
      return b;
    }
    var mc = Symbol();
    function wc(a, b) {
      a[0] = b;
    }
    function xc(a, b, c, d) {
      var e = c.U;
      a[b] = d ? function(g, f, h) {
        return e(g, f, h, d);
      } : e;
    }
    function yc(a, b, c, d, e) {
      var g = c.U, f = gc(d), h = hc(d).P;
      a[b] = function(k, l, m) {
        return g(k, l, m, h, f, e);
      };
    }
    function zc(a, b, c, d, e, g, f) {
      var h = c.U, k = fc(d, e, g);
      a[b] = function(l, m, r) {
        return h(l, m, r, d, k, f);
      };
    }
    function hc(a) {
      var b = a[mc];
      if (b)
        return b;
      b = oc(a, a[mc] = {}, wc, xc, yc, zc);
      mc in a && nc in a && (a.length = 0);
      return b;
    }
    function ic(a, b, c) {
      for (;ub(b) && b.i != 4; ) {
        var d = b.l, e = c[d];
        if (!e) {
          var g = c[0];
          g && (g = g[d]) && (e = c[d] = kc(g));
        }
        if (!e || !e(b, a, d)) {
          e = b;
          d = a;
          g = e.j;
          vb(e);
          var f = e;
          if (!f.ca) {
            e = f.h.h - g;
            f.h.h = g;
            f = f.h;
            if (e == 0)
              e = jb();
            else {
              g = pb(f, e);
              if (f.S && f.m)
                e = f.i.subarray(g, g + e);
              else {
                f = f.i;
                var h = g;
                e = g + e;
                e = h === e ? Pa() : Ra ? f.slice(h, e) : new Uint8Array(f.subarray(h, e));
              }
              e = e.length == 0 ? jb() : new ib(e, Qa);
            }
            (g = d.R) ? g.push(e) : d.R = [e];
          }
        }
      }
      return a;
    }
    function rc(a, b, c) {
      for (var d = c.length, e = d % 2 == 1, g = e ? 1 : 0;g < d; g += 2)
        (0, c[g + 1])(b, a, c[g]);
      bc(a, b, e ? c[0] : undefined);
    }
    function Ac(a, b) {
      return { U: a, W: b };
    }
    var Y = Ac(function(a, b, c) {
      if (a.i !== 5)
        return false;
      a = a.h;
      var d = a.i, e = a.h, g = d[e];
      var f = d[e + 1];
      var h = d[e + 2];
      d = d[e + 3];
      L(a, a.h + 4);
      f = (g << 0 | f << 8 | h << 16 | d << 24) >>> 0;
      a = 2 * (f >> 31) + 1;
      g = f >>> 23 & 255;
      f &= 8388607;
      U(b, c, g == 255 ? f ? NaN : Infinity * a : g == 0 ? a * Math.pow(2, -149) * f : a * Math.pow(2, g - 150) * (f + Math.pow(2, 23)));
      return true;
    }, function(a, b, c) {
      b = Mb(b, c);
      if (b != null) {
        M(a.h, 8 * c + 5);
        a = a.h;
        var d = +b;
        d === 0 ? 0 < 1 / d ? G = H = 0 : (H = 0, G = 2147483648) : isNaN(d) ? (H = 0, G = 2147483647) : (d = (c = 0 > d ? -2147483648 : 0) ? -d : d, 340282346638528860000000000000000000000 < d ? (H = 0, G = (c | 2139095040) >>> 0) : 0.000000000000000000000000000000000000011754943508222875 > d ? (d = Math.round(d / Math.pow(2, -149)), H = 0, G = (c | d) >>> 0) : (b = Math.floor(Math.log(d) / Math.LN2), d *= Math.pow(2, -b), d = Math.round(8388608 * d), 16777216 <= d && ++b, H = 0, G = (c | b + 127 << 23 | d & 8388607) >>> 0));
        c = G;
        a.h.push(c >>> 0 & 255);
        a.h.push(c >>> 8 & 255);
        a.h.push(c >>> 16 & 255);
        a.h.push(c >>> 24 & 255);
      }
    }), Bc = Ac(function(a, b, c) {
      if (a.i !== 0)
        return false;
      var d = a.h, e = 0, g = a = 0, f = d.i, h = d.h;
      do {
        var k = f[h++];
        e |= (k & 127) << g;
        g += 7;
      } while (32 > g && k & 128);
      32 < g && (a |= (k & 127) >> 4);
      for (g = 3;32 > g && k & 128; g += 7)
        k = f[h++], a |= (k & 127) << g;
      L(d, h);
      if (128 > k) {
        d = e >>> 0;
        k = a >>> 0;
        if (a = k & 2147483648)
          d = ~d + 1 >>> 0, k = ~k >>> 0, d == 0 && (k = k + 1 >>> 0);
        d = 4294967296 * k + (d >>> 0);
      } else
        throw Za();
      U(b, c, a ? -d : d);
      return true;
    }, function(a, b, c) {
      b = S(b, c);
      b != null && (typeof b === "string" && Wa(b), b != null && (M(a.h, 8 * c), typeof b === "number" ? (a = a.h, Sa(b), sb(a, G, H)) : (c = Wa(b), sb(a.h, c.i, c.h))));
    }), Cc = Ac(function(a, b, c) {
      if (a.i !== 0)
        return false;
      U(b, c, ob(a.h));
      return true;
    }, function(a, b, c) {
      b = S(b, c);
      if (b != null && b != null)
        if (M(a.h, 8 * c), a = a.h, c = b, 0 <= c)
          M(a, c);
        else {
          for (b = 0;9 > b; b++)
            a.h.push(c & 127 | 128), c >>= 7;
          a.h.push(1);
        }
    }), Dc = Ac(function(a, b, c) {
      if (a.i !== 2)
        return false;
      var d = ob(a.h) >>> 0;
      a = a.h;
      var e = pb(a, d);
      a = a.i;
      if (db) {
        var g = a, f;
        (f = cb) || (f = cb = new TextDecoder("utf-8", { fatal: true }));
        a = e + d;
        g = e === 0 && a === g.length ? g : g.subarray(e, a);
        try {
          var h = f.decode(g);
        } catch (r) {
          if (bb === undefined) {
            try {
              f.decode(new Uint8Array([128]));
            } catch (p) {}
            try {
              f.decode(new Uint8Array([97])), bb = true;
            } catch (p) {
              bb = false;
            }
          }
          !bb && (cb = undefined);
          throw r;
        }
      } else {
        h = e;
        d = h + d;
        e = [];
        for (var k = null, l, m;h < d; )
          l = a[h++], 128 > l ? e.push(l) : 224 > l ? h >= d ? K() : (m = a[h++], 194 > l || (m & 192) !== 128 ? (h--, K()) : e.push((l & 31) << 6 | m & 63)) : 240 > l ? h >= d - 1 ? K() : (m = a[h++], (m & 192) !== 128 || l === 224 && 160 > m || l === 237 && 160 <= m || ((g = a[h++]) & 192) !== 128 ? (h--, K()) : e.push((l & 15) << 12 | (m & 63) << 6 | g & 63)) : 244 >= l ? h >= d - 2 ? K() : (m = a[h++], (m & 192) !== 128 || (l << 28) + (m - 144) >> 30 !== 0 || ((g = a[h++]) & 192) !== 128 || ((f = a[h++]) & 192) !== 128 ? (h--, K()) : (l = (l & 7) << 18 | (m & 63) << 12 | (g & 63) << 6 | f & 63, l -= 65536, e.push((l >> 10 & 1023) + 55296, (l & 1023) + 56320))) : K(), 8192 <= e.length && (k = ab(k, e), e.length = 0);
        h = ab(k, e);
      }
      U(b, c, h);
      return true;
    }, function(a, b, c) {
      b = S(b, c);
      if (b != null) {
        var d = false;
        d = d === undefined ? false : d;
        if (fb) {
          if (d && /(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(b))
            throw Error("Found an unpaired surrogate");
          b = (eb || (eb = new TextEncoder)).encode(b);
        } else {
          for (var e = 0, g = new Uint8Array(3 * b.length), f = 0;f < b.length; f++) {
            var h = b.charCodeAt(f);
            if (128 > h)
              g[e++] = h;
            else {
              if (2048 > h)
                g[e++] = h >> 6 | 192;
              else {
                if (55296 <= h && 57343 >= h) {
                  if (56319 >= h && f < b.length) {
                    var k = b.charCodeAt(++f);
                    if (56320 <= k && 57343 >= k) {
                      h = 1024 * (h - 55296) + k - 56320 + 65536;
                      g[e++] = h >> 18 | 240;
                      g[e++] = h >> 12 & 63 | 128;
                      g[e++] = h >> 6 & 63 | 128;
                      g[e++] = h & 63 | 128;
                      continue;
                    } else
                      f--;
                  }
                  if (d)
                    throw Error("Found an unpaired surrogate");
                  h = 65533;
                }
                g[e++] = h >> 12 | 224;
                g[e++] = h >> 6 & 63 | 128;
              }
              g[e++] = h & 63 | 128;
            }
          }
          b = e === g.length ? g : g.subarray(0, e);
        }
        M(a.h, 8 * c + 2);
        M(a.h, b.length);
        N(a, a.h.end());
        N(a, b);
      }
    }), Ec = Ac(function(a, b, c, d, e) {
      if (a.i !== 2)
        return false;
      b = Qb(b, c, d);
      c = a.h.j;
      d = ob(a.h) >>> 0;
      var g = a.h.h + d, f = g - c;
      0 >= f && (a.h.j = g, e(b, a, undefined, undefined, undefined), f = g - a.h.h);
      if (f)
        throw Error("Message parsing ended unexpectedly. Expected to read " + (d + " bytes, instead read " + (d - f) + " bytes, either the data ended unexpectedly or the message misreported its own length"));
      a.h.h = g;
      a.h.j = c;
      return true;
    }, function(a, b, c, d, e) {
      b = Ob(b, d, c);
      if (b != null)
        for (d = 0;d < b.length; d++) {
          var g = a;
          M(g.h, 8 * c + 2);
          var f = g.h.end();
          N(g, f);
          f.push(g.i);
          g = f;
          e(b[d], a);
          f = a;
          var h = g.pop();
          for (h = f.i + f.h.length() - h;127 < h; )
            g.push(h & 127 | 128), h >>>= 7, f.i++;
          g.push(h);
          f.i++;
        }
    });
    function Fc(a) {
      return function(b, c) {
        a: {
          if (wb.length) {
            var d = wb.pop();
            d.setOptions(c);
            nb(d.h, b, c);
            b = d;
          } else
            b = new tb(b, c);
          try {
            var e = hc(a);
            var g = ic(new e.P, b, e);
            break a;
          } finally {
            e = b.h, e.i = null, e.m = false, e.l = 0, e.j = 0, e.h = 0, e.S = false, b.l = -1, b.i = -1, 100 > wb.length && wb.push(b);
          }
          g = undefined;
        }
        return g;
      };
    }
    function Gc(a) {
      return function() {
        var b = new xb;
        rc(this, b, qc(a));
        N(b, b.h.end());
        for (var c = new Uint8Array(b.i), d = b.j, e = d.length, g = 0, f = 0;f < e; f++) {
          var h = d[f];
          c.set(h, g);
          g += h.length;
        }
        b.j = [c];
        return c;
      };
    }
    function Z(a) {
      X.call(this, a);
    }
    na(Z, X);
    var Hc = [Z, 1, Cc, 2, Y, 3, Dc, 4, Dc];
    Z.prototype.l = Gc(Hc);
    function Ic(a) {
      X.call(this, a, -1, Jc);
    }
    na(Ic, X);
    Ic.prototype.addClassification = function(a, b) {
      Qb(this, 1, Z, a, b);
      return this;
    };
    var Jc = [1], Kc = Fc([Ic, 1, Ec, Hc]);
    function Lc(a) {
      X.call(this, a);
    }
    na(Lc, X);
    var Mc = [Lc, 1, Y, 2, Y, 3, Y, 4, Y, 5, Y];
    Lc.prototype.l = Gc(Mc);
    function Nc(a) {
      X.call(this, a, -1, Oc);
    }
    na(Nc, X);
    var Oc = [1], Pc = Fc([Nc, 1, Ec, Mc]);
    function Qc(a) {
      X.call(this, a);
    }
    na(Qc, X);
    var Rc = [Qc, 1, Y, 2, Y, 3, Y, 4, Y, 5, Y, 6, Bc], Sc = Fc(Rc);
    Qc.prototype.l = Gc(Rc);
    function Tc(a, b, c) {
      c = a.createShader(c === 0 ? a.VERTEX_SHADER : a.FRAGMENT_SHADER);
      a.shaderSource(c, b);
      a.compileShader(c);
      if (!a.getShaderParameter(c, a.COMPILE_STATUS))
        throw Error(`Could not compile WebGL shader.

` + a.getShaderInfoLog(c));
      return c;
    }
    function Uc(a) {
      return Ob(a, Z, 1).map(function(b) {
        var c = S(b, 1);
        return { index: c == null ? 0 : c, qa: W(b, 2), label: S(b, 3) != null ? Rb(S(b, 3), "") : undefined, displayName: S(b, 4) != null ? Rb(S(b, 4), "") : undefined };
      });
    }
    function Vc(a) {
      return { x: W(a, 1), y: W(a, 2), z: W(a, 3), visibility: Mb(a, 4) != null ? W(a, 4) : undefined };
    }
    function Wc(a, b) {
      this.i = a;
      this.h = b;
      this.m = 0;
    }
    function Xc(a, b, c) {
      Yc(a, b);
      if (typeof a.h.canvas.transferToImageBitmap === "function")
        return Promise.resolve(a.h.canvas.transferToImageBitmap());
      if (c)
        return Promise.resolve(a.h.canvas);
      if (typeof createImageBitmap === "function")
        return createImageBitmap(a.h.canvas);
      a.j === undefined && (a.j = document.createElement("canvas"));
      return new Promise(function(d) {
        a.j.height = a.h.canvas.height;
        a.j.width = a.h.canvas.width;
        a.j.getContext("2d", {}).drawImage(a.h.canvas, 0, 0, a.h.canvas.width, a.h.canvas.height);
        d(a.j);
      });
    }
    function Yc(a, b) {
      var c = a.h;
      if (a.s === undefined) {
        var d = Tc(c, `
  attribute vec2 aVertex;
  attribute vec2 aTex;
  varying vec2 vTex;
  void main(void) {
    gl_Position = vec4(aVertex, 0.0, 1.0);
    vTex = aTex;
  }`, 0), e = Tc(c, `
  precision mediump float;
  varying vec2 vTex;
  uniform sampler2D sampler0;
  void main(){
    gl_FragColor = texture2D(sampler0, vTex);
  }`, 1), g = c.createProgram();
        c.attachShader(g, d);
        c.attachShader(g, e);
        c.linkProgram(g);
        if (!c.getProgramParameter(g, c.LINK_STATUS))
          throw Error(`Could not compile WebGL program.

` + c.getProgramInfoLog(g));
        d = a.s = g;
        c.useProgram(d);
        e = c.getUniformLocation(d, "sampler0");
        a.l = { O: c.getAttribLocation(d, "aVertex"), N: c.getAttribLocation(d, "aTex"), ya: e };
        a.v = c.createBuffer();
        c.bindBuffer(c.ARRAY_BUFFER, a.v);
        c.enableVertexAttribArray(a.l.O);
        c.vertexAttribPointer(a.l.O, 2, c.FLOAT, false, 0, 0);
        c.bufferData(c.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), c.STATIC_DRAW);
        c.bindBuffer(c.ARRAY_BUFFER, null);
        a.u = c.createBuffer();
        c.bindBuffer(c.ARRAY_BUFFER, a.u);
        c.enableVertexAttribArray(a.l.N);
        c.vertexAttribPointer(a.l.N, 2, c.FLOAT, false, 0, 0);
        c.bufferData(c.ARRAY_BUFFER, new Float32Array([0, 1, 0, 0, 1, 0, 1, 1]), c.STATIC_DRAW);
        c.bindBuffer(c.ARRAY_BUFFER, null);
        c.uniform1i(e, 0);
      }
      d = a.l;
      c.useProgram(a.s);
      c.canvas.width = b.width;
      c.canvas.height = b.height;
      c.viewport(0, 0, b.width, b.height);
      c.activeTexture(c.TEXTURE0);
      a.i.bindTexture2d(b.glName);
      c.enableVertexAttribArray(d.O);
      c.bindBuffer(c.ARRAY_BUFFER, a.v);
      c.vertexAttribPointer(d.O, 2, c.FLOAT, false, 0, 0);
      c.enableVertexAttribArray(d.N);
      c.bindBuffer(c.ARRAY_BUFFER, a.u);
      c.vertexAttribPointer(d.N, 2, c.FLOAT, false, 0, 0);
      c.bindFramebuffer(c.DRAW_FRAMEBUFFER ? c.DRAW_FRAMEBUFFER : c.FRAMEBUFFER, null);
      c.clearColor(0, 0, 0, 0);
      c.clear(c.COLOR_BUFFER_BIT);
      c.colorMask(true, true, true, true);
      c.drawArrays(c.TRIANGLE_FAN, 0, 4);
      c.disableVertexAttribArray(d.O);
      c.disableVertexAttribArray(d.N);
      c.bindBuffer(c.ARRAY_BUFFER, null);
      a.i.bindTexture2d(0);
    }
    function Zc(a) {
      this.h = a;
    }
    var $c = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 9, 1, 7, 0, 65, 0, 253, 15, 26, 11]);
    function ad(a, b) {
      return b + a;
    }
    function bd(a, b) {
      window[a] = b;
    }
    function cd(a) {
      var b = document.createElement("script");
      b.setAttribute("src", a);
      b.setAttribute("crossorigin", "anonymous");
      return new Promise(function(c) {
        b.addEventListener("load", function() {
          c();
        }, false);
        b.addEventListener("error", function() {
          c();
        }, false);
        document.body.appendChild(b);
      });
    }
    function dd() {
      return E(function(a) {
        switch (a.h) {
          case 1:
            return a.s = 2, D(a, WebAssembly.instantiate($c), 4);
          case 4:
            a.h = 3;
            a.s = 0;
            break;
          case 2:
            return a.s = 0, a.l = null, a.return(false);
          case 3:
            return a.return(true);
        }
      });
    }
    function ed(a) {
      this.h = a;
      this.listeners = {};
      this.l = {};
      this.L = {};
      this.s = {};
      this.v = {};
      this.M = this.u = this.ga = true;
      this.I = Promise.resolve();
      this.fa = "";
      this.D = {};
      this.locateFile = a && a.locateFile || ad;
      if (typeof window === "object")
        var b = window.location.pathname.toString().substring(0, window.location.pathname.toString().lastIndexOf("/")) + "/";
      else if (typeof location !== "undefined")
        b = location.pathname.toString().substring(0, location.pathname.toString().lastIndexOf("/")) + "/";
      else
        throw Error("solutions can only be loaded on a web page or in a web worker");
      this.ha = b;
      if (a.options) {
        b = A(Object.keys(a.options));
        for (var c = b.next();!c.done; c = b.next()) {
          c = c.value;
          var d = a.options[c].default;
          d !== undefined && (this.l[c] = typeof d === "function" ? d() : d);
        }
      }
    }
    x = ed.prototype;
    x.close = function() {
      this.j && this.j.delete();
      return Promise.resolve();
    };
    function fd(a) {
      var b, c, d, e, g, f, h, k, l, m, r;
      return E(function(p) {
        switch (p.h) {
          case 1:
            if (!a.ga)
              return p.return();
            b = a.h.files === undefined ? [] : typeof a.h.files === "function" ? a.h.files(a.l) : a.h.files;
            return D(p, dd(), 2);
          case 2:
            c = p.i;
            if (typeof window === "object")
              return bd("createMediapipeSolutionsWasm", { locateFile: a.locateFile }), bd("createMediapipeSolutionsPackedAssets", { locateFile: a.locateFile }), f = b.filter(function(n) {
                return n.data !== undefined;
              }), h = b.filter(function(n) {
                return n.data === undefined;
              }), k = Promise.all(f.map(function(n) {
                var q = gd(a, n.url);
                if (n.path !== undefined) {
                  var t = n.path;
                  q = q.then(function(w) {
                    a.overrideFile(t, w);
                    return Promise.resolve(w);
                  });
                }
                return q;
              })), l = Promise.all(h.map(function(n) {
                return n.simd === undefined || n.simd && c || !n.simd && !c ? cd(a.locateFile(n.url, a.ha)) : Promise.resolve();
              })).then(function() {
                var n, q, t;
                return E(function(w) {
                  if (w.h == 1)
                    return n = window.createMediapipeSolutionsWasm, q = window.createMediapipeSolutionsPackedAssets, t = a, D(w, n(q), 2);
                  t.i = w.i;
                  w.h = 0;
                });
              }), m = function() {
                return E(function(n) {
                  a.h.graph && a.h.graph.url ? n = D(n, gd(a, a.h.graph.url), 0) : (n.h = 0, n = undefined);
                  return n;
                });
              }(), D(p, Promise.all([l, k, m]), 7);
            if (typeof importScripts !== "function")
              throw Error("solutions can only be loaded on a web page or in a web worker");
            d = b.filter(function(n) {
              return n.simd === undefined || n.simd && c || !n.simd && !c;
            }).map(function(n) {
              return a.locateFile(n.url, a.ha);
            });
            importScripts.apply(null, ea(d));
            e = a;
            return D(p, createMediapipeSolutionsWasm(Module), 6);
          case 6:
            e.i = p.i;
            a.m = new OffscreenCanvas(1, 1);
            a.i.canvas = a.m;
            g = a.i.GL.createContext(a.m, {
              antialias: false,
              alpha: false,
              va: typeof WebGL2RenderingContext !== "undefined" ? 2 : 1
            });
            a.i.GL.makeContextCurrent(g);
            p.h = 4;
            break;
          case 7:
            a.m = document.createElement("canvas");
            r = a.m.getContext("webgl2", {});
            if (!r && (r = a.m.getContext("webgl", {}), !r))
              return alert("Failed to create WebGL canvas context when passing video frame."), p.return();
            a.K = r;
            a.i.canvas = a.m;
            a.i.createContext(a.m, true, true, {});
          case 4:
            a.j = new a.i.SolutionWasm, a.ga = false, p.h = 0;
        }
      });
    }
    function hd(a) {
      var b, c, d, e, g, f, h, k;
      return E(function(l) {
        if (l.h == 1) {
          if (a.h.graph && a.h.graph.url && a.fa === a.h.graph.url)
            return l.return();
          a.u = true;
          if (!a.h.graph || !a.h.graph.url) {
            l.h = 2;
            return;
          }
          a.fa = a.h.graph.url;
          return D(l, gd(a, a.h.graph.url), 3);
        }
        l.h != 2 && (b = l.i, a.j.loadGraph(b));
        c = A(Object.keys(a.D));
        for (d = c.next();!d.done; d = c.next())
          e = d.value, a.j.overrideFile(e, a.D[e]);
        a.D = {};
        if (a.h.listeners)
          for (g = A(a.h.listeners), f = g.next();!f.done; f = g.next())
            h = f.value, id(a, h);
        k = a.l;
        a.l = {};
        a.setOptions(k);
        l.h = 0;
      });
    }
    x.reset = function() {
      var a = this;
      return E(function(b) {
        a.j && (a.j.reset(), a.s = {}, a.v = {});
        b.h = 0;
      });
    };
    x.setOptions = function(a, b) {
      var c = this;
      if (b = b || this.h.options) {
        for (var d = [], e = [], g = {}, f = A(Object.keys(a)), h = f.next();!h.done; g = { X: g.X, Y: g.Y }, h = f.next())
          if (h = h.value, !((h in this.l) && this.l[h] === a[h])) {
            this.l[h] = a[h];
            var k = b[h];
            k !== undefined && (k.onChange && (g.X = k.onChange, g.Y = a[h], d.push(function(l) {
              return function() {
                var m;
                return E(function(r) {
                  if (r.h == 1)
                    return D(r, l.X(l.Y), 2);
                  m = r.i;
                  m === true && (c.u = true);
                  r.h = 0;
                });
              };
            }(g))), k.graphOptionXref && (h = Object.assign({}, { calculatorName: "", calculatorIndex: 0 }, k.graphOptionXref, { valueNumber: k.type === 1 ? a[h] : 0, valueBoolean: k.type === 0 ? a[h] : false, valueString: k.type === 2 ? a[h] : "" }), e.push(h)));
          }
        if (d.length !== 0 || e.length !== 0)
          this.u = true, this.H = (this.H === undefined ? [] : this.H).concat(e), this.F = (this.F === undefined ? [] : this.F).concat(d);
      }
    };
    function jd(a) {
      var b, c, d, e, g, f, h;
      return E(function(k) {
        switch (k.h) {
          case 1:
            if (!a.u)
              return k.return();
            if (!a.F) {
              k.h = 2;
              break;
            }
            b = A(a.F);
            c = b.next();
          case 3:
            if (c.done) {
              k.h = 5;
              break;
            }
            d = c.value;
            return D(k, d(), 4);
          case 4:
            c = b.next();
            k.h = 3;
            break;
          case 5:
            a.F = undefined;
          case 2:
            if (a.H) {
              e = new a.i.GraphOptionChangeRequestList;
              g = A(a.H);
              for (f = g.next();!f.done; f = g.next())
                h = f.value, e.push_back(h);
              a.j.changeOptions(e);
              e.delete();
              a.H = undefined;
            }
            a.u = false;
            k.h = 0;
        }
      });
    }
    x.initialize = function() {
      var a = this;
      return E(function(b) {
        return b.h == 1 ? D(b, fd(a), 2) : b.h != 3 ? D(b, hd(a), 3) : D(b, jd(a), 0);
      });
    };
    function gd(a, b) {
      var c, d;
      return E(function(e) {
        if (b in a.L)
          return e.return(a.L[b]);
        c = a.locateFile(b, "");
        d = fetch(c).then(function(g) {
          return g.arrayBuffer();
        });
        a.L[b] = d;
        return e.return(d);
      });
    }
    x.overrideFile = function(a, b) {
      this.j ? this.j.overrideFile(a, b) : this.D[a] = b;
    };
    x.clearOverriddenFiles = function() {
      this.D = {};
      this.j && this.j.clearOverriddenFiles();
    };
    x.send = function(a, b) {
      var c = this, d, e, g, f, h, k, l, m, r;
      return E(function(p) {
        switch (p.h) {
          case 1:
            if (!c.h.inputs)
              return p.return();
            d = 1000 * (b === undefined || b === null ? performance.now() : b);
            return D(p, c.I, 2);
          case 2:
            return D(p, c.initialize(), 3);
          case 3:
            e = new c.i.PacketDataList;
            g = A(Object.keys(a));
            for (f = g.next();!f.done; f = g.next())
              if (h = f.value, k = c.h.inputs[h]) {
                a: {
                  var n = a[h];
                  switch (k.type) {
                    case "video":
                      var q = c.s[k.stream];
                      q || (q = new Wc(c.i, c.K), c.s[k.stream] = q);
                      q.m === 0 && (q.m = q.i.createTexture());
                      if (typeof HTMLVideoElement !== "undefined" && n instanceof HTMLVideoElement) {
                        var t = n.videoWidth;
                        var w = n.videoHeight;
                      } else
                        typeof HTMLImageElement !== "undefined" && n instanceof HTMLImageElement ? (t = n.naturalWidth, w = n.naturalHeight) : (t = n.width, w = n.height);
                      w = { glName: q.m, width: t, height: w };
                      t = q.h;
                      t.canvas.width = w.width;
                      t.canvas.height = w.height;
                      t.activeTexture(t.TEXTURE0);
                      q.i.bindTexture2d(q.m);
                      t.texImage2D(t.TEXTURE_2D, 0, t.RGBA, t.RGBA, t.UNSIGNED_BYTE, n);
                      q.i.bindTexture2d(0);
                      q = w;
                      break a;
                    case "detections":
                      q = c.s[k.stream];
                      q || (q = new Zc(c.i), c.s[k.stream] = q);
                      q.data || (q.data = new q.h.DetectionListData);
                      q.data.reset(n.length);
                      for (w = 0;w < n.length; ++w) {
                        t = n[w];
                        var v = q.data, B = v.setBoundingBox, J = w;
                        var I = t.la;
                        var u = new Qc;
                        V(u, 1, I.sa);
                        V(u, 2, I.ta);
                        V(u, 3, I.height);
                        V(u, 4, I.width);
                        V(u, 5, I.rotation);
                        U(u, 6, I.pa);
                        I = u.l();
                        B.call(v, J, I);
                        if (t.ea)
                          for (v = 0;v < t.ea.length; ++v) {
                            u = t.ea[v];
                            B = q.data;
                            J = B.addNormalizedLandmark;
                            I = w;
                            u = Object.assign({}, u, { visibility: u.visibility ? u.visibility : 0 });
                            var C = new Lc;
                            V(C, 1, u.x);
                            V(C, 2, u.y);
                            V(C, 3, u.z);
                            u.visibility && V(C, 4, u.visibility);
                            u = C.l();
                            J.call(B, I, u);
                          }
                        if (t.ba)
                          for (v = 0;v < t.ba.length; ++v)
                            B = q.data, J = B.addClassification, I = w, u = t.ba[v], C = new Z, V(C, 2, u.qa), u.index && U(C, 1, u.index), u.label && U(C, 3, u.label), u.displayName && U(C, 4, u.displayName), u = C.l(), J.call(B, I, u);
                      }
                      q = q.data;
                      break a;
                    default:
                      q = {};
                  }
                }
                l = q;
                m = k.stream;
                switch (k.type) {
                  case "video":
                    e.pushTexture2d(Object.assign({}, l, { stream: m, timestamp: d }));
                    break;
                  case "detections":
                    r = l;
                    r.stream = m;
                    r.timestamp = d;
                    e.pushDetectionList(r);
                    break;
                  default:
                    throw Error("Unknown input config type: '" + k.type + "'");
                }
              }
            c.j.send(e);
            return D(p, c.I, 4);
          case 4:
            e.delete(), p.h = 0;
        }
      });
    };
    function kd(a, b, c) {
      var d, e, g, f, h, k, l, m, r, p, n, q, t, w;
      return E(function(v) {
        switch (v.h) {
          case 1:
            if (!c)
              return v.return(b);
            d = {};
            e = 0;
            g = A(Object.keys(c));
            for (f = g.next();!f.done; f = g.next())
              h = f.value, k = c[h], typeof k !== "string" && k.type === "texture" && b[k.stream] !== undefined && ++e;
            1 < e && (a.M = false);
            l = A(Object.keys(c));
            f = l.next();
          case 2:
            if (f.done) {
              v.h = 4;
              break;
            }
            m = f.value;
            r = c[m];
            if (typeof r === "string")
              return t = d, w = m, D(v, ld(a, m, b[r]), 14);
            p = b[r.stream];
            if (r.type === "detection_list") {
              if (p) {
                var B = p.getRectList();
                for (var J = p.getLandmarksList(), I = p.getClassificationsList(), u = [], C = 0;C < B.size(); ++C) {
                  var T = Sc(B.get(C)), od = W(T, 1), pd = W(T, 2), qd = W(T, 3), rd = W(T, 4), sd = W(T, 5, 0), za = undefined;
                  za = za === undefined ? 0 : za;
                  T = { la: { sa: od, ta: pd, height: qd, width: rd, rotation: sd, pa: Rb(S(T, 6), za) }, ea: Ob(Pc(J.get(C)), Lc, 1).map(Vc), ba: Uc(Kc(I.get(C))) };
                  u.push(T);
                }
                B = u;
              } else
                B = [];
              d[m] = B;
              v.h = 7;
              break;
            }
            if (r.type === "proto_list") {
              if (p) {
                B = Array(p.size());
                for (J = 0;J < p.size(); J++)
                  B[J] = p.get(J);
                p.delete();
              } else
                B = [];
              d[m] = B;
              v.h = 7;
              break;
            }
            if (p === undefined) {
              v.h = 3;
              break;
            }
            if (r.type === "float_list") {
              d[m] = p;
              v.h = 7;
              break;
            }
            if (r.type === "proto") {
              d[m] = p;
              v.h = 7;
              break;
            }
            if (r.type !== "texture")
              throw Error("Unknown output config type: '" + r.type + "'");
            n = a.v[m];
            n || (n = new Wc(a.i, a.K), a.v[m] = n);
            return D(v, Xc(n, p, a.M), 13);
          case 13:
            q = v.i, d[m] = q;
          case 7:
            r.transform && d[m] && (d[m] = r.transform(d[m]));
            v.h = 3;
            break;
          case 14:
            t[w] = v.i;
          case 3:
            f = l.next();
            v.h = 2;
            break;
          case 4:
            return v.return(d);
        }
      });
    }
    function ld(a, b, c) {
      var d;
      return E(function(e) {
        return typeof c === "number" || c instanceof Uint8Array || c instanceof a.i.Uint8BlobList ? e.return(c) : c instanceof a.i.Texture2dDataOut ? (d = a.v[b], d || (d = new Wc(a.i, a.K), a.v[b] = d), e.return(Xc(d, c, a.M))) : e.return(undefined);
      });
    }
    function id(a, b) {
      for (var c = b.name || "$", d = [].concat(ea(b.wants)), e = new a.i.StringList, g = A(b.wants), f = g.next();!f.done; f = g.next())
        e.push_back(f.value);
      g = a.i.PacketListener.implement({ onResults: function(h) {
        for (var k = {}, l = 0;l < b.wants.length; ++l)
          k[d[l]] = h.get(l);
        var m = a.listeners[c];
        m && (a.I = kd(a, k, b.outs).then(function(r) {
          r = m(r);
          for (var p = 0;p < b.wants.length; ++p) {
            var n = k[d[p]];
            typeof n === "object" && n.hasOwnProperty && n.hasOwnProperty("delete") && n.delete();
          }
          r && (a.I = r);
        }));
      } });
      a.j.attachMultiListener(e, g);
      e.delete();
    }
    x.onResults = function(a, b) {
      this.listeners[b || "$"] = a;
    };
    Aa("Solution", ed);
    Aa("OptionType", { BOOL: 0, NUMBER: 1, ua: 2, 0: "BOOL", 1: "NUMBER", 2: "STRING" });
    function md(a) {
      a === undefined && (a = 0);
      switch (a) {
        case 1:
          return "selfie_segmentation_landscape.tflite";
        default:
          return "selfie_segmentation.tflite";
      }
    }
    function nd(a) {
      var b = this;
      a = a || {};
      this.h = new ed({ locateFile: a.locateFile, files: function(c) {
        return [{ simd: true, url: "selfie_segmentation_solution_simd_wasm_bin.js" }, { simd: false, url: "selfie_segmentation_solution_wasm_bin.js" }, { data: true, url: md(c.modelSelection) }];
      }, graph: { url: "selfie_segmentation.binarypb" }, listeners: [{ wants: ["segmentation_mask", "image_transformed"], outs: { image: { type: "texture", stream: "image_transformed" }, segmentationMask: { type: "texture", stream: "segmentation_mask" } } }], inputs: { image: {
        type: "video",
        stream: "input_frames_gpu"
      } }, options: { useCpuInference: { type: 0, graphOptionXref: { calculatorType: "InferenceCalculator", fieldName: "use_cpu_inference" }, default: typeof window !== "object" || window.navigator === undefined ? false : "iPad Simulator;iPhone Simulator;iPod Simulator;iPad;iPhone;iPod".split(";").includes(navigator.platform) || navigator.userAgent.includes("Mac") && ("ontouchend" in document) }, selfieMode: { type: 0, graphOptionXref: { calculatorType: "GlScalerCalculator", calculatorIndex: 1, fieldName: "flip_horizontal" } }, modelSelection: {
        type: 1,
        graphOptionXref: { calculatorType: "ConstantSidePacketCalculator", calculatorName: "ConstantSidePacketCalculatorModelSelection", fieldName: "int_value" },
        onChange: function(c) {
          var d, e, g;
          return E(function(f) {
            if (f.h == 1)
              return d = md(c), e = "third_party/mediapipe/modules/selfie_segmentation/" + d, D(f, gd(b.h, d), 2);
            g = f.i;
            b.h.overrideFile(e, g);
            return f.return(true);
          });
        }
      } } });
    }
    x = nd.prototype;
    x.close = function() {
      this.h.close();
      return Promise.resolve();
    };
    x.onResults = function(a) {
      this.h.onResults(a);
    };
    x.initialize = function() {
      var a = this;
      return E(function(b) {
        return D(b, a.h.initialize(), 0);
      });
    };
    x.reset = function() {
      this.h.reset();
    };
    x.send = function(a) {
      var b = this;
      return E(function(c) {
        return D(c, b.h.send(a), 0);
      });
    };
    x.setOptions = function(a) {
      this.h.setOptions(a);
    };
    Aa("SelfieSegmentation", nd);
    Aa("VERSION", "0.1.1675465747");
  }).call(exports);
});
export default require_selfie_segmentation();

//# debugId=58D81DF2249F2AEB64756E2164756E21
//# sourceMappingURL=selfie_segmentation-me12wf1g.js.map
