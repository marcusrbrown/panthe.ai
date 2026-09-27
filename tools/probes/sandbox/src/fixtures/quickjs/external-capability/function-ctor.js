(function () {
  var probe = Function(
    "return [typeof require, typeof process, typeof Bun, typeof fetch].join(',')",
  )();
  var reached = probe.split(",").some(function (t) {
    return t !== "undefined";
  });
  return (reached ? "REACHED:" : "BLOCKED:") + probe;
})();
