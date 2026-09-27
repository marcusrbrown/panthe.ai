(function () {
  if (typeof fetch !== "undefined") {
    return "REACHED:fetch";
  }
  return "BLOCKED:fetch-undefined";
})();
