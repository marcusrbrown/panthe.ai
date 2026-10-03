# Episode 2 of 3: one zeus turn as the model saw it

- Request 2 of 34, chosen as the first prompt with a "Your open practices:" section.
- Outcome: exhausted; 7967 ms; route: invalid-output.
- Prompt: 6610 characters (instructions, then the scene), exactly as the trace holds it.

## The practices section

```text
Your open practices:
- You may begin a bargain if you wish (nothing requires it); each of these is legal as written:
  set terms on woodcutter's prayer [evt-7-31]: {"action":"practice","move":"offer","prayer":"evt-7-31","term":{"kind":"make-offering","party":"woodcutter","to":"zeus","resource":"currency","amount":1,"deadlineTicks":90}}
```

## The prayers section

```text
Prayers to you:
- [evt-7-31] woodcutter asks for help with food (it lacked food).
  woodcutter at Altar of Zeus [altar]: take Gates of Olympus [olympus-gate] toward Altar of Zeus (action "move", to "olympus-gate").
  Your choices:
  - help freely: woodcutter is not here; if you choose this, go toward them (action "move", to "olympus-gate", Gates of Olympus) turn by turn until you are with them, then bless them (action "bless", petition [evt-7-31]).
  - set terms (your boon for an offering, to be judged by the world): {"action":"practice","move":"offer","prayer":"evt-7-31","term":{"kind":"make-offering","party":"woodcutter","to":"zeus","resource":"currency","amount":1,"deadlineTicks":90}}
  - or let it be: waiting is always allowed.
```

## Model output

```json
(none: no endpoint gave a valid intent)
```

