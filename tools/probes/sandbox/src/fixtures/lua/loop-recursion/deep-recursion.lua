local function recurse(n)
  return recurse(n + 1)
end
return recurse(0)
