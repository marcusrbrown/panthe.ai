# Catch-up benchmark: after-both-fixes

Pack sha256 3d26995b7201ccc4ece377c2f253e4e8e0d1f7ef5b5a95beca5917cf1ea34399; 5 repetitions per configuration.

| Mortals | World | Runs | Median hour | Range | Median chunk gap | Worst chunk gap | Median chunk held | Worst chunk held | Events |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | fresh | 5 | 0.71 s | 0.67–0.81 s | 10.3 ms | 23.4 ms | 10.9 ms | 26.8 ms | 29896 |
| 4 | aged (6 h) | 5 | 0.82 s | 0.79–0.93 s | 11.4 ms | 34.5 ms | 12.5 ms | 36.9 ms | 29912 |
| 20 | fresh | 5 | 2.97 s | 2.75–3.02 s | 46.9 ms | 67.6 ms | 51.1 ms | 64.1 ms | 96909 |
| 20 | aged (6 h) | 5 | 3.81 s | 3.74–4.26 s | 61.4 ms | 122.6 ms | 63.8 ms | 124.3 ms | 95457 |

## 4 mortals, fresh

| Phase | Median ms / hour | Share | Entries | |
| --- | --- | --- | --- | --- |
| sim:routine-planning | 85.4 | 11.3% | 3660 |  |
| sim:step-world-tick | 130.1 | 17.1% | 3600 |  |
| sim:event-list-copy | 3.1 | 0.4% | 3600 |  |
| sim:screen-observations | 3.1 | 0.4% | 60 |  |
| sim:read-pending | 2 | 0.3% | 60 |  |
| commit:total | 498.4 | 65.7% | 60 |  |
| commit:ending-total | 31 | 4.1% | 1 |  |
| yield | 1.4 | 0.2% | 59 |  |
| **instrumented hour** | 759.1 | 100% | 1 |  |
| *inside the commit* | | | | |
| sql:events | 111.6 | 14.7% | 29960 |  |
| sql:projection | 2.4 | 0.3% | 122 |  |
| codec:decode | 12.5 | 1.6% | 61 |  |
| reduce:applyEvent | 17.2 | 2.3% | 29896 |  |
| codec:encode | 1 | 0.1% | 61 |  |
| json:parse-large | 0 | 0% | 0 |  |
| json:stringify-large | 0 | 0% | 0 |  |
| commit:on-committed | 199.9 | 26.3% | 61 |  |
| sql:trace | 129.9 | 17.1% | 57015 |  |
| sql:other | 3.1 | 0.4% | 247 |  |
| sql:transaction-control | 0 | 0% | 0 |  |
| commit overhead (BEGIN, COMMIT, WAL write) | 154.7 | 20.4% | 1 |  |

| Rows added in the hour | Count | Bytes |
| --- | --- | --- |
| events | 29896 | 8104 KiB |
| trace observations | 14400 | 2571 KiB |
| trace proposal outcomes | 14400 | 3122 KiB |
| trace outcome-event links | 13575 | |
| projection row (end of hour) | 1 | 45 KiB |
| WAL peak | | 4514 KiB |
| database file growth | | 24580 KiB |

## 4 mortals, aged

| Phase | Median ms / hour | Share | Entries | |
| --- | --- | --- | --- | --- |
| sim:routine-planning | 87 | 9.4% | 3660 |  |
| sim:step-world-tick | 159.3 | 17.3% | 3600 |  |
| sim:event-list-copy | 3 | 0.3% | 3600 |  |
| sim:screen-observations | 3 | 0.3% | 60 |  |
| sim:read-pending | 2.3 | 0.3% | 60 |  |
| commit:total | 614.1 | 66.6% | 60 |  |
| commit:ending-total | 32 | 3.5% | 1 |  |
| yield | 10 | 1.1% | 59 |  |
| **instrumented hour** | 922.1 | 100% | 1 |  |
| *inside the commit* | | | | |
| sql:events | 113 | 12.3% | 29976 |  |
| sql:projection | 5.3 | 0.6% | 122 |  |
| codec:decode | 23.2 | 2.5% | 61 |  |
| reduce:applyEvent | 17.6 | 1.9% | 29912 |  |
| codec:encode | 1.3 | 0.1% | 61 |  |
| json:parse-large | 28.1 | 3% | 61 |  |
| json:stringify-large | 8.6 | 0.9% | 61 |  |
| commit:on-committed | 219.9 | 23.8% | 61 |  |
| sql:trace | 152.5 | 16.5% | 57014 |  |
| sql:other | 3.7 | 0.4% | 247 |  |
| sql:transaction-control | 0 | 0% | 0 |  |
| commit overhead (BEGIN, COMMIT, WAL write) | 187.9 | 20.4% | 1 |  |

