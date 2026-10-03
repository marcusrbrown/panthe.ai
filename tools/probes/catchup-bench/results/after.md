# Catch-up benchmark: after-both-fixes

Pack sha256 3d26995b7201ccc4ece377c2f253e4e8e0d1f7ef5b5a95beca5917cf1ea34399; 5 repetitions per configuration.

| Mortals | World | Runs | Median hour | Range | Median chunk gap | Worst chunk gap | Median chunk held | Worst chunk held | Events |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | fresh | 5 | 0.73 s | 0.68–0.81 s | 10.4 ms | 26.9 ms | 10.9 ms | 24.7 ms | 29896 |
| 4 | aged (6 h) | 5 | 0.8 s | 0.75–0.9 s | 11.3 ms | 38.1 ms | 12.2 ms | 38.3 ms | 29912 |
| 20 | fresh | 5 | 2.84 s | 2.65–2.91 s | 45.5 ms | 65.3 ms | 49.6 ms | 62.8 ms | 96909 |
| 20 | aged (6 h) | 5 | 3.84 s | 3.65–3.98 s | 60.3 ms | 124.4 ms | 61.8 ms | 136 ms | 95457 |

## 4 mortals, fresh

| Phase | Median ms / hour | Share | Entries | |
| --- | --- | --- | --- | --- |
| sim:routine-planning | 84 | 11.2% | 3660 |  |
| sim:step-world-tick | 134.3 | 17.8% | 3600 |  |
| sim:event-list-copy | 4.3 | 0.6% | 3600 |  |
| sim:screen-observations | 2.9 | 0.4% | 60 |  |
| sim:read-pending | 1.9 | 0.3% | 60 |  |
| commit:total | 491.9 | 65.3% | 60 |  |
| commit:ending-total | 29.6 | 3.9% | 1 |  |
| yield | 1.4 | 0.2% | 59 |  |
| **instrumented hour** | 753.3 | 100% | 1 |  |
| *inside the commit* | | | | |
| sql:events | 110.1 | 14.6% | 29960 |  |
| sql:projection | 2.9 | 0.4% | 122 |  |
| codec:decode | 13.3 | 1.8% | 61 |  |
| reduce:applyEvent | 18 | 2.4% | 29896 |  |
| codec:encode | 1 | 0.1% | 61 |  |
| json:parse-large | 0 | 0% | 0 |  |
| json:stringify-large | 0 | 0% | 0 |  |
| commit:on-committed | 192.3 | 25.5% | 61 |  |
| sql:trace | 127.8 | 17% | 57015 |  |
| sql:other | 3.1 | 0.4% | 247 |  |
| sql:transaction-control | 0 | 0% | 0 |  |
| commit overhead (BEGIN, COMMIT, WAL write) | 151 | 20% | 1 |  |

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
| sim:routine-planning | 83.9 | 9.3% | 3660 |  |
| sim:step-world-tick | 125 | 13.8% | 3600 |  |
| sim:event-list-copy | 3 | 0.3% | 3600 |  |
| sim:screen-observations | 4.9 | 0.5% | 60 |  |
| sim:read-pending | 3.2 | 0.4% | 60 |  |
| commit:total | 600.1 | 66.3% | 60 |  |
| commit:ending-total | 31.1 | 3.4% | 1 |  |
| yield | 14.1 | 1.6% | 59 |  |
| **instrumented hour** | 905.5 | 100% | 1 |  |
| *inside the commit* | | | | |
| sql:events | 116.1 | 12.8% | 29976 |  |
| sql:projection | 8.8 | 1% | 122 |  |
| codec:decode | 21.5 | 2.4% | 61 |  |
| reduce:applyEvent | 15.2 | 1.7% | 29912 |  |
| codec:encode | 1 | 0.1% | 61 |  |
| json:parse-large | 25.3 | 2.8% | 61 |  |
| json:stringify-large | 7.9 | 0.9% | 61 |  |
| commit:on-committed | 225.6 | 24.9% | 61 |  |
| sql:trace | 151.6 | 16.7% | 57014 |  |
| sql:other | 3.8 | 0.4% | 247 |  |
| sql:transaction-control | 0 | 0% | 0 |  |
| commit overhead (BEGIN, COMMIT, WAL write) | 182.7 | 20.2% | 1 |  |

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
| sim:routine-planning | 440 | 14.3% | 3660 |  |
| sim:step-world-tick | 682.1 | 22.2% | 3600 |  |
| sim:event-list-copy | 12.1 | 0.4% | 3600 |  |
| sim:screen-observations | 10 | 0.3% | 60 |  |
| sim:read-pending | 3.7 | 0.1% | 60 |  |
| commit:total | 1827.6 | 59.5% | 60 |  |
| commit:ending-total | 106.4 | 3.5% | 1 |  |
| yield | 1.6 | 0.1% | 59 |  |
| **instrumented hour** | 3071.7 | 100% | 1 |  |
| *inside the commit* | | | | |
| sql:events | 350.1 | 11.4% | 96973 |  |
| sql:projection | 5.6 | 0.2% | 122 |  |
| codec:decode | 28.1 | 0.9% | 61 |  |
| reduce:applyEvent | 88.3 | 2.9% | 96909 |  |
| codec:encode | 1.7 | 0.1% | 61 |  |
| json:parse-large | 25.5 | 0.8% | 47 |  |
| json:stringify-large | 8.4 | 0.3% | 48 |  |
| commit:on-committed | 900.9 | 29.3% | 61 |  |
| sql:trace | 603.9 | 19.7% | 267916 |  |
| sql:other | 4.6 | 0.2% | 247 |  |
| sql:transaction-control | 0 | 0% | 0 |  |
| commit overhead (BEGIN, COMMIT, WAL write) | 452.8 | 14.7% | 1 |  |

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
| sim:routine-planning | 538.7 | 13.8% | 3660 |  |
| sim:step-world-tick | 827.2 | 21.1% | 3600 |  |
| sim:event-list-copy | 11.4 | 0.3% | 3600 |  |
| sim:screen-observations | 12.7 | 0.3% | 60 |  |
| sim:read-pending | 4.5 | 0.1% | 60 |  |
| commit:total | 2377.3 | 60.8% | 60 |  |
| commit:ending-total | 110 | 2.8% | 1 |  |
| yield | 16.5 | 0.4% | 59 |  |
| **instrumented hour** | 3911.8 | 100% | 1 |  |
| *inside the commit* | | | | |
| sql:events | 357.9 | 9.1% | 95521 |  |
| sql:projection | 37.9 | 1% | 122 |  |
| codec:decode | 112.9 | 2.9% | 61 |  |
| reduce:applyEvent | 98.5 | 2.5% | 95457 |  |
| codec:encode | 4 | 0.1% | 61 |  |
| json:parse-large | 141.1 | 3.6% | 61 |  |
| json:stringify-large | 39.7 | 1% | 61 |  |
| commit:on-committed | 942.1 | 24.1% | 61 |  |
| sql:trace | 647.2 | 16.5% | 271103 |  |
| sql:other | 6.3 | 0.2% | 247 |  |
| sql:transaction-control | 0 | 0% | 0 |  |
| commit overhead (BEGIN, COMMIT, WAL write) | 638.5 | 16.3% | 1 |  |

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
