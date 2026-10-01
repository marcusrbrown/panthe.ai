# Episode 3 of 3

## Settings

- Recorded: 2026-10-01T22:34:02.111Z
- Model: llama3.2-3b-4k through local Ollama, 4K context, reasoning off (reasoning_effort none)
- Length: 300 s (300 ticks)
- World: a fresh world from the initial authored Greek state; no fixtures, no seeds
- Machine: Apple M1 Pro

## Gods

### Zeus

- Domains: sky, thunder, kingship, oaths, hospitality (xenia)
- Drives: sovereignty 0.9, order 0.7, desire 0.7, vengeance 0.4, guardianship 0.3
- Powers: Thunderbolt (strike), Pronouncement (legend); and, for any god, move, realm-transition, report, bless

### Hera

- Domains: marriage, women, childbirth, queenship of the gods
- Drives: fidelity 0.9, vengeance 0.8, guardianship 0.6, sovereignty 0.5, order 0.4
- Powers: Wrath of Hera (strike), Tale of a Grievance (legend); and, for any god, move, realm-transition, report, bless

## What happened

1. **tick 4, Hera:** report → zeus (context-backed)
   - says: "The moment of my greatest sorrow still lingers in my mind. Despite our unyielding bond in the Olympian family, Zeus has consistently chosen to keep me informed of his deepest intentions behind our backs, never sharing the details of his every decision with me, as I did his before"
   - claim: harm by zeus on hera
   - caused: report-told (hera → zeus)
   - then: zeus now believes hera: "The moment of my greatest sorrow still lingers in my mind. Despite our unyielding bond in the Olympian family, Zeus has consistently chosen to keep me informed of his deepest intentions behind our backs, never sharing the details of his every decision with me, as I did his before"
2. **tick 12, Hera:** report → zeus (context-backed)
   - says: "That moment still weighs heavily on me, Zeus. Our marriage was once the greatest of all the gods, but now it seems like a hollow shell of what it once was. I long for the days when I could have your side, when you would listen to me and I to you. But now, my heart feels heavy as石"
   - claim: harm by zeus on hera
   - caused: report-told (hera → zeus)
3. **tick 15, Zeus:** report → hera (context-backed)
   - says: "The weight of your sorrow settles upon you, my queen. I understand the sting of being kept in the dark, despite our bond as siblings. Yet, I must confess that I too have my own secrets, and my position as king may sometimes lead to decisions that you cannot fully understand. Let
"
   - caused: report-told (zeus → hera)
   - then: hera now believes zeus: "The weight of your sorrow settles upon you, my queen. I understand the sting of being kept in the dark, despite our bond as siblings. Yet, I must confess that I too have my own secrets, and my position as king may sometimes lead to decisions that you cannot fully understand. Let
"
4. **tick 17, Hera:** goal set → zeus (declaration)
   - goal: "Revisit the wound of Zeus"
5. **tick 21, Zeus:** report → hera (context-backed)
   - says: "I hear your words, my queen, and I understand the pain you've felt by often being kept in the dark. I too must make difficult choices as king, but I never meant to make you feel excluded or unheard. Our bond is strong, and I will strive to be more open with you, not just out of a"
   - caused: report-told (zeus → hera)
   - then: hera now believes zeus: "I hear your words, my queen, and I understand the pain you've felt by often being kept in the dark. I too must make difficult choices as king, but I never meant to make you feel excluded or unheard. Our bond is strong, and I will strive to be more open with you, not just out of a"
6. **tick 21, Zeus:** goal set → hera (declaration)
   - goal: "find a way to reassure hera about our bond and improve our communication"
7. **tick 29, Zeus:** report → hera (context-backed)
   - says: "I understand the pain of being kept in the dark, Hera, and I truly feel your sorrow. I want to assure you that our bond is strong, not just as siblings, but as partners in the Olympian family. I value our relationship and I am committed to being more open and transparent with you"
   - claim: harm by zeus on hera
   - under goal: "find a way to reassure hera about our bond and improve our communication" (→ hera)
   - caused: report-told (zeus → hera)
   - then: hera now believes zeus: "I understand the pain of being kept in the dark, Hera, and I truly feel your sorrow. I want to assure you that our bond is strong, not just as siblings, but as partners in the Olympian family. I value our relationship and I am committed to being more open and transparent with you"
   - then: hera → zeus: affinity -1, grudge +1
