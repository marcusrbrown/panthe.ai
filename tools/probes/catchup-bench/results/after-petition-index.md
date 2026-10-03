# Catch-up benchmark: after-petition-index

Pack sha256 3d26995b7201ccc4ece377c2f253e4e8e0d1f7ef5b5a95beca5917cf1ea34399; 3 repetitions per configuration.

| Mortals | World | Runs | Median hour | Range | Median chunk gap | Worst chunk gap | Median chunk held | Worst chunk held | Events |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 20 | fresh | 3 | 2.99 s | 2.96–3.12 s | 48.7 ms | 80.8 ms | 50.6 ms | 70.2 ms | 96909 |
| 20 | aged (6 h) | 3 | 3.78 s | 3.47–3.8 s | 57.8 ms | 184.4 ms | 63.3 ms | 128.3 ms | 95457 |

## 20 mortals, fresh

| Phase | Median ms / hour | Share | Entries | |
| --- | --- | --- | --- | --- |
| sim:routine-planning | 455.9 | 14.4% | 3660 |  |
| sim:step-world-tick | 679.1 | 21.4% | 3600 |  |
| sim:event-list-copy | 10.6 | 0.3% | 3600 |  |
| sim:screen-observations | 10.9 | 0.3% | 60 |  |
| sim:read-pending | 3.7 | 0.1% | 60 |  |
| commit:total | 1905.8 | 60% | 60 |  |
| commit:ending-total | 100.3 | 3.2% | 1 |  |
| yield | 1.8 | 0.1% | 59 |  |
| **instrumented hour** | 3177 | 100% | 1 |  |
| *inside the commit* | | | | |
| sql:events | 357 | 11.2% | 96973 |  |
| sql:projection | 6.1 | 0.2% | 122 |  |
| codec:decode | 33.7 | 1.1% | 61 |  |
| reduce:applyEvent | 104.9 | 3.3% | 96909 |  |
| codec:encode | 2.1 | 0.1% | 61 |  |
| json:parse-large | 25.2 | 0.8% | 47 |  |
| json:stringify-large | 8 | 0.3% | 48 |  |
| commit:on-committed | 901.2 | 28.4% | 61 |  |
| sql:trace | 614.3 | 19.3% | 267916 |  |
| sql:other | 4.9 | 0.2% | 247 |  |
| sql:transaction-control | 0 | 0% | 0 |  |
| commit overhead (BEGIN, COMMIT, WAL write) | 484.6 | 15.3% | 1 |  |

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
| sim:routine-planning | 518 | 13.1% | 3660 |  |
| sim:step-world-tick | 848.6 | 21.4% | 3600 |  |
| sim:event-list-copy | 10.5 | 0.3% | 3600 |  |
| sim:screen-observations | 13.2 | 0.3% | 60 |  |
| sim:read-pending | 4 | 0.1% | 60 |  |
| commit:total | 2427.8 | 61.4% | 60 |  |
| commit:ending-total | 114.2 | 2.9% | 1 |  |
| yield | 14.1 | 0.4% | 59 |  |
| **instrumented hour** | 3956.3 | 100% | 1 |  |
| *inside the commit* | | | | |
| sql:events | 406.9 | 10.3% | 95521 |  |
| sql:projection | 29.3 | 0.7% | 122 |  |
| codec:decode | 117.4 | 3% | 61 |  |
| reduce:applyEvent | 108.8 | 2.8% | 95457 |  |
| codec:encode | 5.2 | 0.1% | 61 |  |
| json:parse-large | 136.7 | 3.5% | 61 |  |
| json:stringify-large | 41.7 | 1.1% | 61 |  |
| commit:on-committed | 961.8 | 24.3% | 61 |  |
| sql:trace | 661.6 | 16.7% | 271103 |  |
| sql:other | 5.4 | 0.1% | 247 |  |
| sql:transaction-control | 0 | 0% | 0 |  |
| commit overhead (BEGIN, COMMIT, WAL write) | 656.1 | 16.6% | 1 |  |

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
