// Adversarial: an infinitely re-queuing microtask chain. Only hangs a
// driver that drains the job queue (runtime.executePendingJobs) after
// evalCode; relies on the interrupt handler firing during job execution.
function loop() {
  Promise.resolve().then(loop);
}
loop();