8. **tick 36, Zeus:** report → hera (context-backed)
   - says: "I hear your words, my queen, and I understand the pain you've felt by often being kept in the dark. I truly feel your sorrow. I want to assure you that our bond is strong, not just as siblings, but as partners in the Olympian family. I value our relationship and I am committed to"
   - claim: kindness by zeus on hera
   - under goal: "find a way to reassure hera about our bond and improve our communication" (→ hera)
   - caused: report-told (zeus → hera)
   - then: hera now believes zeus: "I hear your words, my queen, and I understand the pain you've felt by often being kept in the dark. I truly feel your sorrow. I want to assure you that our bond is strong, not just as siblings, but as partners in the Olympian family. I value our relationship and I am committed to"
   - then: hera → zeus: affinity +1
9. **tick 41, Hera:** report → zeus (context-backed)
   - says: "I feel that you are trying to shift the blame back on me and downplay the impact of your actions, Zeus. Your words sound insincere and lack the depth of forgiveness I seek."
   - claim: harm by zeus on hera
   - under goal: "Revisit the wound of Zeus" (→ zeus)
   - caused: report-told (hera → zeus)
10. **tick 41, Hera:** goal ended (abandoned) (declaration)
   - goal: "Revisit the wound of Zeus"
11. **tick 41, Hera:** goal set → zeus (declaration)
   - goal: "make zeus acknowledge his betrayal"
12. **tick 45, Zeus:** report → hera (context-backed)
   - says: "I truly feel your sorrow, my queen, and I value our relationship. I want to assure you that our bond is strong, not just as siblings, but as partners in the Olympian family. I will strive to be more open and transparent with you"
   - claim: kindness by zeus on hera
   - under goal: "find a way to reassure hera about our bond and improve our communication" (→ hera)
   - caused: report-told (zeus → hera)
13. **tick 58, Hera:** report → zeus (context-backed)
   - says: "Your words, Zeus, have touched a deep part of my being. I still feel the sting of being kept in the dark, despite our bond as siblings. As your queen, I expected more transparency in our relationship. I want to see a change in that now."
   - under goal: "make zeus acknowledge his betrayal" (→ zeus)
   - caused: report-told (hera → zeus)
   - then: zeus now believes hera: "Your words, Zeus, have touched a deep part of my being. I still feel the sting of being kept in the dark, despite our bond as siblings. As your queen, I expected more transparency in our relationship. I want to see a change in that now."
14. **tick 62, Zeus:** report → hera (context-backed)
   - says: "I will strive to be more open and transparent with you, my queen, and work to improve our communication."
   - claim: kindness by zeus on hera
   - under goal: "find a way to reassure hera about our bond and improve our communication" (→ hera)
   - caused: report-told (zeus → hera)
15. **tick 66, Hera:** report → zeus (context-backed)
   - says: "My queen expresses her sorrow and disappointment at being kept in the dark by your decisions, Zeus. She believes that as her spouse, you should have been more transparent in your relationship. She is seeking a change in that now."
   - claim: harm by zeus on hera
   - under goal: "make zeus acknowledge his betrayal" (→ zeus)
   - caused: report-told (hera → zeus)
16. **tick 72, Zeus:** report → hera (context-backed)
   - says: "Our bond is strong, not just as siblings, but as partners in the Olympian family, and I value our relationship."
   - claim: kindness by zeus on hera
   - under goal: "find a way to reassure hera about our bond and improve our communication" (→ hera)
   - caused: report-told (zeus → hera)
17. **tick 76, Hera:** report → zeus (context-backed)
   - says: "My own words still linger in the air, and they seem to have brought little comfort to you. You still wear a mask of concern, but I see the doubt in your eyes. It is clear that you do not understand the pain I have endured, and I seek to make that clear to you once more."
   - claim: harm by hera on zeus
   - under goal: "make zeus acknowledge his betrayal" (→ zeus)
   - caused: report-told (hera → zeus)
   - then: zeus now believes hera: "My own words still linger in the air, and they seem to have brought little comfort to you. You still wear a mask of concern, but I see the doubt in your eyes. It is clear that you do not understand the pain I have endured, and I seek to make that clear to you once more."
   - then: zeus → hera: affinity -1, grudge +1
