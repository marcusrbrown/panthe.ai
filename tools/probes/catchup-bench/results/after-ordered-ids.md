# Catch-up benchmark: after-ordered-ids

Pack sha256 3d26995b7201ccc4ece377c2f253e4e8e0d1f7ef5b5a95beca5917cf1ea34399; 3 repetitions per configuration.

| Mortals | World | Runs | Median hour | Range | Median chunk gap | Worst chunk gap | Median chunk held | Worst chunk held | Events |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 20 | fresh | 3 | 3.79 s | 3.74–3.85 s | 61.6 ms | 80.3 ms | 64.6 ms | 82.8 ms | 96909 |
| 20 | aged (6 h) | 3 | 12.1 s | 12.07–12.19 s | 197.6 ms | 283.6 ms | 203.3 ms | 269.4 ms | 95457 |

## 20 mortals, fresh

| Phase | Median ms / hour | Share | Entries | |
| --- | --- | --- | --- | --- |
| sim:routine-planning | 1251.9 | 31.3% | 3660 |  |
| sim:step-world-tick | 720.7 | 18% | 3600 |  |
| sim:event-list-copy | 11.6 | 0.3% | 3600 |  |
| sim:screen-observations | 11.1 | 0.3% | 60 |  |
| sim:read-pending | 4.3 | 0.1% | 60 |  |
| commit:total | 1875.7 | 46.9% | 60 |  |
| commit:ending-total | 102.6 | 2.6% | 1 |  |
| yield | 1.7 | 0% | 59 |  |
| **instrumented hour** | 3997.7 | 100% | 1 |  |
| *inside the commit* | | | | |
| sql:events | 354.7 | 8.9% | 96973 |  |
| sql:projection | 6.1 | 0.2% | 122 |  |
| codec:decode | 30 | 0.7% | 61 |  |
| reduce:applyEvent | 98.1 | 2.5% | 96909 |  |
| codec:encode | 2.2 | 0.1% | 61 |  |
| json:parse-large | 25.6 | 0.6% | 47 |  |
| json:stringify-large | 8.6 | 0.2% | 48 |  |
| commit:on-committed | 884.2 | 22.1% | 61 |  |
| sql:trace | 605.1 | 15.1% | 267916 |  |
| sql:other | 4.7 | 0.1% | 247 |  |
| sql:transaction-control | 0 | 0% | 0 |  |
| commit overhead (BEGIN, COMMIT, WAL write) | 485.5 | 12.1% | 1 |  |

| Rows added in the hour | Count | Bytes |
| --- | --- | --- |
| events | 96909 | 27938 KiB |
| trace observations | 72000 | 13984 KiB |
| trace proposal outcomes | 72000 | 17962 KiB |
| trace outcome-event links | 50716 | |
| projection row (end of hour) | 1 | 221 KiB |
| WAL peak | | 5963 KiB |
| database file growth | | 110536 KiB |

## 20 mortals, aged

| Phase | Median ms / hour | Share | Entries | |
| --- | --- | --- | --- | --- |
| sim:routine-planning | 8739.3 | 70.3% | 3660 |  |
| sim:step-world-tick | 1102.6 | 8.9% | 3600 |  |
| sim:event-list-copy | 10.4 | 0.1% | 3600 |  |
| sim:screen-observations | 12.4 | 0.1% | 60 |  |
| sim:read-pending | 5 | 0% | 60 |  |
| commit:total | 2388.3 | 19.2% | 60 |  |
| commit:ending-total | 170 | 1.4% | 1 |  |
| yield | 14.2 | 0.1% | 59 |  |
| **instrumented hour** | 12439.1 | 100% | 1 |  |
| *inside the commit* | | | | |
| sql:events | 475.8 | 3.8% | 95521 |  |
| sql:projection | 30.7 | 0.2% | 122 |  |
| codec:decode | 100.9 | 0.8% | 61 |  |
| reduce:applyEvent | 111.2 | 0.9% | 95457 |  |
| codec:encode | 3.9 | 0% | 61 |  |
| json:parse-large | 136.3 | 1.1% | 61 |  |
| json:stringify-large | 43.3 | 0.3% | 61 |  |
| commit:on-committed | 993.8 | 8% | 61 |  |
| sql:trace | 657.4 | 5.3% | 271103 |  |
| sql:other | 5.7 | 0% | 247 |  |
| sql:transaction-control | 0 | 0% | 0 |  |
| commit overhead (BEGIN, COMMIT, WAL write) | 631.3 | 5.1% | 1 |  |

| Rows added in the hour | Count | Bytes |
| --- | --- | --- |
| events | 95457 | 28690 KiB |
| trace observations | 72000 | 14058 KiB |
| trace proposal outcomes | 72000 | 17923 KiB |
| trace outcome-event links | 53903 | |
| projection row (end of hour) | 1 | 867 KiB |
| WAL peak | | 6043 KiB |
| database file growth | | 114688 KiB |

## Digests

```json
[
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
