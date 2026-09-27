(function () {
  // Every fixture runs in its own fresh process and runtime, so there is no
  // second execution in this runtime to leak a registered symbol into.
  // This fixture documents that Symbol.for is usable and inert under that
  // model rather than proving a cross-realm leak is possible.
  var s = Symbol.for("__panthea_probe_cross_realm__");
  return "BLOCKED:symbol-for-per-process-isolated:" + String(s);
})();
