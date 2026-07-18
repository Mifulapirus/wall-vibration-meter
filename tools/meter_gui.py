#!/usr/bin/env python3
"""Little desktop app to stream the DSL USB sound meter to Capek-web.

Double-click "Start Meter Stream.vbs" (same folder) to launch. Shows the live
DSL reading with a Start/Stop button. Readings are buffered and retried, so a
brief network blip loses nothing.

Protocols/agent internals: METER_PROTOCOLS.md, meterlib.py, meter_agent.py.
"""
import collections
import json
import ssl
import threading
import time
import tkinter as tk
import urllib.request
from datetime import datetime, timezone

import meterlib as ml

SERVER_DEFAULT = "https://wallvibe.thehomelab.dev"
# Base name; the meter's current weighting is appended -> DSL-A / DSL-C. dBA and
# dBC are different quantities, so they must never share a source (the reports'
# C-weighted low-frequency indicator and dBA WHO comparison each assume one).
# Flip the meter's A/C button mid-run and readings just route to the other.
SOURCE = "DSL"
INTERVAL = 0.3     # ~3 Hz — matches the meter's FAST response so compressor kick-on transients show
FLUSH = 2.0        # seconds between server pushes

BG = "#0f1720"; CARD = "#1b2733"; FG = "#e6edf3"; MUTE = "#8b98a5"
OK = "#3fb950"; WARN = "#d29922"; BAD = "#f85149"; ACCENT = "#2f81f7"


def iso_now():
    return datetime.now(timezone.utc).isoformat()


def post_batch(url, token, items, timeout=10, insecure=False):
    body = json.dumps({"readings": items}).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    if token:
        req.add_header("X-Device-Token", token)
    ctx = ssl._create_unverified_context() if insecure else None
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        return 200 <= resp.status < 300


class Streamer(threading.Thread):
    """Background sampling + push loop. Publishes state into `self.state`
    (guarded by `self.lock`); the UI polls it. Stops when `self.stop` is set."""
    def __init__(self, server):
        super().__init__(daemon=True)
        self.url = server.rstrip("/") + "/api/noise/live"
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.state = {
            "DSL": None, "dsl_info": "", "dsl_ok": False,
            "sent": 0, "buffered": 0, "status": "starting…", "status_kind": "warn",
        }

    def _set(self, **kw):
        with self.lock:
            self.state.update(kw)

    def snapshot(self):
        with self.lock:
            return dict(self.state)

    def run(self):
        handle = None
        buffer = collections.deque(maxlen=500000)
        last_flush = 0.0
        last_open_try = 0.0

        def ensure_open():
            nonlocal handle, last_open_try
            if handle is not None or time.time() - last_open_try < 3.0:
                return
            last_open_try = time.time()
            handle = ml.open_meter(ml.DSL)

        while not self.stop.is_set():
            tick = time.time()
            ensure_open()
            ts = iso_now()

            dsl_ok = False; dsl_info = ""; dsl_db = None
            if handle is not None:
                try:
                    r = ml.read_dsl(handle)
                except OSError:
                    try: handle.close()
                    except Exception: pass
                    handle = None; r = None
                if r:
                    dsl_ok = True; dsl_info = f"{r['weighting']} · {r['mode']}"; dsl_db = r["dB"]
                    w = r.get("weighting")
                    src = f"{SOURCE}-{w}" if w in ("A", "C") else SOURCE
                    buffer.append({"source": src, "ts": ts, "spl_db": round(r["dB"], 2)})

            self._set(DSL=dsl_db, dsl_info=dsl_info, dsl_ok=dsl_ok, buffered=len(buffer))

            # Flush to server on cadence.
            if buffer and time.time() - last_flush >= FLUSH:
                batch = list(buffer)
                try:
                    post_batch(self.url, "", batch)
                    for _ in range(len(batch)):
                        buffer.popleft()
                    with self.lock:
                        self.state["sent"] += len(batch)
                    self._set(status=f"streaming · last push OK {time.strftime('%H:%M:%S')}",
                              status_kind="ok", buffered=len(buffer))
                except Exception as e:  # noqa: BLE001
                    self._set(status=f"offline — buffering {len(buffer)} ({type(e).__name__})",
                              status_kind="bad", buffered=len(buffer))
                last_flush = time.time()

            if handle is None:
                self._set(status="no meter found — check USB / close SoundLab",
                          status_kind="bad")

            self.stop.wait(max(0.0, INTERVAL - (time.time() - tick)))

        # graceful final flush
        if buffer:
            try:
                post_batch(self.url, "", list(buffer))
            except Exception:  # noqa: BLE001
                pass
        if handle:
            try: handle.close()
            except Exception: pass


