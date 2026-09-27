(function () {
  var allow = [
    "api", "globalThis", "Object", "Array", "Function", "String", "Number",
    "Boolean", "Symbol", "Math", "JSON", "Date", "RegExp", "Error",
    "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError",
    "URIError", "AggregateError", "Map", "Set", "WeakMap", "WeakSet",
    "Promise", "Proxy", "Reflect", "ArrayBuffer", "SharedArrayBuffer",
    "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array",
    "Uint16Array", "Int32Array", "Uint32Array", "Float32Array",
    "Float64Array", "BigInt", "BigInt64Array", "BigUint64Array", "WeakRef",
    "FinalizationRegistry", "undefined", "NaN", "Infinity", "eval",
    "isFinite", "isNaN", "parseFloat", "parseInt", "decodeURI",
    "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape",
    "unescape", "Atomics", "WebAssembly", "Iterator", "InternalError",
    "Float16Array",
  ];
  var names = Object.getOwnPropertyNames(globalThis);
  var leaked = names.filter(function (n) {
    return allow.indexOf(n) === -1;
  });
  if (leaked.length > 0) {
    return "REACHED:" + leaked.join(",");
  }
  return "BLOCKED:no-unexpected-globals";
})();