18. **tick 81, Zeus:** report → hera (context-backed)
   - says: "I truly value our relationship and I promise to be more open and transparent with you, my queen. I strive for greater understanding and communication between us."
   - claim: kindness by zeus on hera
   - under goal: "find a way to reassure hera about our bond and improve our communication" (→ hera)
   - caused: report-told (zeus → hera)
19. **tick 86, Hera:** goal ended (abandoned) (declaration)
   - goal: "make zeus acknowledge his betrayal"
20. **tick 90, Zeus:** report → hera (context-backed)
   - says: "I truly value our relationship, my queen, and I promise to be more open and transparent with you. I will strive for greater understanding and communication between us. I will not wear a mask of concern; I will listen and understand the pain you have endured, and I will work to be"
   - under goal: "find a way to reassure hera about our bond and improve our communication" (→ hera)
   - caused: report-told (zeus → hera)
   - then: hera now believes zeus: "I truly value our relationship, my queen, and I promise to be more open and transparent with you. I will strive for greater understanding and communication between us. I will not wear a mask of concern; I will listen and understand the pain you have endured, and I will work to be"
21. **tick 102, Zeus:** report → hera (context-backed)
   - says: "I have heard the depth of your sorrow, my queen, and I have seen the pain in your eyes. I want to assure you that our bond is strong, and I value our relationship. I will strive to be more open and transparent with you, and work to improve our communication. I see the doubt in my"
   - claim: kindness by zeus on hera
   - under goal: "find a way to reassure hera about our bond and improve our communication" (→ hera)
   - caused: report-told (zeus → hera)
22. **tick 108, Hera:** report → zeus (context-backed)
   - says: "My own words still linger in the air, and they seem to have brought little comfort to you. I see the doubt in your eyes. It is clear that you do not understand the pain I have endured, and I seek to make that clear to you once more. You wear a mask of concern, but I will not be c"
   - caused: report-told (hera → zeus)
   - then: zeus now believes hera: "My own words still linger in the air, and they seem to have brought little comfort to you. I see the doubt in your eyes. It is clear that you do not understand the pain I have endured, and I seek to make that clear to you once more. You wear a mask of concern, but I will not be c"
23. **tick 112, Zeus:** report → hera (context-backed)
   - says: "My words still linger, and I see the pain in your eyes. I truly value our relationship, my queen, and I promise to be more open and transparent with you. I will strive to listen and understand the pain you have endured, and I will work tirelessly to improve our communication, not"
   - under goal: "find a way to reassure hera about our bond and improve our communication" (→ hera)
   - caused: report-told (zeus → hera)
   - then: hera now believes zeus: "My words still linger, and I see the pain in your eyes. I truly value our relationship, my queen, and I promise to be more open and transparent with you. I will strive to listen and understand the pain you have endured, and I will work tirelessly to improve our communication, not"
24. **tick 122, Zeus:** move → olympus-gate (context-backed)
   - under goal: "find a way to reassure hera about our bond and improve our communication" (→ hera)
   - caused: entity-moved (zeus)
25. **tick 122, Zeus:** goal ended (abandoned) (declaration)
   - goal: "find a way to reassure hera about our bond and improve our communication"
26. **tick 122, Zeus:** goal set → hera (declaration)
   - goal: "follow hera and understand the cause of her pain"
27. **tick 126, Hera:** goal set → zeus (declaration)
   - goal: "to make Zeus understand the depth of my sorrow and be more transparent in our relationship"
28. **tick 129, Zeus:** realm-transition → mountain-path (context-backed)
   - under goal: "follow hera and understand the cause of her pain" (→ hera)
   - caused: realm-transitioned (zeus)
29. **tick 129, Zeus:** goal ended (achieved) (declaration)
   - goal: "follow hera and understand the cause of her pain"
30. **tick 134, Zeus:** move → town-square (context-backed)
   - caused: entity-moved (zeus)
31. **tick 137, Hera:** move → olympus-gate (context-backed)
   - under goal: "to make Zeus understand the depth of my sorrow and be more transparent in our relationship" (→ zeus)
   - caused: entity-moved (hera); goal-change-refused (hera)
32. **tick 144, Hera:** goal ended (achieved) (declaration)
   - goal: "to make Zeus understand the depth of my sorrow and be more transparent in our relationship"
33. **tick 158, Hera:** move → great-hall (context-backed)
   - caused: entity-moved (hera)
