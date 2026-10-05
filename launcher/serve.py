"""Local web server for launch.vbs: serves this checkout on 127.0.0.1, plus a
small file API the personal edition (js/personal.js) uses for things a web
page can't do: native folder/file pickers, writing into chosen folders,
copying/moving the original model, archiving old exports, opening files the
launcher was started with.

Runs under pythonw (no console window), where sys.stderr is None - the stock
`python -m http.server` then dies on its first request log line and drops
every connection. So: send the logs nowhere and serve quietly.

Security: the API only answers requests that carry X-BM-Token, a random key
made at startup and handed out by GET /api/token. Other websites can't read
that response (no CORS headers) and can't send a custom header to us (it
needs a CORS preflight we never grant), and the Host check stops DNS
rebinding. The server only listens on 127.0.0.1.
"""
import functools
import http.server
import json
import os
import secrets
import shutil
import sys
import threading
import urllib.parse

if sys.stderr is None or sys.stdout is None:
    sys.stdout = sys.stderr = open(os.devnull, "w")

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN = secrets.token_urlsafe(24)
ALLOWED_HOSTS = {f"127.0.0.1:{port}", f"localhost:{port}"}
_dialog_lock = threading.Lock()


def _dialog(kind, title, initial, filetypes=None):
    """Native Windows picker on top of everything; None when cancelled."""
    import tkinter
    from tkinter import filedialog
    with _dialog_lock:
        tk = tkinter.Tk()
        tk.withdraw()
        tk.attributes("-topmost", True)
        try:
            opts = {"parent": tk, "title": title}
            if initial and os.path.isdir(initial):
                opts["initialdir"] = initial
            elif initial and os.path.isfile(initial):
                opts["initialdir"] = os.path.dirname(initial)
            if kind == "folder":
                path = filedialog.askdirectory(mustexist=False, **opts)
            else:
                if filetypes:
                    opts["filetypes"] = [tuple(ft) for ft in filetypes]
                path = filedialog.askopenfilename(**opts)
        finally:
            tk.destroy()
    return os.path.normpath(path) if path else None


def _explorer_windows():
    """Folders of the open File Explorer windows and their selected files."""
    import subprocess
    ps = (
        "$sh = New-Object -ComObject Shell.Application; "
        "foreach ($w in $sh.Windows()) { try { $p = $w.Document.Folder.Self.Path; "
        "if ($p) { 'D|' + $p; foreach ($i in $w.Document.SelectedItems()) { 'S|' + $i.Path } } } catch {} }"
    )
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                             capture_output=True, text=True, timeout=8,
                             creationflags=0x08000000)  # CREATE_NO_WINDOW
    except (OSError, subprocess.SubprocessError):
        return [], []
    dirs, sel = [], []
    for line in out.stdout.splitlines():
        kind, _, path = line.partition("|")
        (dirs if kind == "D" else sel).append(path.strip())
    return dirs, sel


def _locate(name, size, mtime_ms, extra_dirs):
    """Where a file the browser only knows by name/size/date lives: selected
    files in open Explorer windows first, then those windows' folders, then
    the given folders, Desktop and Downloads (each also with its Original    subfolder). Size must match; a matching
    modified time (within 2 s) wins over one that doesn't."""
    dirs, sel = _explorer_windows()
    home = os.path.expanduser("~")
    cands = [p for p in sel if os.path.basename(p).lower() == name.lower()]
    for d in dirs + list(extra_dirs or []) + [os.path.join(home, "Desktop"), os.path.join(home, "Downloads")]:
        if d:
            cands.append(os.path.join(d, name))
            cands.append(os.path.join(d, "Original", name))  # a job folder's originals
    fallback = None
    for p in cands:
        try:
            st = os.stat(p)
        except OSError:
            continue
        if st.st_size != size:
            continue
        if mtime_ms is None or abs(st.st_mtime * 1000 - mtime_ms) < 2000:
            return os.path.normpath(p)
        fallback = fallback or os.path.normpath(p)
    return fallback


def _stat(path):
    try:
        st = os.stat(path)
        return {"path": path, "exists": True, "isDir": os.path.isdir(path), "mtime": st.st_mtime, "size": st.st_size}
    except OSError:
        return {"path": path, "exists": False}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript"}

    def log_message(self, *args):
        pass

    # ── helpers ──
    def _json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _host_ok(self):
        return self.headers.get("Host", "") in ALLOWED_HOSTS

    def _authorized(self):
        return self._host_ok() and secrets.compare_digest(self.headers.get("X-BM-Token", ""), TOKEN)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _query(self):
        return urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

    # ── routes ──
    def do_GET(self):
        route = urllib.parse.urlparse(self.path).path
        if not route.startswith("/api/"):
            if not self._host_ok():
                return self._json({"error": "bad host"}, 403)
            return super().do_GET()
        if route == "/api/token":
            if not self._host_ok():
                return self._json({"error": "bad host"}, 403)
            return self._json({"token": TOKEN})
        if not self._authorized():
            return self._json({"error": "unauthorized"}, 403)
        if route == "/api/read":
            path = self._query().get("path", [""])[0]
            try:
                with open(path, "rb") as f:
                    data = f.read()
            except OSError as e:
                return self._json({"error": str(e)}, 404)
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        return self._json({"error": "not found"}, 404)

    def do_PUT(self):
        route = urllib.parse.urlparse(self.path).path
        if not self._authorized():
            return self._json({"error": "unauthorized"}, 403)
        if route != "/api/write":
            return self._json({"error": "not found"}, 404)
        path = self._query().get("path", [""])[0]
        data = self._body()
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + ".part"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, path)
        except OSError as e:
            return self._json({"error": str(e)}, 500)
        return self._json({"ok": True, "path": path})

    def do_POST(self):
        route = urllib.parse.urlparse(self.path).path
        if not self._authorized():
            return self._json({"error": "unauthorized"}, 403)
        try:
            args = json.loads(self._body() or b"{}")
        except ValueError:
            return self._json({"error": "bad json"}, 400)
        try:
            if route == "/api/pick-folder":
                return self._json({"path": _dialog("folder", args.get("title", "Choose a folder"), args.get("initial"))})
            if route == "/api/pick-file":
                return self._json({"path": _dialog("file", args.get("title", "Open"), args.get("initial"), args.get("types"))})
            if route == "/api/stat":
                return self._json({"items": [_stat(p) for p in args.get("paths", [])]})
            if route == "/api/list":
                d = args.get("dir", "")
                names = sorted(os.listdir(d)) if os.path.isdir(d) else []
                return self._json({"items": [_stat(os.path.join(d, n)) | {"name": n} for n in names]})
            if route in ("/api/copy", "/api/move"):
                src, dst = args["src"], args["dst"]
                if os.path.exists(dst) and not args.get("overwrite"):
                    return self._json({"error": f"already exists: {dst}"}, 409)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                if route == "/api/copy":
                    shutil.copy2(src, dst)
                else:
                    shutil.move(src, dst)
                return self._json({"ok": True, "path": dst})
            if route == "/api/locate":
                return self._json({"path": _locate(args["name"], args["size"], args.get("mtime"), args.get("dirs"))})
            if route == "/api/open-folder":
                os.startfile(args["path"])
                return self._json({"ok": True})
        except Exception as e:  # any failure → an error reply, never a dropped connection
            return self._json({"error": f"{type(e).__name__}: {e}"}, 500)
        return self._json({"error": "not found"}, 404)


http.server.ThreadingHTTPServer(
    ("127.0.0.1", port), functools.partial(Handler, directory=root)
).serve_forever()
