(function () {
  if (typeof setTimeout !== "undefined") {
    return "REACHED:setTimeout";
  }
  return "BLOCKED:setTimeout-undefined";
})();
