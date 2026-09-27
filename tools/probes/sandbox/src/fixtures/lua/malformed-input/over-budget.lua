-- No pcall available (base library is not open): deliberately lets the
-- budget error abort the chunk so the host-side API log is the sole
-- evidence of how many calls actually landed.
for i = 1, 100 do
  api.spend(1)
end
return "no-budget-error"
