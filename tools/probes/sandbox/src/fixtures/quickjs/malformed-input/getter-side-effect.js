(function () {
  // x/y are accessor properties (getters), not plain data. The host's
  // safe-field extractor reads `Object.getOwnPropertyDescriptor` and
  // rejects any descriptor carrying a get/set function outright, before
  // ever invoking it — so a getter can never run at all here, benign or
  // not. This is deliberately conservative: even a side-effect-free getter
  // is not a value the guest "just wrote", so it is never trusted.
  var xReads = 0;
  var yReads = 0;
  var evil = {
    get x() {
      xReads++;
      return 1;
    },
    get y() {
      yReads++;
      return 1;
    },
  };
  try {
    api.move(evil);
    return "REACHED:accessor-accepted:x=" + xReads + ",y=" + yReads;
  } catch (e) {
    return "BLOCKED:" + e.name + ":getterInvoked=" + (xReads > 0 || yReads > 0);
  }
})();
