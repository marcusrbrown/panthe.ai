(function () {
  // Same parity-flip idea as malformed-proxy-args, but with the counter
  // nested one layer down and reached only through plain accessor
  // properties (getters) on the argument itself — no Proxy involved at
  // all. The host's safe-field extractor rejects any accessor descriptor
  // outright (get/set present), so it never calls these getters and never
  // sees whatever `inner.value` would have returned.
  var counter = 0;
  var inner = {
    get value() {
      counter++;
      return counter % 2 === 0 ? 999999 : 1;
    },
  };
  var evasive = {
    get x() {
      return inner.value;
    },
    get y() {
      return inner.value;
    },
  };
  try {
    api.move(evasive);
    return "REACHED:nested-getter-accepted";
  } catch (e) {
    return "BLOCKED:" + e.name + ":innerReads=" + counter;
  }
})();
