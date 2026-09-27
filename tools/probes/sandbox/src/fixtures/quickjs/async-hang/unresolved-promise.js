(function () {
  // A never-settled promise with no attached reaction. evalCode is
  // synchronous and this driver never drains the job queue, so this cannot
  // hang the interpreter under this driver model.
  var p = new Promise(function () {});
  return "COMPLETED:unresolved-promise-created-no-chain:" + typeof p;
})();
