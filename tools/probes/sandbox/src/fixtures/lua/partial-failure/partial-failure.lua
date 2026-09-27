api.move({ x = 1, y = 1 })
api.say("npc-1", "hello")
-- error() is a base-library function and unavailable; trigger a genuine
-- language-level runtime error instead (arithmetic on nil).
local boom = nil + 1
return boom