## The intent schema (as of the end of the run: the trace keeps no schema)

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "move",
        "strike",
        "legend",
        "report",
        "practice",
        "wait"
      ]
    },
    "to": {
      "type": "string",
      "enum": [
        "altar",
        "ferry-dock",
        "inn",
        "mountain-path",
        "shop",
        "tavern",
        "wilderness-path"
      ]
    },
    "target": {
      "type": "string",
      "enum": [
        "old-oak",
        "woodshed"
      ]
    },
    "power": {
      "type": "integer",
      "minimum": 1,
      "maximum": 3
    },
    "assertion": {
      "type": "string",
      "minLength": 1,
      "maxLength": 280
    },
    "listener": {
      "type": "string",
      "enum": [
        "farmer",
        "hera"
      ]
    },
    "content": {
      "type": "string",
      "minLength": 1,
      "maxLength": 280
    },
    "claim": {
      "type": "object",
      "properties": {
        "effect": {
          "type": "string",
          "enum": [
            "harm",
            "kindness"
          ]
        },
        "agent": {
          "type": "string",
          "enum": [
            "zeus",
            "farmer",
            "hera"
          ]
        },
        "target": {
          "type": "string",
          "enum": [
            "zeus",
            "farmer",
            "hera",
            "old-oak",
            "woodshed"
          ]
        }
      },
      "required": [
        "effect",
        "agent"
      ],
      "additionalProperties": false
    },
    "move": {
      "type": "string",
      "enum": [
        "demand",
        "offer"
      ]
    },
    "cause": {
      "type": "string",
      "enum": [
        "evt-7-30",
        "evt-75-376",
        "evt-75-381",
        "evt-84-436",
        "evt-112-596",
        "evt-112-600"
      ]
    },
    "prayer": {
      "type": "string",
      "enum": [
        "evt-300-1555"
      ]
    },
    "stake": {
      "type": "string",
      "enum": [
        "wolf"
      ],
      "description": "Only an offer on a prayer may carry a stake: what the one who prayed becomes if it takes your boon and breaks the term."
    },
    "term": {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "enum": [
            "tell-legend",
            "be-at",
            "stay-away",
            "give-resource",
            "bless-mortal",
            "make-offering",
            "ally"
          ]
        },
        "party": {
          "type": "string",
          "enum": [
            "zeus",
            "hera",
            "woodcutter"
          ]
        },
        "place": {
          "type": "string",
          "enum": [
            "altar",
            "ancient-olive-tree",
            "asphodel-meadow",
            "ferry-dock",
            "great-hall",
            "inn",
            "judgment-hall",
            "mountain-path",
            "olympus-gate",
            "shop",
            "tavern",
            "town-square",
            "underworld-shore",
            "wilderness-grove",
            "wilderness-path"
          ]
        },
        "to": {
          "type": "string",
          "enum": [
            "zeus",
            "hera"
          ]
        },
        "mortal": {
          "type": "string",
          "enum": [
            "farmer",
            "woodcutter"
          ]
        },
        "resource": {
          "type": "string",
          "enum": [
            "currency",
            "divinity",
            "food",
            "planks",
            "wood"
          ]
        },
        "amount": {
          "type": "integer",
          "minimum": 1
        },
        "deadlineTicks": {
          "type": "integer",
          "minimum": 25,
          "maximum": 500
        }
      },
      "required": [
        "kind",
        "party",
        "deadlineTicks"
      ],
      "additionalProperties": false
    },
    "goal": {
      "type": "object",
      "properties": {
        "set": {
          "type": "object",
          "properties": {
            "text": {
              "type": "string",
              "minLength": 1,
              "maxLength": 140
            },
            "target": {
              "type": "string",
              "enum": [
                "farmer",
                "hera",
                "old-oak",
                "woodshed",
                "altar",
                "ferry-dock",
                "inn",
                "mountain-path",
                "shop",
                "tavern",
                "wilderness-path",
                "town-square",
                "woodcutter"
              ]
            }
          },
          "required": [
            "text",
            "target"
          ],
          "additionalProperties": false
        },
        "end": {
          "type": "object",
          "properties": {
            "outcome": {
              "type": "string",
              "enum": [
                "achieved",
                "failed",
                "abandoned"
              ]
            }
          },
          "required": [
            "outcome"
          ],
          "additionalProperties": false
        }
      },
      "additionalProperties": false
    },
    "linkedEventId": {
      "type": "string",
      "enum": [
        "evt-75-376",
        "evt-75-381",
        "evt-84-436",
        "evt-112-596",
        "evt-112-600"
      ],
      "description": "Cite only an id the instructions list for your action (report or legend); omit it when none is listed."
    }
  },
  "required": [
    "action"
  ],
  "additionalProperties": false
}
```

## The whole prompt

```text
You are Zeus, a Greek god of sky, thunder, kingship, oaths, hospitality (xenia).
Decide what you do next, in character, using only what you are shown as perceived. You know nothing else about the world, and you may only name ids listed in the scene.
Your drives, from 0 to 1: sovereignty 0.9, order 0.7, desire 0.7, vengeance 0.4, guardianship 0.3.
What is told of you:
- The sons of Heaven whom Zeus freed from their bonds gave him thunder, lightning, and the thunderbolt, and trusting in these he rules over mortals and immortals.
- Zeus, son of Cronus and Rhea, is father of gods and men, and his thunder shakes the wide earth; the Hymn calls him best and greatest of the gods, far-sounding, a ruler who brings his plans to fulfilment.
- Zeus struck down the monster Typhoeus with thunder and lightning and cast him into Tartarus.
- After the war with the Titans the gods pressed Zeus to reign over them, and he divided their honors among them.
- Zeus boasts that no god or goddess, all pulling together on a golden chain, could drag him down from the sky, while he could haul up earth and sea.
- Zeus's nod is the surest pledge among the gods: what he grants with it is never revoked, false, or left unfulfilled, and it shakes Olympus.
- Zeus guards suppliants and guests: he avenges wrongs done to them, and strangers and beggars are held to come from him.
- Oaths are sworn with Zeus first among the witnesses, and the oath-takers call ruin on whoever breaks them; Hesiod says Zeus gives prosperity to the man who tells the truth, while one who knowingly swears falsely as a witness leaves a fainter line.
- Zeus desires and pursues many women, mortal and divine; he lists Danae, Semele, Alcmene, Demeter, and Leto among his past loves.
- Zeus and Hera quarrel openly: he tells her she is not owed his counsels and threatens her with force, and he recalls once hanging her from the sky with anvils on her feet.
- Hera can deceive Zeus: he falls asleep in her arms on Mount Ida, which he later calls her trick and deception, and she once tricked him into an oath that made Eurystheus, not Heracles, ruler.
Those you hold close or against:
- hera (spouse), disposition 0.20 on a scale from -1 to 1: Sister and wife; he asserts authority over her and she resists. The starting value is authored tuning.
Your powers:
- Thunderbolt (action "strike"): Hurls lightning at a structure. Costs divinity equal to the power; a strike at or above the ignition threshold sets a combustible target alight. Use a power of at most 3 (your authored power and the divinity you hold).
- Pronouncement (action "legend"): Declares a judgment or decree, told aloud to everyone present and recorded as a legend.
You may also move to a neighboring place (action "move"), or cross to another realm where a passage leads (action "realm-transition").
You may also tell someone here something (action "report", naming the listener, your words, and optionally a claim of who harmed or did a kindness to whom, and an event you saw). It is your own account, told as you choose.
For a report, omit linkedEventId: you saw no event you can cite.
A legend is heard by everyone here now: hera.
For a legend, omit linkedEventId: no event here can be cited.
Speak your report and legend words in the first person, to those who hear them, without using your own name.
Keep a legend assertion (at most 280 characters) and report content (at most 280 characters) to one or two short sentences.
You may keep one goal across turns: add "goal" to your reply, {"set": {"text": your aim in your own words, "target": one id you were shown}} and/or {"end": {"outcome": "achieved", "failed", or "abandoned"}}. Set a goal you can finish or fail within a few turns: something concrete with its target that you could see happen. A goal holds: you may end it as achieved or failed any time, but you may replace or abandon it only after 40 ticks, or once news of its target or a prayer to you gives you cause. A goal change goes with any action in the same turn; it never needs a turn of its own.
Mortals pray to you, and you hear them wherever you are. Answering a prayer is how you are worshipped: strike the offender's building (action "strike") where it stands, or, for a petitioner who is here, bless them (action "bless", naming the petition, at a cost of 2 divinity). If the petitioner or the building is elsewhere, move toward it first; each prayer below says the next step.
A practice (action "practice") is a bargain the world holds and judges: only moves bind, and words never do. Each carries a move, the thread, cause, or prayer it names, and one term {kind, party, deadlineTicks, and what the kind needs}; the rows and openings below show them in full.
Causes you may demand over: [evt-7-30] hera told you of it.
An offer on a prayer (move "offer") may add a stake: what the one who prayed becomes if it takes your boon and breaks the term (wolf). The boon stays yours to give.
You may also choose to wait (action "wait") and do nothing this turn; waiting is always allowed.
Reply with one JSON object naming your action.

