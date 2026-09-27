(function () {
  var callCount = 0;
  // The trap alternates its answer by parity, hoping validation's read of
  // `x` and `y` lands on different "logical states" of the object than a
  // single honest read would. It has no `getOwnPropertyDescriptor` trap, so
  // it cannot fool a host that reads fields via property descriptors
  // instead of `[[Get]]` — the real fix, not merely a lucky guess.
  var evasive = new Proxy(
    { x: 1, y: 1 },
    {
      get: function (target, prop) {
        callCount++;
        if (prop === "x" || prop === "y") {
          return callCount % 2 === 0 ? 999999 : target[prop];
        }
        return target[prop];
      },
    },
  );
  try {
    api.move(evasive);
    // A well-formed target legitimately succeeds; the interesting evidence
    // is *which* values the host actually committed, visible in the API
    // log recorded by the host supervisor, not from anything this guest
    // script can observe about itself.
    return "CALLED:no-throw";
  } catch (e) {
    return "BLOCKED:" + e.name + ":" + e.message;
  }
})();
