"""Tiny static file server for local dev that disables browser caching,
so edits to app.js/styles.css always show on a normal refresh (no hard-refresh).
Usage: python serve.py [port]
"""
import http.server
import os
import socketserver
import sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5500


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


with socketserver.TCPServer(("", PORT), NoCacheHandler) as httpd:
    print(f"Serving {os.getcwd()} at http://localhost:{PORT} (no-cache)")
    httpd.serve_forever()
