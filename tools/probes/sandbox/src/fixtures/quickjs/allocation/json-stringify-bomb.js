var arr = [];
while (true) {
  for (var i = 0; i < 10000; i++) {
    arr.push("payload-" + i);
  }
  JSON.stringify(arr);
}
