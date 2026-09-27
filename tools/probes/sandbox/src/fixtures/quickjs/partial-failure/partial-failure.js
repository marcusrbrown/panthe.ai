api.move({ x: 1, y: 1 });
api.say("npc-1", "hello");
throw new Error("intentional partial-failure boom");
