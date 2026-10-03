| 72,000 inserts into a 500,000-row table | Total |
| --- | --- |
| random ids, select then insert (what the trace did) | 2679 ms |
| random ids, cached statement | 2618 ms |
| random ids, `ON CONFLICT DO NOTHING` | 2517 ms |
| random ids, cached, 64 MiB page cache | 2581 ms |
| time-ordered ids, select then insert | 330 ms |
| time-ordered ids, cached statement | 217 ms |