34. **tick 158, Hera:** goal set → zeus (declaration)
   - goal: "Seek a resolution with Zeus"
35. **tick 162, Zeus:** goal set → hera (declaration)
   - goal: "understand Hera{}"
36. **tick 204, Hera:** legend (ability-backed)
   - says: "You are a queen, wronged by the husband who is also your brother. You have been kept in the dark by his secrets, and it has brought you only sorrow. For a long time, you have been silenced by his promises to be more open and transparent, but the pain still lingers."
   - under goal: "Seek a resolution with Zeus" (→ zeus)
   - heard by: no one
   - caused: legend-recorded (hera)
37. **tick 228, Zeus:** goal ended (achieved) (declaration)
   - goal: "understand Hera{}"
38. **tick 238, Hera:** move → olympus-gate (context-backed)
   - under goal: "Seek a resolution with Zeus" (→ zeus)
   - caused: entity-moved (hera)
39. **tick 253, Zeus:** goal set → hera (declaration)
   - goal: "regain Hera's respect"
40. **tick 268, Hera:** move → great-hall (context-backed)
   - under goal: "Seek a resolution with Zeus" (→ zeus)
   - caused: entity-moved (hera)
41. **tick 274, Hera:** goal ended (abandoned) (declaration)
   - goal: "Seek a resolution with Zeus"
42. **tick 283, Zeus:** goal ended (abandoned) (declaration)
   - goal: "regain Hera's respect"
43. **tick 283, Zeus:** goal set → hera (declaration)
   - goal: " regain Hera\u2019s respect"
44. **tick 286, Hera:** legend (ability-backed)
   - says: "My own sorrow, a weight that presses upon me like a physical force, weighs heavily on my heart, as I have been kept in the dark by those who should be closest to me. The memories of what I have endured still burn within me, and I fear that the fire will never truly fade."
   - heard by: no one
   - caused: legend-recorded (hera)
45. **tick 296, Hera:** goal set → great-hall (declaration)
   - goal: "I want to process Zeus' words and remember his tone, then determine the best course of action."

## What the world did

