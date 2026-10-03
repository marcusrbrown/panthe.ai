| Setting | Hour | commit:total | commit overhead | sql:trace | WAL peak |
| --- | --- | --- | --- | --- | --- |
| default (wal_autocheckpoint=1000 pages, cache 2 MiB) | 17577 ms | 10401 ms | 7168 ms | 2202 ms | 32 KiB |
| wal_autocheckpoint=0 | 11882 ms | 4520 ms | 2094 ms | 1428 ms | 1025160 KiB |
| wal_autocheckpoint=16384 (64 MiB) | 13456 ms | 6153 ms | 3804 ms | 1379 ms | 32 KiB |
| cache_size=64 MiB | 16707 ms | 9272 ms | 7030 ms | 1259 ms | 32 KiB |
| wal_autocheckpoint=16384 + cache_size=64 MiB | 14166 ms | 6873 ms | 4567 ms | 1313 ms | 32 KiB |
