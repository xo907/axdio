"""The server half of the Hello example plugin.

Axdio loads this file when the plugin is turned on and calls register(api). Everything registered here goes away again
when the plugin is turned off, updated or removed. PLUGINS.md in Axdio's repository describes every `api` method.
"""
import threading

from flask import jsonify, request


def register(api):
    lock = threading.Lock()
    plays = api.load("plays", {})          # {username: how many songs they've played since Hello was installed}

    @api.on("play")
    def count(event):
        with lock:
            plays[event["user"]] = plays.get(event["user"], 0) + 1
            api.save("plays", plays)

    @api.route("stats", access="user")
    def stats():
        user = api.user()
        return jsonify({"user": user, "plays": plays.get(user, 0), "greeting": api.setting("hello_greeting", "Hello")})

    @api.route("wave", methods=("POST",), access="user")
    def wave():
        song = (request.get_json(silent=True) or {}).get("title") or "this song"
        api.log(f"{api.user()} waved at {song}")
        return jsonify({"ok": True})
