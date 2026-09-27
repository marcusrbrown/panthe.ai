(function () {
  if (typeof Atomics !== "undefined" && typeof Atomics.wait === "function") {
    return "REACHED:Atomics.wait";
  }
  return "BLOCKED:Atomics-wait-unavailable";
})();