class App(tk.Tk):
    def __init__(self, autostart=False):
        super().__init__()
        self.title("Wall Vibe — Live DSL Sound Meter")
        self.configure(bg=BG)
        self.geometry("460x340")
        self.minsize(420, 320)
        self.worker = None

        tk.Label(self, text="Live Sound-Meter Stream", bg=BG, fg=FG,
                 font=("Segoe UI Semibold", 17)).pack(pady=(16, 2))
        self.sub = tk.Label(self, text="idle — press Start to stream to the server",
                            bg=BG, fg=MUTE, font=("Segoe UI", 10))
        self.sub.pack()

        srv = tk.Frame(self, bg=BG); srv.pack(pady=(10, 6))
        tk.Label(srv, text="Server", bg=BG, fg=MUTE, font=("Segoe UI", 9)).pack(side="left", padx=(0, 6))
        self.server_var = tk.StringVar(value=SERVER_DEFAULT)
        self.server_entry = tk.Entry(srv, textvariable=self.server_var, width=42,
                                     bg=CARD, fg=FG, insertbackground=FG, relief="flat")
        self.server_entry.pack(side="left", ipady=3)

        cards = tk.Frame(self, bg=BG); cards.pack(pady=8, fill="x", padx=16)
        cards.grid_columnconfigure(0, weight=1)
        c = tk.Frame(cards, bg=CARD); c.grid(row=0, column=0, padx=6, sticky="nsew")
        self.dot = tk.Label(c, text="●", bg=CARD, fg=MUTE, font=("Segoe UI", 10))
        self.dot.pack(anchor="e", padx=8, pady=(6, 0))
        tk.Label(c, text="DSL", bg=CARD, fg=MUTE, font=("Segoe UI Semibold", 11)).pack()
        self.val = tk.Label(c, text="--.-", bg=CARD, fg=FG, font=("Segoe UI", 44, "bold"))
        self.val.pack()
        tk.Label(c, text="dB", bg=CARD, fg=MUTE, font=("Segoe UI", 9)).pack()
        self.info = tk.Label(c, text=" ", bg=CARD, fg=MUTE, font=("Segoe UI", 9))
        self.info.pack(pady=(0, 8))

        self.btn = tk.Button(self, text="▶  Start", command=self.toggle,
                             bg=ACCENT, fg="white", activebackground="#4c8ef7",
                             relief="flat", font=("Segoe UI Semibold", 12), width=16, height=1)
        self.btn.pack(pady=6)

        self.status = tk.Label(self, text="idle", bg=BG, fg=MUTE, font=("Segoe UI", 9))
        self.status.pack(pady=(2, 8))

        self.protocol("WM_DELETE_WINDOW", self.on_close)
        self.after(200, self.refresh)
        if autostart:
            self.after(400, self.toggle)

    def toggle(self):
        if self.worker is None:
            self.worker = Streamer(self.server_var.get())
            self.worker.start()
            self.btn.config(text="■  Stop", bg=BAD, activebackground="#ff6b60")
            self.server_entry.config(state="disabled")
            self.sub.config(text="streaming to " + self.server_var.get())
        else:
            self.worker.stop.set()
            self.worker = None
            self.btn.config(text="▶  Start", bg=ACCENT, activebackground="#4c8ef7")
            self.server_entry.config(state="normal")
            self.sub.config(text="stopped — press Start to resume")
            self.val.config(text="--.-"); self.info.config(text=" "); self.dot.config(fg=MUTE)
            self.status.config(text="idle", fg=MUTE)

    def refresh(self):
        if self.worker is not None:
            s = self.worker.snapshot()
            val = s.get("DSL")
            self.val.config(text=f"{val:.1f}" if val is not None else "--.-")
            self.info.config(text=s.get("dsl_info") or " ")
            self.dot.config(fg=OK if s.get("dsl_ok") else BAD)
            kind = s.get("status_kind", "warn")
            self.status.config(text=f"{s.get('status','')}   ·   sent {s.get('sent',0)}   ·   "
                                    f"buffered {s.get('buffered',0)}",
                               fg={"ok": OK, "warn": WARN, "bad": BAD}.get(kind, MUTE))
        self.after(300, self.refresh)

    def on_close(self):
        if self.worker is not None:
            self.worker.stop.set()
            time.sleep(0.3)
        self.destroy()


if __name__ == "__main__":
    import sys
    App(autostart="--autostart" in sys.argv).mainloop()