| Rows added in the hour | Count | Bytes |
| --- | --- | --- |
| events | 29912 | 8357 KiB |
| trace observations | 14400 | 2590 KiB |
| trace proposal outcomes | 14400 | 3121 KiB |
| trace outcome-event links | 13574 | |
| projection row (end of hour) | 1 | 161 KiB |
| WAL peak | | 4494 KiB |
| database file growth | | 26352 KiB |

## 20 mortals, fresh

| Phase | Median ms / hour | Share | Entries | |
| --- | --- | --- | --- | --- |
| sim:routine-planning | 458.2 | 14.4% | 3660 |  |
| sim:step-world-tick | 659.7 | 20.7% | 3600 |  |
| sim:event-list-copy | 12.1 | 0.4% | 3600 |  |
| sim:screen-observations | 9.6 | 0.3% | 60 |  |
| sim:read-pending | 4.3 | 0.1% | 60 |  |
| commit:total | 1909.9 | 60.1% | 60 |  |
| commit:ending-total | 105.1 | 3.3% | 1 |  |
| yield | 1.8 | 0.1% | 59 |  |
| **instrumented hour** | 3180.1 | 100% | 1 |  |
| *inside the commit* | | | | |
| sql:events | 357.7 | 11.2% | 96973 |  |
| sql:projection | 5.8 | 0.2% | 122 |  |
| codec:decode | 28.1 | 0.9% | 61 |  |
| reduce:applyEvent | 99.5 | 3.1% | 96909 |  |
| codec:encode | 1.8 | 0.1% | 61 |  |
| json:parse-large | 26.1 | 0.8% | 47 |  |
| json:stringify-large | 8.4 | 0.3% | 48 |  |
| commit:on-committed | 921.5 | 29% | 61 |  |
| sql:trace | 620.2 | 19.5% | 267916 |  |
| sql:other | 4.9 | 0.2% | 247 |  |
| sql:transaction-control | 0 | 0% | 0 |  |
| commit overhead (BEGIN, COMMIT, WAL write) | 476 | 15% | 1 |  |

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
| sim:routine-planning | 540 | 13.6% | 3660 |  |
| sim:step-world-tick | 817.7 | 20.6% | 3600 |  |
| sim:event-list-copy | 11.5 | 0.3% | 3600 |  |
| sim:screen-observations | 11.5 | 0.3% | 60 |  |
| sim:read-pending | 4.8 | 0.1% | 60 |  |
| commit:total | 2438.4 | 61.4% | 60 |  |
| commit:ending-total | 112.3 | 2.8% | 1 |  |
| yield | 13.8 | 0.3% | 59 |  |
| **instrumented hour** | 3973.5 | 100% | 1 |  |
| *inside the commit* | | | | |
| sql:events | 403.6 | 10.2% | 95521 |  |
| sql:projection | 29.2 | 0.7% | 122 |  |
| codec:decode | 116.8 | 2.9% | 61 |  |
| reduce:applyEvent | 105.2 | 2.6% | 95457 |  |
| codec:encode | 4.1 | 0.1% | 61 |  |
| json:parse-large | 143.8 | 3.6% | 61 |  |
| json:stringify-large | 42.7 | 1.1% | 61 |  |
| commit:on-committed | 974.4 | 24.5% | 61 |  |
| sql:trace | 666.6 | 16.8% | 271103 |  |
| sql:other | 5.9 | 0.1% | 247 |  |
| sql:transaction-control | 0 | 0% | 0 |  |
| commit overhead (BEGIN, COMMIT, WAL write) | 643.5 | 16.2% | 1 |  |

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
