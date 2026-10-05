"""Local web server for launch.vbs: serves this checkout on 127.0.0.1.

Runs under pythonw (no console window), where sys.stderr is None - the
stock `python -m http.server` then dies on its first request log line and
drops every connection. So: send the logs nowhere and serve quietly.
"""
import functools
import http.server
import os
import sys

if sys.stderr is None or sys.stdout is None:
    sys.stdout = sys.stderr = open(os.devnull, "w")

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript"}

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(
    ("127.0.0.1", port), functools.partial(Handler, directory=root)
).serve_forever()
