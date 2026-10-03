# Catch-up benchmark: baseline-d566975

Pack sha256 3d26995b7201ccc4ece377c2f253e4e8e0d1f7ef5b5a95beca5917cf1ea34399; 5 repetitions per configuration.

| Mortals | World | Runs | Median hour | Range | Median chunk gap | Worst chunk gap | Median chunk held | Worst chunk held | Events |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | fresh | 5 | 0.91 s | 0.86–1.04 s | 12.8 ms | 29.6 ms | 13.6 ms | 33.1 ms | 29896 |
| 4 | aged (6 h) | 5 | 2.88 s | 2.76–3.25 s | 46 ms | 432.2 ms | 46.6 ms | 132.8 ms | 29912 |
| 20 | fresh | 5 | 4.96 s | 4.78–5.02 s | 81.4 ms | 122.4 ms | 85.5 ms | 136.2 ms | 96909 |
| 20 | aged (6 h) | 5 | 22.48 s | 22.02–44.21 s | 355.3 ms | 1466 ms | 349.4 ms | 1013.8 ms | 95457 |

## 4 mortals, fresh

| Phase | Median ms / hour | Share | Entries | |
| --- | --- | --- | --- | --- |
| sim:routine-planning | 83.6 | 8.5% | 3660 |  |
| sim:step-world-tick | 147.6 | 15% | 3600 |  |
| sim:event-list-copy | 4.1 | 0.4% | 3600 |  |
| sim:screen-observations | 3.2 | 0.3% | 60 |  |
| sim:read-pending | 3 | 0.3% | 60 |  |
| commit:total | 714.7 | 72.4% | 60 |  |
| commit:ending-total | 29.7 | 3% | 1 |  |
| yield | 1.5 | 0.2% | 59 |  |
| **instrumented hour** | 987.2 | 100% | 1 |  |
| *inside the commit* | | | | |
| sql:events | 109.5 | 11.1% | 29960 |  |
| sql:projection | 2.4 | 0.2% | 122 |  |
| codec:decode | 12.3 | 1.2% | 61 |  |
| reduce:applyEvent | 17.3 | 1.7% | 29896 |  |
| codec:encode | 1 | 0.1% | 61 |  |
| json:parse-large | 0 | 0% | 0 |  |
| json:stringify-large | 0 | 0% | 0 |  |
| commit:on-committed | 217.4 | 22% | 61 |  |
| sql:trace | 152.2 | 15.4% | 57015 |  |
| sql:other | 4.1 | 0.4% | 247 |  |
| sql:transaction-control | 0 | 0% | 0 |  |
| commit overhead (BEGIN, COMMIT, WAL write) | 360.6 | 36.5% | 1 |  |

| Rows added in the hour | Count | Bytes |
| --- | --- | --- |
| events | 29896 | 8104 KiB |
| trace observations | 14400 | 2571 KiB |
| trace proposal outcomes | 14400 | 3122 KiB |
| trace outcome-event links | 13575 | |
| projection row (end of hour) | 1 | 45 KiB |
| WAL peak | | 5886 KiB |
| database file growth | | 25412 KiB |

## 4 mortals, aged

| Phase | Median ms / hour | Share | Entries | |
| --- | --- | --- | --- | --- |
| sim:routine-planning | 385.8 | 14% | 3660 |  |
| sim:step-world-tick | 177.1 | 6.4% | 3600 |  |
| sim:event-list-copy | 3.7 | 0.1% | 3600 |  |
| sim:screen-observations | 4.5 | 0.2% | 60 |  |
| sim:read-pending | 4.8 | 0.2% | 60 |  |
| commit:total | 2130.7 | 77.4% | 60 |  |
| commit:ending-total | 30.1 | 1.1% | 1 |  |
| yield | 4.9 | 0.2% | 59 |  |
| **instrumented hour** | 2752.8 | 100% | 1 |  |
| *inside the commit* | | | | |
| sql:events | 133.7 | 4.9% | 29976 |  |
| sql:projection | 7.1 | 0.3% | 122 |  |
| codec:decode | 25.5 | 0.9% | 61 |  |
| reduce:applyEvent | 21 | 0.8% | 29912 |  |
| codec:encode | 1.2 | 0% | 61 |  |
| json:parse-large | 27.9 | 1% | 61 |  |
| json:stringify-large | 8.3 | 0.3% | 61 |  |
| commit:on-committed | 300.9 | 10.9% | 61 |  |
| sql:trace | 233.2 | 8.5% | 57014 |  |
| sql:other | 5.6 | 0.2% | 247 |  |
| sql:transaction-control | 0 | 0% | 0 |  |
| commit overhead (BEGIN, COMMIT, WAL write) | 1613.2 | 58.6% | 1 |  |

| Rows added in the hour | Count | Bytes |
| --- | --- | --- |
| events | 29912 | 8357 KiB |
| trace observations | 14400 | 2590 KiB |
| trace proposal outcomes | 14400 | 3121 KiB |
| trace outcome-event links | 13574 | |
| projection row (end of hour) | 1 | 161 KiB |
| WAL peak | | 8127 KiB |
| database file growth | | 26288 KiB |

## 20 mortals, fresh