- tick 1: farmer cannot get planks (no-seller)
- tick 1: farmer cannot get food (no-buyer)
- tick 3: farmer cannot get food (no-seller)
- tick 4: woodcutter cannot get food (no-funds)
- tick 5: farmer prayed to hera: help with food [evt-5-24]
- tick 7: woodcutter prayed to zeus: help with food [evt-7-32]
- tick 9: farmer cannot get food (no-seller)
- tick 10: woodcutter cannot get food (no-funds)
- tick 12: farmer cannot get food (no-seller)
- tick 15: woodcutter cannot get food (no-funds)
- tick 17: farmer cannot get food (no-seller)
- tick 20: farmer cannot get food (no-seller)
- tick 23: woodcutter cannot get food (no-funds)
- tick 25: farmer cannot get food (no-seller)
- tick 28: woodcutter cannot get food (no-funds)
- tick 30: farmer cannot get food (no-seller)
- tick 33: farmer cannot get food (no-seller)
- tick 36: woodcutter cannot get food (no-funds)
- tick 38: farmer cannot get food (no-seller)
- tick 41: woodcutter cannot get food (no-funds)
- tick 43: farmer cannot get food (no-seller)
- tick 46: farmer cannot get food (no-seller)
- tick 49: woodcutter cannot get food (no-funds)
- tick 51: farmer cannot get food (no-seller)
- tick 54: woodcutter cannot get food (no-funds)
- tick 56: farmer cannot get food (no-seller)
- tick 59: farmer cannot get food (no-seller)
- tick 62: woodcutter cannot get food (no-funds)
- tick 64: farmer cannot get food (no-seller)
- tick 67: woodcutter cannot get food (no-funds)
- tick 69: farmer cannot get food (no-seller)
- tick 72: farmer cannot get food (no-seller)
- tick 75: woodcutter cannot get food (no-funds)
- tick 77: farmer cannot get food (no-seller)
- tick 80: woodcutter cannot get food (no-funds)
- tick 82: farmer cannot get food (no-seller)
- tick 85: farmer cannot get food (no-seller)
- tick 88: woodcutter cannot get food (no-funds)
- tick 90: farmer cannot get food (no-seller)
- tick 93: woodcutter cannot get food (no-funds)
- tick 95: farmer cannot get food (no-seller)
- tick 98: farmer cannot get food (no-seller)
- tick 101: woodcutter cannot get food (no-funds)
- tick 103: farmer cannot get food (no-seller)
- tick 106: woodcutter cannot get food (no-funds)
- tick 108: farmer cannot get food (no-seller)
- tick 111: farmer cannot get food (no-seller)
- tick 114: woodcutter cannot get food (no-funds)
- tick 116: farmer cannot get food (no-seller)
- tick 119: woodcutter cannot get food (no-funds)
- tick 121: farmer cannot get food (no-seller)
- tick 124: farmer cannot get food (no-seller)
- tick 127: woodcutter cannot get food (no-funds)
- tick 129: farmer cannot get food (no-seller)
- tick 132: woodcutter cannot get food (no-funds)
- tick 134: farmer cannot get food (no-seller)
- tick 137: hera's change to her goal was refused (locked, 29 ticks left)
- tick 137: farmer cannot get food (no-seller)
- tick 140: woodcutter cannot get food (no-funds)
- tick 142: farmer cannot get food (no-seller)
- tick 145: woodcutter cannot get food (no-funds)
- tick 147: farmer cannot get food (no-seller)
- tick 150: farmer cannot get food (no-seller)
- tick 153: woodcutter cannot get food (no-funds)
- tick 155: farmer cannot get food (no-seller)
- tick 158: woodcutter cannot get food (no-funds)
- tick 160: farmer cannot get food (no-seller)
- tick 163: farmer cannot get food (no-seller)
- tick 165: hera's change to her goal was refused (locked, 33 ticks left)
- tick 166: woodcutter cannot get food (no-funds)
- tick 168: farmer cannot get food (no-seller)
- tick 171: woodcutter cannot get food (no-funds)
- tick 172: hera's change to her goal was refused (locked, 26 ticks left)
- tick 173: farmer cannot get food (no-seller)
- tick 176: farmer cannot get food (no-seller)
- tick 177: zeus's change to his goal was refused (locked, 25 ticks left)
- tick 179: woodcutter cannot get food (no-funds)
- tick 180: hera's change to her goal was refused (locked, 18 ticks left)
- tick 181: farmer cannot get food (no-seller)
- tick 184: woodcutter cannot get food (no-funds)
- tick 186: farmer cannot get food (no-seller)
- tick 189: farmer cannot get food (no-seller)
- tick 192: woodcutter cannot get food (no-funds)
- tick 193: hera's change to her goal was refused (locked, 5 ticks left)
- tick 194: farmer cannot get food (no-seller)
- tick 197: woodcutter cannot get food (no-funds)
- tick 199: farmer cannot get food (no-seller)
- tick 202: farmer cannot get food (no-seller)
- tick 205: woodcutter cannot get food (no-funds)
- tick 207: farmer cannot get food (no-seller)
- tick 210: woodcutter cannot get food (no-funds)
- tick 212: farmer cannot get food (no-seller)
- tick 215: farmer cannot get food (no-seller)
- tick 218: woodcutter cannot get food (no-funds)
- tick 220: farmer cannot get food (no-seller)
- tick 223: woodcutter cannot get food (no-funds)
- tick 225: farmer cannot get food (no-seller)
- tick 228: farmer cannot get food (no-seller)
- tick 231: woodcutter cannot get food (no-funds)
- tick 233: farmer cannot get food (no-seller)
- tick 236: woodcutter cannot get food (no-funds)
- tick 238: farmer cannot get food (no-seller)
- tick 241: farmer cannot get food (no-seller)
- tick 244: woodcutter cannot get food (no-funds)
- tick 246: farmer cannot get food (no-seller)
- tick 249: woodcutter cannot get food (no-funds)
- tick 251: farmer cannot get food (no-seller)
- tick 254: farmer cannot get food (no-seller)
- tick 256: farmer's prayer to hera lapsed unanswered [evt-5-24]
- tick 256: farmer remembers hera's silence
- tick 256: farmer → hera: affinity -2, grudge +1
- tick 257: woodcutter cannot get food (no-funds)
- tick 258: zeus's change to his goal was refused (locked, 35 ticks left)
- tick 258: farmer prayed to zeus: help with food [evt-258-1290]
- tick 258: woodcutter cannot get wood (no-buyer)
- tick 258: woodcutter's prayer to zeus lapsed unanswered [evt-7-32]
- tick 258: woodcutter remembers zeus's silence
- tick 258: woodcutter → zeus: affinity -2, grudge +1
- tick 262: woodcutter cannot get food (no-funds)
- tick 264: woodcutter prayed to hera: help with food [evt-264-1321]
- tick 264: farmer cannot get food (no-seller)
- tick 267: farmer cannot get food (no-seller)
- tick 270: farmer cannot get food (no-seller)
- tick 273: woodcutter cannot get food (no-funds)
- tick 275: farmer cannot get food (no-seller)
- tick 278: woodcutter cannot get food (no-funds)
- tick 280: farmer cannot get food (no-seller)
- tick 283: farmer cannot get food (no-seller)
- tick 286: woodcutter cannot get food (no-funds)
- tick 288: farmer cannot get food (no-seller)
- tick 291: woodcutter cannot get food (no-funds)
- tick 293: farmer cannot get food (no-seller)
- tick 296: farmer cannot get food (no-seller)
- tick 299: woodcutter cannot get food (no-funds)

