-- coroutine is a standard-library global (luaopen_coroutine); with
-- openStandardLibs=false it should not exist at all.
local co = coroutine.create(function()
  coroutine.yield()
end)
return co