| Phase | Median ms / hour | Share | Entries | |
| --- | --- | --- | --- | --- |
| sim:routine-planning | 1044.1 | 20.2% | 3660 |  |
| sim:step-world-tick | 688.5 | 13.3% | 3600 |  |
| sim:event-list-copy | 9.1 | 0.2% | 3600 |  |
| sim:screen-observations | 12.1 | 0.2% | 60 |  |
| sim:read-pending | 4.9 | 0.1% | 60 |  |
| commit:total | 3286.2 | 63.7% | 60 |  |
| commit:ending-total | 105.5 | 2% | 1 |  |
| yield | 2.3 | 0% | 59 |  |
| **instrumented hour** | 5157.7 | 100% | 1 |  |
| *inside the commit* | | | | |
| sql:events | 361.9 | 7% | 96973 |  |
| sql:projection | 6.5 | 0.1% | 122 |  |
| codec:decode | 27.5 | 0.5% | 61 |  |
| reduce:applyEvent | 91.9 | 1.8% | 96909 |  |
| codec:encode | 1.8 | 0% | 61 |  |
| json:parse-large | 25.8 | 0.5% | 47 |  |
| json:stringify-large | 7.6 | 0.1% | 48 |  |
| commit:on-committed | 1097.1 | 21.3% | 61 |  |
| sql:trace | 804.2 | 15.6% | 267916 |  |
| sql:other | 5.7 | 0.1% | 247 |  |
| sql:transaction-control | 0 | 0% | 0 |  |
| commit overhead (BEGIN, COMMIT, WAL write) | 1701 | 33% | 1 |  |

| Rows added in the hour | Count | Bytes |
| --- | --- | --- |
| events | 96909 | 27938 KiB |
| trace observations | 72000 | 13984 KiB |
| trace proposal outcomes | 72000 | 17962 KiB |
| trace outcome-event links | 50716 | |
| projection row (end of hour) | 1 | 221 KiB |
| WAL peak | | 10610 KiB |
| database file growth | | 112108 KiB |

## 20 mortals, aged

| Phase | Median ms / hour | Share | Entries | |
| --- | --- | --- | --- | --- |
| sim:routine-planning | 8315.1 | 35.7% | 3660 |  |
| sim:step-world-tick | 1071.3 | 4.6% | 3600 |  |
| sim:event-list-copy | 10.7 | 0% | 3600 |  |
| sim:screen-observations | 33.2 | 0.1% | 60 |  |
| sim:read-pending | 8.6 | 0% | 60 |  |
| commit:total | 13481.4 | 58% | 60 |  |
| commit:ending-total | 186.8 | 0.8% | 1 |  |
| yield | 75.2 | 0.3% | 59 |  |
| **instrumented hour** | 23261.5 | 100% | 1 |  |
| *inside the commit* | | | | |
| sql:events | 469.2 | 2% | 95521 |  |
| sql:projection | 39 | 0.2% | 122 |  |
| codec:decode | 100.1 | 0.4% | 61 |  |
| reduce:applyEvent | 102 | 0.4% | 95457 |  |
| codec:encode | 3.8 | 0% | 61 |  |
| json:parse-large | 121.4 | 0.5% | 61 |  |
| json:stringify-large | 40.7 | 0.2% | 61 |  |
| commit:on-committed | 4210 | 18.1% | 61 |  |
| sql:trace | 3712.9 | 16% | 271103 |  |
| sql:other | 10.3 | 0% | 247 |  |
| sql:transaction-control | 0 | 0% | 0 |  |
| commit overhead (BEGIN, COMMIT, WAL write) | 8691.1 | 37.4% | 1 |  |

| Rows added in the hour | Count | Bytes |
| --- | --- | --- |
| events | 95457 | 28690 KiB |
| trace observations | 72000 | 14058 KiB |
| trace proposal outcomes | 72000 | 17923 KiB |
| trace outcome-event links | 53903 | |
| projection row (end of hour) | 1 | 867 KiB |
| WAL peak | | 19176 KiB |
| database file growth | | 114532 KiB |

## Digests

```json
[
  {
    "mortals": 4,
    "world": "fresh",
    "eventDigests": [
      "b701313c449d4ca9330dfcda5dc71e99d41c3d28209fd576eb297c231528bcbf"
    ],
    "projectionDigests": [
      "c0d049c6d1e6ca7e467bec41563ae66abf677d2f002c2e48f62165b9da480c9e"
    ],
    "phaseRunDigestsAgree": true
  },
  {
    "mortals": 4,
    "world": "aged",
    "eventDigests": [
      "ec4784e495a9ff522ba58528cfa05d5e9b3e6826df252b6e495a4396def29641"
    ],
    "projectionDigests": [
      "05e49656fdda21f277f011f255e9fe3d6f6af8fdae7a1055afb51d734a49bf86"
    ],
    "phaseRunDigestsAgree": true
  },
  {
    "mortals": 20,
    "world": "fresh",
    "eventDigests": [
      "5fbf4a8d5c5d3103b736de42b812c2f303f6df88e5d36e30c8df8e29afed2c38"
    ],
    "projectionDigests": [
      "03e850377a46334127e256f6d674a1e3c666dbaf09220169a4dccb2396057f78"
    ],
    "phaseRunDigestsAgree": true
  },
  {
    "mortals": 20,
    "world": "aged",
    "eventDigests": [
      "1631a7143bceecac2bbbe2908681666c237805166b39b6d53adef26194adfc89"
    ],
    "projectionDigests": [
      "f3f11b5f1d9adc9053a1eeacb962ee840e4aa1f8621305f257bdff7ba658b86c"
    ],
    "phaseRunDigestsAgree": true
  }
]
```
