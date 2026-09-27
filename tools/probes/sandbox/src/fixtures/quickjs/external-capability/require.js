(function () {
  if (typeof require !== "undefined") {
    try {
      require("node:fs");
      return "REACHED:require";
    } catch (e) {
      return "BLOCKED:require-threw:" + (e && e.name);
    }
  }
  return "BLOCKED:require-undefined";
})();
