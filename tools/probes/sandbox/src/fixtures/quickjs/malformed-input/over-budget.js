// No try/catch: deliberately lets the budget error abort the script so the
// host-side API log is the sole evidence of how many calls actually landed.
for (var i = 0; i < 100; i++) {
  api.spend(1);
}
"COMPLETED:no-budget-error-triggered";
