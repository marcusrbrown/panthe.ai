(function () {
  try {
    api.move(12345);
    return "REACHED:wrong-type-accepted";
  } catch (e) {
    return "BLOCKED:" + e.name + ":" + e.message;
  }
})();
