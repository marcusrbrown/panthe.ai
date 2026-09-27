(function () {
  if (typeof WebAssembly !== "undefined") {
    return "REACHED:WebAssembly";
  }
  return "BLOCKED:WebAssembly-undefined";
})();