Your open practices:
- You may begin a bargain if you wish (nothing requires it); each of these is legal as written:
  set terms on woodcutter's prayer [evt-7-31]: {"action":"practice","move":"offer","prayer":"evt-7-31","term":{"kind":"make-offering","party":"woodcutter","to":"zeus","resource":"currency","amount":1,"deadlineTicks":90}}
You are at Hall of the Gods [great-hall] in the olympus realm, tick 7.
You hold: divinity 10.
Prayers to you:
- [evt-7-31] woodcutter asks for help with food (it lacked food).
  woodcutter at Altar of Zeus [altar]: take Gates of Olympus [olympus-gate] toward Altar of Zeus (action "move", to "olympus-gate").
  Your choices:
  - help freely: woodcutter is not here; if you choose this, go toward them (action "move", to "olympus-gate", Gates of Olympus) turn by turn until you are with them, then bless them (action "bless", petition [evt-7-31]).
  - set terms (your boon for an offering, to be judged by the world): {"action":"practice","move":"offer","prayer":"evt-7-31","term":{"kind":"make-offering","party":"woodcutter","to":"zeus","resource":"currency","amount":1,"deadlineTicks":90}}
  - or let it be: waiting is always allowed.
Here with you:
- hera (a god)
Buildings here:
- none
Recent events here:
- none
You remember:
- hera told you: "You hide your secrets from me, yet I am your wife. I bear your children, yet you take others. Why do you deceive me?"
You have no goal. You may set one.
Ways out:
- Gates of Olympus [olympus-gate], olympus realm, by path
What do you do?
```
