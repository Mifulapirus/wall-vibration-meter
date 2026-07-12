#!/usr/bin/env python3
"""Standalone reader for the DSL USB sound meter (no vendor software needed).

Prints live readings and optionally logs them to CSV. To push readings to the
Capek-web server instead, use meter_agent.py. Protocol details: METER_PROTOCOLS.md.

Requires: pip install hidapi
"""
import argparse
import csv
import sys
import time

import meterlib as ml


def main():
    ap = argparse.ArgumentParser(description="Read the DSL USB sound meter.")
    ap.add_argument("--interval", type=float, default=1.0, help="seconds between samples")
    ap.add_argument("--duration", type=float, default=None, help="stop after N seconds")
    ap.add_argument("--csv", help="append readings to this CSV file")
    args = ap.parse_args()

    if ml.hid is None:
        sys.exit("Missing dependency: pip install hidapi")

    meters = []
    h = ml.open_meter(ml.DSL)
    if h:
        meters.append((ml.DSL["name"], h, ml.read_dsl))
        print(f"# {ml.DSL['name']} connected ({ml.DSL['vid']:#06x}:{ml.DSL['pid']:#06x})", file=sys.stderr)
    else:
        print(f"# {ml.DSL['name']} NOT available (close SoundLab first)", file=sys.stderr)
    if not meters:
        sys.exit("No meters available.")

    writer = fh = None
    if args.csv:
        new = True
        try:
            new = open(args.csv).read(1) == ""
        except FileNotFoundError:
            pass
        fh = open(args.csv, "a", newline="")
        writer = csv.writer(fh)
        if new:
            writer.writerow(["host_time", "meter", "dB", "tempC", "weighting", "mode", "device_ts"])

    start = time.time()
    try:
        while args.duration is None or time.time() - start < args.duration:
            row_time = time.strftime("%Y-%m-%d %H:%M:%S")
            cells = []
            for name, h, reader in meters:
                r = reader(h)
                if r:
                    cells.append(f"{name}: {r['dB']:6.1f} dB"
                                 + (f" {r['weighting']}/{r['mode']}" if r['weighting'] else "")
                                 + (f" {r['tempC']:.1f}C" if r['tempC'] is not None else ""))
                    if writer:
                        writer.writerow([row_time, name, r["dB"], r["tempC"],
                                         r["weighting"], r["mode"], r["dev_ts"]])
                else:
                    cells.append(f"{name}: (no data)")
            if fh:
                fh.flush()
            print(f"{row_time}  " + "   ".join(cells), flush=True)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        pass
    finally:
        for _, h, _ in meters:
            h.close()
        if fh:
            fh.close()


if __name__ == "__main__":
    main()
