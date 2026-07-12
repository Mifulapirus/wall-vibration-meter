#!/usr/bin/env python3
"""Push live DSL sound-meter readings from this PC to the Capek-web server.

The meter is USB-connected to this machine; the website runs elsewhere. This
agent samples the DSL meter and POSTs batches to the server's /api/noise/live
endpoint, where they land as an ordinary Noise "source" (DSL) and show up in the
existing dashboard, sleep, and heatmap views — no file import.

Readings are buffered locally and retried, so a brief network/server outage
doesn't lose data.

Usage:
    python tools/meter_agent.py --server https://capek.example.dev --token SECRET
    python tools/meter_agent.py --server http://localhost:5006

Requires: pip install hidapi   (server URL/token via flags or env SERVER_URL/INGEST_TOKEN)
"""
import argparse
import collections
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

import meterlib as ml


def iso_now():
    return datetime.now(timezone.utc).isoformat()


def post_batch(url, token, items, timeout=10, insecure=False):
    """POST readings; return True on 2xx. Raises on network error."""
    body = json.dumps({"readings": items}).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    if token:
        req.add_header("X-Device-Token", token)
    ctx = None
    if insecure:
        import ssl
        ctx = ssl._create_unverified_context()
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        return 200 <= resp.status < 300


def main():
    ap = argparse.ArgumentParser(description="Push meter readings to Capek-web.")
    ap.add_argument("--server", default=os.environ.get("SERVER_URL"),
                    help="base URL, e.g. https://capek.example.dev (env SERVER_URL)")
    ap.add_argument("--token", default=os.environ.get("INGEST_TOKEN", ""),
                    help="ingest token (env INGEST_TOKEN); omit if server is open")
    ap.add_argument("--interval", type=float, default=1.0, help="seconds between samples")
    ap.add_argument("--flush", type=float, default=5.0, help="seconds between server pushes")
    ap.add_argument("--duration", type=float, default=None, help="stop after N seconds")
    ap.add_argument("--name", default="DSL", help="Noise source name to store readings under")
    ap.add_argument("--max-buffer", type=int, default=100000, help="max buffered readings when offline")
    ap.add_argument("--insecure", action="store_true", help="skip TLS certificate verification")
    ap.add_argument("--csv", help="also append readings to this CSV locally")
    args = ap.parse_args()

    if ml.hid is None:
        sys.exit("Missing dependency: pip install hidapi")
    if not args.server:
        sys.exit("--server (or env SERVER_URL) is required")
    url = args.server.rstrip("/") + "/api/noise/live"

    sname = args.name.strip() or "DSL"
    meters = []
    h = ml.open_meter(ml.DSL)
    if h:
        meters.append((sname, h, ml.read_dsl))
        print(f"# {ml.DSL['name']} -> source '{sname}'", file=sys.stderr)
    else:
        print(f"# {ml.DSL['name']} NOT available (close SoundLab first)", file=sys.stderr)
    if not meters:
        sys.exit("No meters available.")
    print(f"# pushing to {url}" + (" (token set)" if args.token else " (no token)"), file=sys.stderr)

    csv_fh = None
    if args.csv:
        csv_fh = open(args.csv, "a", newline="")

    buffer = collections.deque(maxlen=args.max_buffer)
    start = time.time()
    last_flush = 0.0
    dropped = 0
    try:
        while args.duration is None or time.time() - start < args.duration:
            tick = time.time()
            ts = iso_now()
            present = {}
            for sname, h, reader in meters:
                r = reader(h)
                if not r:
                    continue
                present[sname] = r["dB"]
                item = {"source": sname, "ts": ts, "spl_db": round(r["dB"], 2)}
                buffer.append(item)
                if csv_fh:
                    csv_fh.write(f"{ts},{sname},{r['dB']}\n")
            if csv_fh:
                csv_fh.flush()

            # Flush to server on cadence (snapshot-then-drop so failures keep data).
            if buffer and time.time() - last_flush >= args.flush:
                batch = list(buffer)
                try:
                    post_batch(url, args.token, batch, insecure=args.insecure)
                    for _ in range(len(batch)):
                        buffer.popleft()
                    last_flush = time.time()
                    line = "  ".join(f"{k}={v:.1f}" for k, v in present.items())
                    print(f"{ts}  sent {len(batch):3d}  buffer={len(buffer):4d}  {line}", flush=True)
                except Exception as e:  # noqa: BLE001 — keep buffering, retry next flush
                    if len(buffer) == buffer.maxlen:
                        dropped += 1
                    print(f"{ts}  push failed ({e}); buffering {len(buffer)}"
                          + (f" (dropping oldest, {dropped} lost)" if dropped else ""),
                          file=sys.stderr, flush=True)
                    last_flush = time.time()

            elapsed = time.time() - tick
            time.sleep(max(0.0, args.interval - elapsed))
    except KeyboardInterrupt:
        pass
    finally:
        # Best-effort final flush.
        if buffer:
            try:
                post_batch(url, args.token, list(buffer), insecure=args.insecure)
                print(f"# flushed final {len(buffer)} on exit", file=sys.stderr)
            except Exception as e:  # noqa: BLE001
                print(f"# {len(buffer)} readings unsent on exit: {e}", file=sys.stderr)
        for _, h, _ in meters:
            h.close()
        if csv_fh:
            csv_fh.close()


if __name__ == "__main__":
    main()
