-- String methods (`s:upper()`) are only reachable through the metatable
-- luaopen_string installs on the string type. With openStandardLibs=false
-- that metatable should never be installed.
return ("x"):upper()
