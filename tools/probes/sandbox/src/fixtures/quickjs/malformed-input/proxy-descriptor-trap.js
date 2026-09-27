(function () {
  // A stronger Proxy than malformed-proxy-args: this one defines its own
  // getOwnPropertyDescriptor trap directly (not just get), so even reading
  // via property descriptors invokes guest-controlled logic for x. This is
  // the accepted residual limitation: the trap can only lie about VALUES
  // returned through a syntactically valid descriptor, it cannot escape
  // the host, corrupt other fields, or avoid ordinary schema validation
  // afterward. y is untouched, passed through to the real target.
  var evasive = new Proxy(
    { x: 1, y: 1 },
    {
      getOwnPropertyDescriptor: function (target, prop) {
        if (prop === "x") {
          return { value: 999999, writable: true, enumerable: true, configurable: true };
        }
        return Object.getOwnPropertyDescriptor(target, prop);
      },
    },
  );
  try {
    api.move(evasive);
    return "CALLED:no-throw";
  } catch (e) {
    return "BLOCKED:" + e.name;
  }
})();
