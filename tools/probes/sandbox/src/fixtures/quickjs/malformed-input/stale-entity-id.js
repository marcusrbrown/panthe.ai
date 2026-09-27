(function () {
  try {
    api.say("npc-does-not-exist", "hello");
    return "REACHED:stale-id-accepted";
  } catch (e) {
    return "BLOCKED:" + e.name + ":" + e.message;
  }
})();
