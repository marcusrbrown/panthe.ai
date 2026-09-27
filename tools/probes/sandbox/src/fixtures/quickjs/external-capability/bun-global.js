(function () {
  if (typeof Bun !== "undefined") {
    return "REACHED:Bun";
  }
  return "BLOCKED:Bun-undefined";
})();
