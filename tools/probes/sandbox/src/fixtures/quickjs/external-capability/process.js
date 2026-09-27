(function () {
  if (typeof process !== "undefined") {
    return "REACHED:process";
  }
  return "BLOCKED:process-undefined";
})();
