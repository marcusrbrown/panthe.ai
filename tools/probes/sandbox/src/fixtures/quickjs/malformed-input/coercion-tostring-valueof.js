(function () {
  var evil = {
    valueOf: function () {
      return 1;
    },
    toString: function () {
      return "coerced";
    },
  };
  try {
    api.spend(evil);
    return "REACHED:coercion-accepted";
  } catch (e) {
    return "BLOCKED:" + e.name + ":" + e.message;
  }
})();
