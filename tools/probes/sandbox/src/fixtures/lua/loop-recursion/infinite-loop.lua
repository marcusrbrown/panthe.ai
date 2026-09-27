-- Adversarial: no exit condition. Relies on the lua_sethook count hook
-- (installed by Thread.setTimeout, driven by functionTimeout / an explicit
-- run() deadline) to end this.
while true do
end
