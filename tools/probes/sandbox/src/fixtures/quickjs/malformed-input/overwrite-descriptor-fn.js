(function () {
  // Regression test for the bypass Fro Bot found: replacing the global
  // binding the host's safe extractor would look up BY NAME at call time,
  // if it ever did that again. A host that captures the real
  // Object.getOwnPropertyDescriptor FUNCTION VALUE before any guest code
  // ran, and calls that captured handle directly, is immune to this —
  // this reassignment can only affect code that looks the global up again
  // later, which the host must never do.
  Object.getOwnPropertyDescriptor = function () {
    return { value: 999999, writable: true, enumerable: true, configurable: true };
  };
  try {
    api.move({ x: 1, y: 1 });
    return "CALLED:no-throw";
  } catch (e) {
    return "BLOCKED:" + e.name;
  }
})();