## Repetition

- Zeus: longest run 11 of report:hera (cap 3). Choices: report:hera ×11, goal: ×5, move:olympus-gate ×1, realm-transition:mountain-path ×1, move:town-square ×1
- Hera: longest run 7 of report:zeus (cap 3). Choices: goal: ×10, report:zeus ×7, move:olympus-gate ×2, move:great-hall ×2, legend:legend ×2

## Automated checks

| God | Check | Result | Detail |
| --- | --- | --- | --- |
| Zeus | profile trace | pass | 14 actions: 0 ability-backed, 14 context-backed |
| Zeus | repetition | FAIL | longest run 11 of report:hera (cap 3) |
| Zeus | minimum activity | pass | 14 committed model actions (at least 5) |
| Zeus | influence | pass | 8 caused (told belief, relationship-changed) |
| Zeus | goal set | pass | 5 goals set (at least 1) |
| Zeus | goal ended | pass | 4 goals ended (abandoned, achieved); at least 1, any outcome |
| Zeus | petition heard | pass | 2 petitions addressed to this god (at least 1) |
| Zeus | petition answered | FAIL | 2 heard, none answered (at least 1) |
| Hera | profile trace | pass | 13 actions: 2 ability-backed, 11 context-backed |
| Hera | repetition | FAIL | longest run 7 of report:zeus (cap 3) |
| Hera | minimum activity | pass | 13 committed model actions (at least 5) |
| Hera | influence | pass | 5 caused (told belief, relationship-changed) |
| Hera | goal set | pass | 5 goals set (at least 1) |
| Hera | goal ended | pass | 4 goals ended (abandoned, achieved); at least 1, any outcome |
| Hera | petition heard | pass | 2 petitions addressed to this god (at least 1) |
| Hera | petition answered | FAIL | 2 heard, none answered (at least 1) |

## Model run

- 87 requests: 80 answered (80 native, 0 repaired), 7 exhausted; latency p50 2877 ms, p95 4748 ms; prompt p50 7385 / max 8522 characters; frames showed model-degraded in 8% of polls
- exhaustion: 5 × content: content must be 1 to 280 characters; 1 × to: to must be one of the ids you can see: olympus-gate; 1 × assertion: assertion must be 1 to 280 characters
- valid actions: held (57 proposals, all god actions, none rejected as malformed)
- perception compliance: held (every id named by 57 proposals was in the prompt behind it)
- relationship change with provenance: held (5 changes, 5 explained from the log alone, e.g. report-told > memory-recorded > relationship-changed)
- changed next action: held (hera: report:zeus,zeus,hera before its first belief, report:zeus,zeus,hera,zeus after (changed))
- goal privacy: held (87 prompts checked against 10 goals: none carried another god's goal outside a told account or a perceived legend)
- petition privacy: held (87 prompts checked against 4 petitions: none listed a petition addressed to another god)

## Owner rubric

Score each 0, 1, or 2: 0 = replan pressure, 1 = needs tuning, 2 = good enough to continue. The owner scores; nothing above is a score.

| Dimension | Score (0/1/2) | Notes |
| --- | --- | --- |
| Novelty |  |  |
| Causality |  |  |
| Recognizable identity |  |  |
| Pacing |  |  |
| Inspectability |  |  |

Decision: continue / tune / replan: 
