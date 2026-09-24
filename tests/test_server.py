"""End-to-end tests for the Axdio server, run against a throwaway config and music folder.

Run inside the app image (it has Flask, mutagen and ffmpeg):
    docker build -t axdio .
    docker run --rm -v "$PWD":/src -w /src --entrypoint python axdio -m unittest discover -s tests -v
"""
import gzip, hashlib, json, os, re, shutil, subprocess, sys, tempfile, threading, time, unittest, urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TMP = Path(tempfile.mkdtemp(prefix="axdio-test-"))
MUSIC, CONFIG = TMP / "music", TMP / "config"
SONGS = [("Test Artist", "First Album", "Opening", 1, 12.0), ("Test Artist", "First Album", "Second Song", 2, 9.5),
         ("Other Artist", "Other Album", "Something Else", 1, 7.25)]

def make_music():
    for artist, album, title, n, secs in SONGS:
        d = MUSIC / artist / album
        d.mkdir(parents=True, exist_ok=True)
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=44100:duration={secs}",
                        "-ac", "2", "-metadata", f"title={title}", "-metadata", f"artist={artist}", "-metadata", f"album={album}",
                        "-metadata", f"tracknumber={n}", str(d / f"{n:02d} - {title}.flac")], check=True)

make_music()
os.environ.update(CONFIG_DIR=str(CONFIG), CFG_DIR_MUSIC=str(MUSIC), SECRET_KEY="test-secret-key-for-unit-tests-only")
CONFIG.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(ROOT))
import server  # noqa: E402  (imports after the environment is prepared)

server.scan_library()


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.app.config["TESTING"] = True

    def setUp(self):
        self.c = server.app.test_client()

    def settings(self, **values):
        server.cfg_save(values)

    def register(self, name, password="long-password-1", **extra):
        r = self.c.post("/api/auth/register", json={"username": name, "password": password, **extra})
        return r

    def token(self, name, password="long-password-1"):
        r = self.c.post("/api/auth/login", json={"username": name, "password": password})
        self.assertEqual(r.status_code, 200, r.get_json())
        return r.get_json()["token"]

    def admin(self):
        self.settings(admin_user="root", admin_password=server.hash_pw("admin-password-1"))
        c = server.app.test_client()
        r = c.post("/admin/login", data={"username": "root", "password": "admin-password-1"})
        self.assertEqual(r.status_code, 302)
        return c

    def rel(self, title):
        return next(k for k, v in server.library_cache_data.items() if v.get("title") == title)


class TestBasics(Base):
    def test_health_and_headers(self):
        r = self.c.get("/api/health")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["version"], server.AXDIO_VERSION)
        self.assertEqual(r.headers["X-Content-Type-Options"], "nosniff")
        self.assertIn("frame-ancestors", r.headers["Content-Security-Policy"])

    def test_scan_found_the_songs(self):
        titles = {v["title"] for v in server.library_cache_data.values()}
        self.assertEqual(titles, {s[2] for s in SONGS})
        e = server.library_cache_data[self.rel("Opening")]
        self.assertAlmostEqual(e["duration"], 12.0, places=1)

    def test_library_is_gzipped(self):
        r = self.c.get("/api/library/cache", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(r.headers.get("Content-Encoding"), "gzip")
        data = json.loads(gzip.decompress(r.data))
        self.assertEqual(len(data["library"]), 2)

    def test_path_traversal_is_refused(self):
        for bad in ("../config/settings.json", "../../etc/passwd", "Test Artist/../../config/secret_key"):
            self.assertEqual(self.c.get("/api/stream_path", query_string={"path": bad}).status_code, 404, bad)


class TestAccounts(Base):
    def setUp(self):
        super().setUp()
        self.settings(registration="open", require_login=False, min_password_length=8, maintenance_mode=False)

    def test_register_login_sync(self):
        self.assertEqual(self.register("alice").status_code, 200)
        tok = self.token("alice")
        rel = self.rel("Opening")
        h = {"X-Auth-Token": tok}
        self.assertTrue(self.c.post("/api/user/sync", json={"liked_songs": [rel], "playlists": {"Mix": [rel]}}, headers=h).get_json()["success"])
        self.c.post("/api/user/record_play", json={"rel_path": rel}, headers=h)
        d = self.c.get("/api/user/sync", headers=h).get_json()
        self.assertEqual(d["liked_songs"], [rel])
        self.assertEqual(d["history"][0]["count"], 1)
        # Stored in SQLite with hashed tokens only.
        row = json.loads(server.db().execute("SELECT data FROM users WHERE username='alice'").fetchone()[0])
        self.assertTrue(all(len(t) == 64 for t in row["tokens"]))
        self.assertNotIn(tok, json.dumps(row))

    def test_token_in_url_is_ignored(self):
        self.register("bob")
        tok = self.token("bob")
        anon = server.app.test_client()   # no session cookie from the login above
        self.assertFalse(anon.get("/api/user/sync", query_string={"token": tok}).get_json()["authenticated"])

    def test_short_password_and_bad_username(self):
        self.assertEqual(self.register("carol", "short").status_code, 400)
        self.assertEqual(self.register("Bad Name!", "long-password-1").status_code, 400)

    def test_closed_and_invite_only(self):
        self.settings(registration="closed")
        self.assertEqual(self.register("dave").status_code, 403)
        admin = self.admin()
        self.settings(registration="invite")
        self.assertEqual(self.register("dave").status_code, 403)
        code = admin.post("/api/admin/v2/invites", json={"max_uses": 1}).get_json()["invites"][0]["code"]
        self.assertEqual(self.register("dave", invite_code=code).status_code, 200)
        self.assertEqual(self.register("erin", invite_code=code).status_code, 403)   # single use

    def test_private_server(self):
        self.register("frank")
        tok = self.token("frank")
        self.settings(require_login=True)
        anon = server.app.test_client()
        try:
            self.assertEqual(anon.get("/api/library/version").status_code, 401)
            self.assertEqual(anon.get("/api/library/version", headers={"X-Auth-Token": tok}).status_code, 200)
            self.assertEqual(server.app.test_client().get("/api/health").status_code, 200)
        finally:
            self.settings(require_login=False)

    def test_disable_and_sign_out_everywhere(self):
        self.register("gina")
        tok = self.token("gina")
        admin = self.admin()
        admin.post("/api/admin/v2/users/gina/signout")
        self.assertEqual(self.c.get("/api/user/sessions", headers={"X-Auth-Token": tok}).status_code, 401)
        admin.post("/api/admin/v2/users/gina/update", json={"disabled": True})
        self.assertEqual(self.c.post("/api/auth/login", json={"username": "gina", "password": "long-password-1"}).status_code, 403)

    def test_self_service(self):
        self.register("hank")
        tok = self.token("hank")
        h = {"X-Auth-Token": tok}
        self.token("hank")   # a second device
        self.assertEqual(len(self.c.get("/api/user/sessions", headers=h).get_json()["sessions"]), 3)
        self.assertEqual(self.c.post("/api/user/sessions/revoke", json={"others": True}, headers=h).get_json()["removed"], 2)
        export = json.loads(self.c.get("/api/user/export", headers=h).data)
        self.assertNotIn("password", export["account"])
        self.assertEqual(self.c.post("/api/user/delete_account", json={"password": "wrong"}, headers=h).status_code, 400)
        self.assertEqual(self.c.post("/api/user/delete_account", json={"password": "long-password-1"}, headers=h).status_code, 200)
        self.assertNotIn("hank", server.users_data)

    def test_login_lockout(self):
        self.settings(login_max_attempts=3)
        env = {"REMOTE_ADDR": "10.9.9.9"}
        for _ in range(3):
            self.assertEqual(self.c.post("/api/auth/login", json={"username": "x", "password": "y"}, environ_base=env).status_code, 401)
        self.assertEqual(self.c.post("/api/auth/login", json={"username": "x", "password": "y"}, environ_base=env).status_code, 429)
        self.settings(login_max_attempts=10)


class TestAdmin(Base):
    def test_admin_api_needs_login(self):
        self.assertEqual(self.c.get("/api/admin/v2/config").status_code, 401)

    def test_settings_validation_and_saving(self):
        admin = self.admin()
        self.assertEqual(admin.post("/api/admin/v2/config", json={"values": {"accent_color": "red"}}).status_code, 400)
        r = admin.post("/api/admin/v2/config", json={"values": {"site_title": "Test Server"}})
        self.assertIn("site_title", r.get_json()["changed"])
        raw = json.loads((CONFIG / "settings.json").read_text())
        self.assertNotIn("scan_interval", raw)   # defaults aren't frozen into the file
        self.assertEqual(self.c.get("/api/branding").get_json()["settings"]["site_title"], "Test Server")

    def test_maintenance_mode(self):
        admin = self.admin()
        self.settings(maintenance_mode=True)
        try:
            self.assertEqual(self.c.get("/api/library/version").status_code, 503)
            self.assertEqual(admin.get("/api/library/version").status_code, 200)
        finally:
            self.settings(maintenance_mode=False)

    def test_backups(self):
        admin = self.admin()
        names = [b["name"] for b in admin.post("/api/admin/v2/backups").get_json()["backups"]]
        self.assertTrue(names)
        with gzip.open(CONFIG / "backups" / names[0], "rt") as f:
            self.assertEqual(json.load(f)["format"], "axdio-backup")
        self.assertEqual(admin.get("/api/admin/v2/backups/..%2Fsettings.json").status_code, 404)


class TestSecurityExtras(Base):
    def test_admin_two_factor(self):
        admin = self.admin()
        secret = admin.post("/api/admin/v2/2fa", json={"action": "start"}).get_json()["secret"]
        now = int(time.time() // 30)
        self.assertEqual(admin.post("/api/admin/v2/2fa", json={"action": "confirm", "code": "000000"}).status_code, 400)
        self.assertTrue(admin.post("/api/admin/v2/2fa", json={"action": "confirm", "code": server.totp_code(secret, now)}).get_json()["enabled"])
        c = server.app.test_client()
        r = c.post("/admin/login", data={"username": "root", "password": "admin-password-1"})
        self.assertEqual(r.status_code, 200)
        self.assertIn(b'name="code"', r.data)                       # asks for the code, not signed in yet
        self.assertEqual(c.get("/api/admin/v2/me").status_code, 401)
        self.assertEqual(c.post("/admin/login", data={"code": server.totp_code(secret, now)}).status_code, 200)   # already used
        self.assertEqual(c.post("/admin/login", data={"code": server.totp_code(secret, now + 1)}).status_code, 302)
        self.assertEqual(c.get("/api/admin/v2/me").status_code, 200)
        c.post("/api/admin/v2/2fa", json={"action": "disable", "code": server.totp_code(secret, now - 1)})   # older than last use
        self.assertTrue(c.get("/api/admin/v2/2fa").get_json()["enabled"])
        server.set_admin_totp("root", "builtin", None)

    def test_metrics(self):
        self.assertEqual(self.c.get("/metrics").status_code, 404)   # off without a token
        self.settings(metrics_token="abc123")
        self.assertEqual(self.c.get("/metrics", headers={"Authorization": "Bearer nope"}).status_code, 404)
        r = self.c.get("/metrics", headers={"Authorization": "Bearer abc123"})
        self.assertIn(b"axdio_library_tracks 3", r.data)
        self.settings(metrics_token="")


class TestStreaming(Base):
    def test_original_with_range(self):
        r = self.c.get("/api/stream_path", query_string={"path": self.rel("Opening")}, headers={"Range": "bytes=0-99"})
        self.assertEqual(r.status_code, 206)
        self.assertEqual(len(r.data), 100)

    def test_data_saver_size_is_exact(self):
        rel = self.rel("Second Song")
        r = self.c.get("/api/stream_path", query_string={"path": rel, "q": "low"})
        self.assertEqual(r.mimetype, "audio/mpeg")
        body = r.data
        self.assertEqual(len(body), int(r.headers["Content-Length"]))
        samples = round(9.5 * 48000)
        self.assertEqual(len(body), (samples // 1152 + 2) * 3 * 128)
        time.sleep(0.5)
        cached = self.c.get("/api/stream_path", query_string={"path": rel, "q": "low"}, headers={"Range": "bytes=0-"})
        self.assertEqual(cached.data, body)
        cached.close()


class TestSubsonic(Base):
    def setUp(self):
        super().setUp()
        if "sub" not in server.users_data: self.register("sub")
        self.tok = self.token("sub")
        self.pw = self.c.post("/api/user/subsonic", json={"action": "create"}, headers={"X-Auth-Token": self.tok}).get_json()["password"]

    def call(self, method, **params):
        salt = "s4lt"
        q = {"u": "sub", "t": hashlib.md5((self.pw + salt).encode()).hexdigest(), "s": salt, "v": "1.16.1", "c": "test", "f": "json", **params}
        return self.c.get(f"/rest/{method}", query_string=q)

    def test_ping_and_errors(self):
        self.assertEqual(self.call("ping.view").get_json()["subsonic-response"]["status"], "ok")
        bad = self.c.get("/rest/ping", query_string={"u": "sub", "p": "nope", "f": "json"}).get_json()["subsonic-response"]
        self.assertEqual(bad["error"]["code"], 40)

    def test_browse_search_star_stream(self):
        r = self.call("search3", query="", songCount=50).get_json()["subsonic-response"]["searchResult3"]
        self.assertEqual(len(r["song"]), 3)
        song = next(s for s in r["song"] if s["title"] == "Opening")
        self.call("star", id=song["id"])
        liked = self.c.get("/api/user/sync", headers={"X-Auth-Token": self.tok}).get_json()["liked_songs"]
        self.assertIn(song["path"], liked)
        album = self.call("getAlbum", id=song["albumId"]).get_json()["subsonic-response"]["album"]
        self.assertEqual(album["songCount"], 2)
        s = self.call("stream", id=song["id"])
        self.assertEqual(s.status_code, 200)
        self.assertTrue(s.data.startswith(b"fLaC"))
        s.close()

    def test_xml(self):
        import xml.etree.ElementTree as ET
        q = {"u": "sub", "p": self.pw, "v": "1.16.1", "c": "test"}
        root = ET.fromstring(self.c.get("/rest/getArtists", query_string=q).data)
        self.assertEqual(root.get("status"), "ok")


def image_bytes(codec="png", size="640x480"):
    return subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", f"testsrc=size={size}", "-frames:v", "1",
                           "-f", "image2pipe", "-vcodec", codec, "-"], capture_output=True, check=True).stdout

def jpeg_size(data):
    """(width, height) from a JPEG's SOF marker."""
    i = 2
    while i < len(data):
        marker, length = data[i + 1], int.from_bytes(data[i + 2:i + 4], "big")
        if marker in (0xC0, 0xC1, 0xC2):
            return int.from_bytes(data[i + 7:i + 9], "big"), int.from_bytes(data[i + 5:i + 7], "big")
        i += 2 + length
    return None


class TestSharing(Base):
    def test_ids_match_the_web_apps(self):
        # The same inputs give these ids in web/app/core.js shareId().
        self.assertEqual(server.share_id("r", "deadmau5"), "20CvRJNXP7x")
        self.assertEqual(server.share_id("a", "*\x01ビートルズ — ça ☕"), "7XFXdOTPv5e")

    def test_pages(self):
        rel = self.rel("Opening")
        sid = server.share_id("t", rel)
        html = self.c.get(f"/track/{sid}").get_data(as_text=True)
        self.assertIn('<meta property="og:title" content="Opening">', html)
        self.assertIn("Test Artist", html)
        self.assertIn("/api/stream_path?path=", html)
        album = self.c.get("/album/" + server.share_id("a", "test artist\x01first album"))
        self.assertEqual(album.status_code, 200)
        self.assertIn("Second Song", album.get_data(as_text=True))
        self.assertEqual(self.c.get("/artist/" + server.share_id("r", "other artist")).status_code, 200)
        self.assertEqual(self.c.get("/track/AAAAAAAAAAA").status_code, 404)
        r = self.c.get(f"/track/{sid}/open")
        self.assertEqual(r.status_code, 302)
        self.assertIn("play=", r.headers["Location"])

    def test_preview_image(self):
        rel = self.rel("Second Song")
        cover = server.COVERS_CACHE_DIR / (hashlib.md5(rel.encode()).hexdigest() + ".jpg")
        cover.write_bytes(image_bytes("mjpeg", "300x300"))
        server.library_cache_data[rel]["has_cover"] = True   # as the scanner marks songs with embedded art
        server.rebuild_in_memory_tree()
        try:
            sid = server.share_id("t", rel)
            html = self.c.get(f"/track/{sid}").get_data(as_text=True)
            self.assertIn('property="og:image"', html)
            self.assertIn('name="theme-color" content="#', html)
            r = self.c.get(f"/track/{sid}/card.jpg")
            self.assertEqual(r.status_code, 200)
            self.assertEqual(jpeg_size(r.data), (1200, 630))
            r.close()
        finally:
            cover.unlink(missing_ok=True)
            server.library_cache_data[rel]["has_cover"] = False
            server.rebuild_in_memory_tree()

    def test_private_server(self):
        rel = self.rel("Opening")
        sid = server.share_id("t", rel)
        self.settings(require_login=True)
        anon = server.app.test_client()
        try:
            html = anon.get(f"/track/{sid}").get_data(as_text=True)
            self.assertIn("og:title", html)
            self.assertNotIn("stream_path", html)
            self.assertNotIn(Path(rel).name, html)
            self.assertIn("/?next=", anon.get(f"/track/{sid}/open").headers["Location"])
            self.settings(share_previews=False)
            self.assertEqual(anon.get(f"/track/{sid}").status_code, 302)
            self.assertEqual(anon.get(f"/track/{sid}/cover.jpg").status_code, 404)
        finally:
            self.settings(require_login=False, share_previews=True)

    def test_sharing_off(self):
        sid = server.share_id("t", self.rel("Opening"))
        self.settings(feature_sharing=False)
        try: self.assertEqual(self.c.get(f"/track/{sid}").status_code, 404)
        finally: self.settings(feature_sharing=True)


class TestAvatars(Base):
    def test_upload_replace_and_remove(self):
        self.register("ivy")
        h = {"X-Auth-Token": self.token("ivy")}
        r = self.c.post("/api/user/avatar", data=image_bytes(), headers={**h, "Content-Type": "image/png"})
        self.assertEqual(r.status_code, 200, r.get_json())
        url = r.get_json()["avatar"]
        self.assertRegex(url, r"^/api/avatar/[0-9a-f]{20}\.jpg$")
        img = self.c.get(url)
        self.assertEqual(jpeg_size(img.data), (512, 512))
        img.close()
        self.assertEqual(self.c.get("/api/user/sync", headers=h).get_json()["avatar"], url)
        self.assertEqual(self.c.post("/api/user/avatar", data=b"<svg></svg>", headers=h).status_code, 400)
        url2 = self.c.post("/api/user/avatar", data=image_bytes("mjpeg"), headers=h).get_json()["avatar"]
        self.assertEqual(self.c.get(url).status_code, 404)   # the old photo is deleted
        self.assertEqual(self.c.post("/api/user/profile", json={"avatar": "javascript:alert(1)"}, headers=h).status_code, 400)
        self.admin().post("/api/admin/v2/users/ivy/remove_avatar")
        self.assertEqual(self.c.get(url2).status_code, 404)
        self.assertEqual(server.users_data["ivy"]["avatar"], "")

    def test_turned_off(self):
        self.register("jay")
        h = {"X-Auth-Token": self.token("jay")}
        self.settings(feature_avatars=False)
        try: self.assertEqual(self.c.post("/api/user/avatar", data=image_bytes(), headers=h).status_code, 403)
        finally: self.settings(feature_avatars=True)


def b64(n, fill="A"):
    return fill * n

def fake_keys(tag="A"):
    return {"enc": b64(87, tag), "sig": b64(87, tag), "fp": (tag.lower() * 64)[:64] if tag.lower() in "abcdef" else "a" * 64,
            "backup": {"salt": b64(22), "iv": b64(16), "ct": b64(40)}}

def sealed(): return {"iv": b64(16), "ct": b64(40)}


class Social(Base):
    def user(self, name):
        if name not in server.users_data: self.register(name)
        return {"X-Auth-Token": self.token(name)}

    def friends(self, a, b):
        ha, hb = self.user(a), self.user(b)
        self.c.post("/api/social/friends/request", json={"username": b}, headers=ha)
        self.c.post("/api/social/friends/accept", json={"username": a}, headers=hb)
        return ha, hb


class TestFriends(Social):
    def test_requests_search_and_blocking(self):
        ha, hb = self.user("sam"), self.user("tia")
        self.assertEqual(self.c.get("/api/social/search?q=ti", headers=ha).get_json()["users"][0]["username"], "tia")
        pulse = self.c.get("/api/social/pulse", headers=hb).get_json()
        self.assertEqual(self.c.post("/api/social/friends/request", json={"username": "tia"}, headers=ha).get_json()["state"], "outgoing")
        after = self.c.get("/api/social/pulse", headers=hb).get_json()
        self.assertEqual(after["requests"], 1)
        self.assertGreater(after["f"], pulse["f"])
        self.assertEqual(self.c.post("/api/social/friends/accept", json={"username": "sam"}, headers=hb).get_json()["state"], "friend")
        self.assertEqual([f["username"] for f in self.c.get("/api/social/me", headers=ha).get_json()["friends"]], ["tia"])
        self.c.post("/api/social/friends/block", json={"username": "sam"}, headers=hb)
        self.assertEqual(self.c.get("/api/social/me", headers=ha).get_json()["friends"], [])
        self.assertEqual(self.c.post("/api/social/friends/request", json={"username": "tia"}, headers=ha).status_code, 403)
        self.assertEqual(self.c.get("/api/social/search?q=tia", headers=ha).get_json()["users"], [])
        self.c.post("/api/social/settings", json={"discoverable": False}, headers=ha)
        self.user("uma")
        self.assertEqual(self.c.get("/api/social/search?q=sa", headers=self.user("uma")).get_json()["users"], [])
        self.assertEqual(len(self.c.get("/api/social/search?q=sam", headers=self.user("uma")).get_json()["users"]), 1)   # exact username still works

    def test_activity_and_profiles(self):
        ha, hb = self.friends("vic", "wes")
        rel = self.rel("Opening")
        c = server.app.test_client()
        c.post("/api/auth/login", json={"username": "wes", "password": "long-password-1"})
        c.post("/api/player/now_playing", json={"src": "/api/stream_path?path=" + rel, "status": "STREAMING"})
        now = self.c.get("/api/social/activity", headers=ha).get_json()["friends"][0]["now"]
        self.assertEqual(now["rel"], rel)
        self.assertTrue(now["live"])
        prof = self.c.get("/api/social/users/wes", headers=ha).get_json()
        self.assertEqual(prof["state"], "friend")
        self.assertEqual(prof["now"]["rel"], rel)
        self.c.post("/api/social/settings", json={"share_activity": False}, headers=hb)
        self.assertIsNone(self.c.get("/api/social/activity", headers=ha).get_json()["friends"][0]["now"])
        stranger = self.c.get("/api/social/users/wes", headers=self.user("xan")).get_json()
        self.assertEqual(stranger["state"], "none")
        self.assertNotIn("recent", stranger)


class TestCollabPlaylists(Social):
    def test_editing_together(self):
        ha, hb = self.friends("yan", "zed")
        hc = self.user("amy")
        one, two, three = self.rel("Opening"), self.rel("Second Song"), self.rel("Something Else")
        pl = self.c.post("/api/social/playlists", json={"name": "Road trip", "tracks": [one], "collaborators": ["zed", "amy"]}, headers=ha).get_json()
        self.assertEqual(pl["collaborators"], ["zed"])   # amy isn't yan's friend
        op = lambda h, **d: self.c.post(f"/api/social/playlists/{pl['id']}", json=d, headers=h)
        self.assertEqual([t["r"] for t in op(hb, op="add", rels=[two, three, one]).get_json()["tracks"]], [one, two, three])
        self.assertEqual([t["by"] for t in op(hb, op="move", rel=three, before=one).get_json()["tracks"]], ["zed", "yan", "zed"])
        self.assertEqual(op(hb, op="rename", name="Mine now").status_code, 403)
        self.assertEqual(op(hc, op="add", rels=[two]).status_code, 404)
        self.assertEqual(len(op(ha, op="remove", rels=[one]).get_json()["tracks"]), 2)
        self.assertEqual(len(self.c.get("/api/social/playlists", headers=hb).get_json()["playlists"]), 1)
        op(hb, op="leave")
        self.assertEqual(self.c.get("/api/social/playlists", headers=hb).get_json()["playlists"], [])
        self.assertTrue(op(ha, op="delete").get_json()["deleted"])


class TestMessages(Social):
    def test_keys_dm_and_messages(self):
        ha, hb = self.friends("bea", "cal")
        self.assertEqual(self.c.post("/api/chat/keys", json={"enc": "x"}, headers=ha).status_code, 400)
        self.assertEqual(self.c.post("/api/chat/keys", json=fake_keys("A"), headers=ha).status_code, 200)
        self.assertEqual(self.c.post("/api/chat/keys", json=fake_keys("B"), headers=ha).status_code, 409)   # needs reset=true
        self.c.post("/api/chat/keys", json=fake_keys("C"), headers=hb)
        keys = self.c.get("/api/chat/keys?users=bea,cal,nobody", headers=ha).get_json()["keys"]
        self.assertEqual(keys["bea"]["enc"], "A" * 87)
        self.assertIsNone(keys["nobody"])
        conv = self.c.post("/api/chat/dm", json={"username": "cal"}, headers=ha).get_json()
        self.assertEqual(self.c.post("/api/chat/dm", json={"username": "bea"}, headers=hb).get_json()["id"], conv["id"])
        cid = conv["id"]
        msg = dict(sealed(), id="m" * 20, v=1, sig=b64(86))
        self.assertEqual(self.c.post(f"/api/chat/{cid}/messages", json=msg, headers=ha).status_code, 409)   # no key yet
        key = {"v": 1, "conv": cid, "by": "bea", "ts": 1, "ev": 0, "members": ["bea", "cal"], "sig": b64(86),
               "wraps": {m: dict(sealed(), e=b64(87)) for m in ("bea", "cal")}, "fps": {m: "a" * 64 for m in ("bea", "cal")}}
        self.assertEqual(self.c.post(f"/api/chat/{cid}/keys", json={"key": dict(key, members=["bea"])}, headers=ha).status_code, 409)
        self.assertEqual(self.c.post(f"/api/chat/{cid}/keys", json={"key": key}, headers=ha).status_code, 200)
        sent = self.c.post(f"/api/chat/{cid}/messages", json=msg, headers=ha).get_json()["message"]
        self.assertEqual(sent["sender"], "bea")
        self.assertEqual(self.c.get("/api/social/pulse", headers=hb).get_json()["unread"], 1)
        got = self.c.get(f"/api/chat/{cid}/messages", headers=hb).get_json()["messages"]
        self.assertEqual(got[0]["ct"], msg["ct"])
        self.c.post(f"/api/chat/{cid}/read", json={"seq": sent["seq"]}, headers=hb)
        self.assertEqual(self.c.get("/api/social/pulse", headers=hb).get_json()["unread"], 0)
        self.assertEqual(self.c.delete(f"/api/chat/{cid}/messages/{msg['id']}", headers=hb).status_code, 403)
        self.assertEqual(self.c.delete(f"/api/chat/{cid}/messages/{msg['id']}", headers=ha).status_code, 200)
        self.assertTrue(self.c.get(f"/api/chat/{cid}/messages", headers=hb).get_json()["messages"][0]["deleted"])
        self.assertEqual(self.c.get(f"/api/chat/{cid}/messages", headers=self.user("dee")).status_code, 404)
        self.assertEqual(self.c.post("/api/chat/dm", json={"username": "dee"}, headers=ha).status_code, 403)   # not friends
        self.c.post("/api/social/friends/block", json={"username": "bea"}, headers=hb)
        self.assertEqual(self.c.post(f"/api/chat/{cid}/messages", json=dict(msg, id="n" * 20), headers=ha).status_code, 403)

    def test_groups_and_account_removal(self):
        ha, hb = self.friends("eve", "fay")
        _, hc = self.friends("eve", "gus")
        self.friends("eve", "hal")
        ev = {"t": "create", "by": "eve", "n": 0, "prev": "", "ts": 1, "sig": b64(86), "conv": "gr_" + "G" * 22, "members": ["eve", "fay", "gus"]}
        self.assertEqual(self.c.post("/api/chat/groups", json={"event": dict(ev, members=["eve", "fay", "zzz"])}, headers=ha).status_code, 403)
        conv = self.c.post("/api/chat/groups", json={"event": ev}, headers=ha).get_json()
        cid = conv["id"]
        event = lambda h, **e: self.c.post(f"/api/chat/{cid}/events", json={"event": dict({"prev": b64(43), "ts": 2, "sig": b64(86), "conv": cid}, **e)}, headers=h)
        self.assertEqual(event(hb, t="remove", by="fay", n=1, user="gus").status_code, 403)   # only the admin
        self.assertEqual(event(ha, t="add", by="eve", n=1, user="hal").get_json()["members"], ["eve", "fay", "gus", "hal"])
        self.assertEqual(event(ha, t="add", by="eve", n=1, user="hal").status_code, 409)       # stale event number
        self.assertTrue(event(hc, t="leave", by="gus", n=2).get_json()["left"])
        admin = self.admin()
        admin.post("/api/admin/v2/users/eve/delete")
        c = self.c.get(f"/api/chat/{cid}", headers=hb).get_json()
        self.assertEqual(c["members"], ["fay", "hal"])
        self.assertEqual(c["events"][-1]["t"], "gone")
        self.assertEqual(self.c.get("/api/social/me", headers=hb).get_json()["friends"], [])

    def test_linking_a_device(self):
        h = self.user("ida")
        self.c.post("/api/chat/keys", json=fake_keys("A"), headers=h)
        lid = self.c.post("/api/chat/link", json={"pub": b64(87)}, headers=h).get_json()["id"]
        self.assertEqual(self.c.get("/api/social/pulse", headers=h).get_json()["links"], 1)
        self.assertEqual(self.c.get("/api/chat/links", headers=h).get_json()["links"][0]["id"], lid)
        self.assertEqual(self.c.post(f"/api/chat/link/{lid}/approve", json={"x": b64(87), "blob": sealed()}, headers=self.user("jo")).status_code, 404)
        self.c.post(f"/api/chat/link/{lid}/approve", json={"x": b64(87), "blob": sealed()}, headers=h)
        self.assertEqual(self.c.get(f"/api/chat/link/{lid}", headers=h).get_json()["state"], "approved")

    def test_turned_off(self):
        h = self.user("kim")
        self.settings(feature_chat=False)
        try:
            self.assertEqual(self.c.get("/api/chat/conversations", headers=h).status_code, 403)
            self.assertEqual(self.c.get("/api/social/me", headers=h).status_code, 200)
        finally: self.settings(feature_chat=True)


class TestLibrarySharing(Social):
    """The test server shares its library with itself over real HTTP."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from werkzeug.serving import make_server
        import threading
        cls.httpd = make_server("127.0.0.1", 0, server.app, threaded=True)
        cls.port = cls.httpd.server_port
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def test_share_connect_play_and_stop(self):
        admin = self.admin()
        url = f"http://127.0.0.1:{self.port}"
        self.settings(public_url=url)
        try:
            made = admin.post("/api/admin/v2/federation/shares", json={"label": "Friend's server"}).get_json()
            self.assertTrue(made["key"].startswith("axs_"))
            self.assertEqual(admin.post("/api/admin/v2/federation/remotes", json={"url": url, "key": "axs_" + "x" * 40}).status_code, 400)
            r = admin.post("/api/admin/v2/federation/remotes", json={"code": made["code"]}).get_json()
            rid = r["view"]["remotes"][0]["id"]
            server.fed_sync(rid, force=True)
            shared = [t["rel_path"] for a in server.cached_prebuilt_tree for al in a["albums"] for t in al["tracks"] if t["rel_path"].startswith("@")]
            self.assertEqual(len(shared), len(server.library_cache_data))
            rel = next(x for x in shared if x.endswith("01 - Opening.flac"))
            song = self.c.get("/api/stream_path", query_string={"path": rel}, headers={"Range": "bytes=0-99"})
            self.assertEqual(song.status_code, 206)
            self.assertEqual(song.data[:4], b"fLaC")
            self.assertEqual(len(song.data), 100)
            song.close()
            self.assertIn(rel, [e[0] for e in server.fed_library_entries()])
            self.assertEqual(server._track_meta(rel)["title"], "Opening")
            # Shared songs never get public share pages.
            self.assertNotIn(rel, {v["t"]["rel_path"] for v in server.share_index()["track"].values()})
            view = admin.get("/api/admin/v2/federation").get_json()
            self.assertEqual(view["shares"][0]["peer_url"], url)
            admin.delete(f"/api/admin/v2/federation/shares/{view['shares'][0]['id']}")
            server.fed_sync(rid)
            self.assertEqual(admin.get("/api/admin/v2/federation").get_json()["remotes"][0]["status"], "revoked")
            self.assertFalse([1 for a in server.cached_prebuilt_tree for al in a["albums"] for t in al["tracks"] if t["rel_path"].startswith("@")])
            admin.delete(f"/api/admin/v2/federation/remotes/{rid}")
        finally:
            self.settings(public_url="")

    def test_share_back_offer(self):
        admin = self.admin()
        url = f"http://127.0.0.1:{self.port}"
        self.settings(public_url=url)
        try:
            made = admin.post("/api/admin/v2/federation/shares", json={"label": "Both ways"}).get_json()
            r = admin.post("/api/admin/v2/federation/remotes", json={"url": url, "key": made["key"], "share_back": True}).get_json()
            self.assertIn("offer", r["message"])
            view = admin.get("/api/admin/v2/federation").get_json()
            # The other side (here, the same server) already has the connection, so the offer is recorded as known.
            self.assertEqual(len(view["remotes"]), 1)
            for x in view["remotes"]: admin.delete(f"/api/admin/v2/federation/remotes/{x['id']}")
            for x in admin.get("/api/admin/v2/federation").get_json()["shares"]: admin.delete(f"/api/admin/v2/federation/shares/{x['id']}")
        finally:
            self.settings(public_url="")

    def test_federation_needs_a_key(self):
        self.assertEqual(self.c.get("/api/federation/library").status_code, 401)
        self.assertEqual(self.c.get("/api/federation/library", headers={"Authorization": "Bearer axs_nope"}).status_code, 401)


class TestDiscord(Social):
    def fake_discord(self, uid="123456789012345678", username="Night.Owl", name="Night Owl"):
        def fake(url, data=None, headers=None, timeout=10):
            if url.endswith("/oauth2/token"): return {"access_token": "at", "token_type": "Bearer"}
            if url.endswith("/users/@me"): return {"id": uid, "username": username, "global_name": name, "avatar": None}
            return {}
        server._http_json, self._orig = fake, server._http_json

    def tearDown(self):
        if hasattr(self, "_orig"): server._http_json = self._orig

    def sign_in(self, c, link=False):
        r = c.get("/auth/discord" + ("?link=1" if link else ""))
        self.assertEqual(r.status_code, 302, r.data[:200])
        self.assertIn("discord.com/oauth2/authorize", r.headers["Location"])
        state = urllib.parse.parse_qs(urllib.parse.urlparse(r.headers["Location"]).query)["state"][0]
        return c.get("/auth/discord/callback", query_string={"code": "abc", "state": state})

    def test_sign_up_link_and_unlink(self):
        c = server.app.test_client()
        self.assertIn("discord=unavailable", c.get("/auth/discord").headers["Location"])
        self.settings(discord_login=True, discord_client_id="123456789012345678", discord_client_secret="s3cret", registration="open")
        try:
            self.fake_discord()
            loc = self.sign_in(c).headers["Location"]
            code = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query)["login"][0]
            d = c.post("/api/auth/exchange", json={"code": code}).get_json()
            self.assertEqual(d["username"], "night.owl")
            self.assertEqual(d["display_name"], "Night Owl")
            self.assertEqual(c.post("/api/auth/exchange", json={"code": code}).status_code, 400)   # single use
            h = {"X-Auth-Token": d["token"]}
            sync = c.get("/api/user/sync", headers=h).get_json()
            self.assertFalse(sync["password_login"])
            self.assertEqual(sync["discord"]["username"], "Night.Owl")
            self.assertEqual(c.post("/api/user/discord/unlink", headers=h).status_code, 400)
            self.assertEqual(c.post("/api/user/change_password", json={"new_password": "long-password-9"}, headers=h).status_code, 200)
            self.assertEqual(c.post("/api/user/discord/unlink", headers=h).status_code, 200)
            # Linking it to another account, then signing in with Discord lands in that account.
            self.register("pia")
            c2 = server.app.test_client()
            c2.post("/api/auth/login", json={"username": "pia", "password": "long-password-1"})
            self.assertIn("discord=linked", self.sign_in(c2, link=True).headers["Location"])
            loc = self.sign_in(server.app.test_client()).headers["Location"]
            code = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query)["login"][0]
            self.assertEqual(server.app.test_client().post("/api/auth/exchange", json={"code": code}).get_json()["username"], "pia")
        finally:
            self.settings(discord_login=False, discord_client_id="", discord_client_secret="", registration="open")

    def test_redirect_follows_the_page_address(self):
        """Behind a proxy that doesn't pass on the host, the sign-in page's address is what Discord must send people back to."""
        self.settings(discord_login=True, discord_client_id="123456789012345678", discord_client_secret="s3cret", registration="open")
        try:
            sent = []
            def fake(url, data=None, headers=None, timeout=10):
                if url.endswith("/oauth2/token"):
                    sent.append(urllib.parse.parse_qs(data.decode() if isinstance(data, bytes) else urllib.parse.urlencode(data))["redirect_uri"][0])
                    return {"access_token": "at"}
                if url.endswith("/users/@me"): return {"id": "423456789012345678", "username": "proxied"}
                return {}
            server._http_json, self._orig = fake, server._http_json
            c = server.app.test_client()
            r = c.get("/auth/discord", query_string={"o": "https://music.example.com"})
            q = urllib.parse.parse_qs(urllib.parse.urlparse(r.headers["Location"]).query)
            self.assertEqual(q["redirect_uri"], ["https://music.example.com/auth/discord/callback"])
            c.get("/auth/discord/callback", query_string={"code": "abc", "state": q["state"][0]})
            self.assertEqual(sent, ["https://music.example.com/auth/discord/callback"])   # the same one, for the token
            for bad in ("javascript:alert(1)", "https://evil.example.com/x?y", ""):
                r = c.get("/auth/discord", query_string={"o": bad})
                q = urllib.parse.parse_qs(urllib.parse.urlparse(r.headers["Location"]).query)
                self.assertEqual(q["redirect_uri"], ["http://localhost/auth/discord/callback"])
            d = self.admin().get("/api/admin/v2/discord").get_json()
            self.assertEqual((d["server_sees"], d["redirect_path"]), ("http://localhost", "/auth/discord/callback"))
        finally:
            self.settings(discord_login=False, discord_client_id="", discord_client_secret="", registration="open")

    def test_invite_only_and_closed(self):
        self.settings(discord_login=True, discord_client_id="123456789012345678", discord_client_secret="s3cret", registration="invite")
        try:
            self.fake_discord(uid="223456789012345678", username="guest")
            c = server.app.test_client()
            self.assertIn("discord=invite", self.sign_in(c).headers["Location"])
            self.assertEqual(c.post("/api/auth/discord/finish", json={"invite_code": "NOPE"}).status_code, 403)
            code = self.admin().post("/api/admin/v2/invites", json={"max_uses": 1}).get_json()["invites"][0]["code"]
            self.assertEqual(c.post("/api/auth/discord/finish", json={"invite_code": code}).get_json()["username"], "guest")
            self.settings(registration="closed")
            self.fake_discord(uid="323456789012345678", username="stranger")
            self.assertIn("discord=no-account", self.sign_in(server.app.test_client()).headers["Location"])
        finally:
            self.settings(discord_login=False, discord_client_id="", discord_client_secret="", registration="open")


class TestDiscordStatus(Social):
    def test_helper_uses_the_page_address(self):
        self.settings(discord_client_id="123456789012345678", discord_presence=True)
        try:
            h = self.user("ada")
            made = self.c.post("/api/user/presence", headers=dict(h, Origin="https://music.example.com")).get_json()
            self.assertIn("SERVER = 'https://music.example.com'", made["script"])
            self.settings(public_url="https://tunes.example.org/")
            made = self.c.post("/api/user/presence", headers=dict(h, Origin="https://music.example.com")).get_json()
            self.assertIn("SERVER = 'https://tunes.example.org'", made["script"])
        finally:
            self.settings(discord_client_id="", public_url="")

    def test_helper_sets_itself_up(self):
        """Opened once, the helper installs itself, runs in the background, starts at sign-in, and can be removed."""
        import socket
        from werkzeug.serving import make_server
        self.settings(discord_client_id="123456789012345678", discord_presence=True)
        srv = make_server("127.0.0.1", 0, server.app, threaded=True)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        home = TMP / "helper-home"
        env = dict(os.environ, HOME=str(home), XDG_DATA_HOME=str(home / "data"), XDG_CONFIG_HOME=str(home / "config"), PATH="/usr/local/bin:/usr/bin:/bin")
        data, autostart = home / "data" / "Axdio", home / "config" / "autostart" / "axdio-discord.desktop"
        def running():
            try: socket.create_connection(("127.0.0.1", 47823), timeout=1).close(); return True
            except OSError: return False
        def wait(cond, secs=20):
            for _ in range(secs * 10):
                if cond(): return True
                time.sleep(0.1)
            return False
        def helper(h):
            made = self.c.post("/api/user/presence", headers=h).get_json()
            key = re.search(r"KEY = '(axp_[^']+)'", made["script"]).group(1)
            f = home / "Downloads" / "axdio-discord.py"
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(server.presence_helper(f"http://127.0.0.1:{srv.server_port}", key))
            return f
        try:
            h = self.user("bo")
            f = helper(h)
            out = subprocess.run([sys.executable, str(f)], env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
            self.assertIn("All set", out.stdout, out.stdout + out.stderr)
            self.assertTrue((data / "axdio-discord.py").exists())
            self.assertIn("--background", autostart.read_text())
            self.assertTrue(wait(running), "the background copy didn't start")
            self.assertTrue(wait(lambda: "Showing what you play" in (data / "axdio-discord.log").read_text() if (data / "axdio-discord.log").exists() else False))
            # Opening it again replaces the running copy instead of starting a second one.
            out = subprocess.run([sys.executable, str(f)], env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
            self.assertIn("Replaced the copy that was already running", out.stdout)
            self.assertTrue(wait(running))
            out = subprocess.run([sys.executable, str(data / "axdio-discord.py"), "--uninstall"], env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
            self.assertIn("Removed", out.stdout)
            self.assertTrue(wait(lambda: not running()))
            self.assertFalse(autostart.exists() or (data / "axdio-discord.py").exists())

            # Turned off in Settings: the helper removes itself when it next checks in.
            f = helper(h)
            subprocess.run([sys.executable, str(f)], env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
            self.assertTrue(autostart.exists())
            self.assertTrue(wait(running))
            self.assertEqual(self.c.delete("/api/user/presence", headers=h).status_code, 200)
            subprocess.run([sys.executable, str(data / "axdio-discord.py"), "--stop"], env=env, capture_output=True, timeout=30)
            subprocess.Popen([sys.executable, str(data / "axdio-discord.py"), "--background"], env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).wait(timeout=60)   # as at the next sign-in
            self.assertFalse(autostart.exists() or (data / "axdio-discord.py").exists())
            self.assertFalse(running())
        finally:
            if running():
                with socket.create_connection(("127.0.0.1", 47823), timeout=2) as c: c.sendall(b"axdio-stop")
            srv.shutdown()
            self.settings(discord_client_id="")

    def test_helper_and_feed(self):
        self.settings(discord_client_id="123456789012345678", discord_presence=True)
        try:
            h = self.user("rex")
            made = self.c.post("/api/user/presence", headers=h).get_json()
            compile(made["script"], "axdio-discord.py", "exec")
            key = re.search(r"KEY = '(axp_[^']+)'", made["script"]).group(1)
            feed = lambda: self.c.get("/api/presence", headers={"Authorization": "Bearer " + key})
            self.assertEqual(feed().get_json()["activity"], None)
            rel = self.rel("Opening")
            c = server.app.test_client()
            c.post("/api/auth/login", json={"username": "rex", "password": "long-password-1"})
            c.post("/api/player/now_playing", json={"src": "/api/stream_path?path=" + urllib.parse.quote(rel), "status": "STREAMING", "pos": 3})
            act = feed().get_json()["activity"]
            self.assertEqual((act["details"], act["state"], act["type"]), ("Opening", "Test Artist", 2))
            self.assertEqual(act["timestamps"]["end"] - act["timestamps"]["start"], 12)
            self.assertIn("/track/", act["assets"]["large_image"])
            c.post("/api/player/now_playing", json={"src": "/api/stream_path?path=" + urllib.parse.quote(rel), "status": "PAUSED", "pos": 5})
            self.assertIsNone(feed().get_json()["activity"])
            self.c.delete("/api/user/presence", headers=h)
            self.assertEqual(feed().status_code, 401)
        finally:
            self.settings(discord_client_id="")

    def test_helper_talks_to_discord(self):
        """The helper's Discord connection against a stand-in for the Discord app's local socket."""
        import socket as sk, struct, threading
        ns = {"__name__": "helper"}
        exec(server.presence_helper("https://music.example.com", "axp_test"), ns)
        run = TMP / "ipc"; run.mkdir(exist_ok=True)
        path = str(run / "discord-ipc-0")
        got = []
        srv = sk.socket(sk.AF_UNIX, sk.SOCK_STREAM); srv.bind(path); srv.listen(1)
        def fake_discord():
            conn, _ = srv.accept()
            def frame():
                op, n = struct.unpack("<II", conn.recv(8)); return op, json.loads(conn.recv(n))
            def send(op, d): b = json.dumps(d).encode(); conn.sendall(struct.pack("<II", op, len(b)) + b)
            got.append(frame()); send(1, {"cmd": "DISPATCH", "evt": "READY"})
            got.append(frame()); send(1, {"cmd": "SET_ACTIVITY", "evt": None, "data": {}})
            conn.close()
        t = threading.Thread(target=fake_discord, daemon=True); t.start()
        old = os.environ.get("XDG_RUNTIME_DIR"); os.environ["XDG_RUNTIME_DIR"] = str(run)
        try:
            d = ns["Discord"]()
            self.assertTrue(d.connect("123456789012345678"))
            d.set_activity({"type": 2, "details": "Opening", "state": "Test Artist"})
            d.close()
        finally:
            if old is None: os.environ.pop("XDG_RUNTIME_DIR", None)
            else: os.environ["XDG_RUNTIME_DIR"] = old
            t.join(5); srv.close()
        self.assertEqual(got[0], (0, {"v": 1, "client_id": "123456789012345678"}))
        self.assertEqual(got[1][0], 1)
        self.assertEqual(got[1][1]["cmd"], "SET_ACTIVITY")
        self.assertEqual(got[1][1]["args"]["activity"]["details"], "Opening")


def make_wheel(folder, name, version, files, requires=(), scripts=None):
    """A tiny wheel standing in for a real plugin, so installing one needs no network."""
    import base64 as b64, zipfile
    mod = name.replace("-", "_")
    info = f"{mod}-{version}.dist-info"
    files = dict(files)
    files[f"{info}/METADATA"] = "Metadata-Version: 2.1\nName: %s\nVersion: %s\n%s" % (name, version, "".join(f"Requires-Dist: {r}\n" for r in requires))
    files[f"{info}/WHEEL"] = "Wheel-Version: 1.0\nGenerator: axdio-tests\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
    if scripts: files[f"{info}/entry_points.txt"] = "[console_scripts]\n" + "".join(f"{k} = {v}\n" for k, v in scripts.items())
    record = []
    for path, text in files.items():
        data = text.encode()
        digest = b64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        record.append(f"{path},sha256={digest},{len(data)}")
    record.append(f"{info}/RECORD,,")
    files[f"{info}/RECORD"] = "\n".join(record) + "\n"
    whl = Path(folder) / f"{mod}-{version}-py3-none-any.whl"
    with zipfile.ZipFile(whl, "w") as z:
        for path, text in files.items(): z.writestr(path, text)
    return whl

FAKE_YTDLP = """from .version import __version__
class YoutubeDL:
    def __init__(self, opts=None): self.opts = opts or {}
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def extract_info(self, url, download=False):
        return {"entries": [{"id": "abcdefghijk", "title": "Found with " + __version__, "duration": 200}]}
"""
FAKE_SPOTDL = """import json, sys
def main():
    a = sys.argv[1:]
    out = a[a.index("--save-file") + 1]
    json.dump([{"name": "Opening", "artists": ["Test Artist"], "url": a[1]}], open(out, "w"))
"""


class TestPlugins(Base):
    """yt-dlp and spotDL aren't in the image: an admin installs, updates and removes them."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.wheels = TMP / "wheels"
        cls.wheels.mkdir(exist_ok=True)
        make_wheel(cls.wheels, "yt-dlp", "1.0.0", {"yt_dlp/__init__.py": FAKE_YTDLP, "yt_dlp/version.py": "__version__ = '1.0.0'\n"})
        make_wheel(cls.wheels, "spotdl", "4.0.0", {"spotdl/__init__.py": FAKE_SPOTDL}, requires=["yt-dlp"], scripts={"spotdl": "spotdl:main"})
        cls.pip_args, server.PLUGIN_PIP_ARGS = server.PLUGIN_PIP_ARGS, ["--no-index", "--find-links", str(cls.wheels)]
        cls.latest, server.pypi_latest = server.pypi_latest, lambda pkg: {"yt-dlp": "2.0.0", "spotdl": "4.0.0"}[pkg]

    @classmethod
    def tearDownClass(cls):
        server.PLUGIN_PIP_ARGS, server.pypi_latest = cls.pip_args, cls.latest

    def run_job(self, a, pid, action):
        r = a.post(f"/api/admin/v2/plugins/{pid}", json={"action": action})
        self.assertEqual(r.status_code, 200, r.get_json())
        for _ in range(600):
            v = a.get("/api/admin/v2/plugins").get_json()
            if v["job"]["state"] != "running": break
            time.sleep(0.2)
        self.assertEqual(v["job"]["state"], "done", v["job"])
        return {p["id"]: p for p in v["plugins"]}

    def test_install_update_remove(self):
        a = self.admin()
        v = {p["id"]: p for p in a.get("/api/admin/v2/plugins").get_json()["plugins"]}
        self.assertIsNone(v["yt-dlp"]["installed"])
        # Without yt-dlp the downloader says what's missing, and nothing tries to use it.
        self.settings(downloader_enabled=True)
        r = a.post("/api/admin/download", json={"url": "https://www.youtube.com/watch?v=abcdefghijk"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("yt-dlp", r.get_json()["error"])
        with self.assertRaises(server.PluginMissing): server.youtube_search("anything")

        v = self.run_job(a, "yt-dlp", "install")
        self.assertEqual(v["yt-dlp"]["installed"], "1.0.0")
        self.assertEqual(server.youtube_search("anything")[0]["title"], "Found with 1.0.0")

        # A newer version: found, installed, and used without restarting.
        make_wheel(self.wheels, "yt-dlp", "2.0.0", {"yt_dlp/__init__.py": FAKE_YTDLP, "yt_dlp/version.py": "__version__ = '2.0.0'\n"})
        v = {p["id"]: p for p in a.post("/api/admin/v2/plugins/check").get_json()["plugins"]}
        self.assertTrue(v["yt-dlp"]["update"])
        v = self.run_job(a, "yt-dlp", "update")
        self.assertEqual(v["yt-dlp"]["installed"], "2.0.0")
        self.assertFalse(v["yt-dlp"]["update"])
        self.assertEqual(server.youtube_search("anything")[0]["title"], "Found with 2.0.0")

        v = {p["id"]: p for p in a.post("/api/admin/v2/plugins/yt-dlp", json={"auto_update": True}).get_json()["plugins"]}
        self.assertTrue(v["yt-dlp"]["auto_update"])
        self.assertEqual(a.post("/api/admin/v2/plugins/spotdl", json={"auto_update": True}).status_code, 400)   # not installed

        # spotDL runs as its own program from the plugin environment.
        v = self.run_job(a, "spotdl", "install")
        self.assertEqual(v["spotdl"]["installed"], "4.0.0")
        self.assertEqual(v["yt-dlp"]["needed_by"], ["spotDL"])
        out = TMP / "spotdl-save.json"
        subprocess.run([server.plugin_command("spotdl"), "save", "https://example.com/list", "--save-file", str(out)], check=True, timeout=60)
        self.assertEqual(json.loads(out.read_text())[0]["name"], "Opening")
        r = a.post("/api/admin/v2/plugins/yt-dlp", json={"action": "remove"})
        self.assertEqual(r.status_code, 409)
        self.assertIn("spotDL needs yt-dlp", r.get_json()["error"])

        # Removing spotDL leaves yt-dlp (with its setting); removing that too leaves nothing behind.
        v = self.run_job(a, "spotdl", "remove")
        self.assertIsNone(v["spotdl"]["installed"])
        self.assertIsNone(server.plugin_command("spotdl"))
        self.assertEqual(v["yt-dlp"]["installed"], "2.0.0")
        self.assertTrue(v["yt-dlp"]["auto_update"])
        self.assertEqual(server.youtube_search("anything")[0]["title"], "Found with 2.0.0")
        v = self.run_job(a, "yt-dlp", "remove")
        self.assertIsNone(v["yt-dlp"]["installed"])
        self.assertFalse(server.PLUGIN_ENV.exists())
        with self.assertRaises(server.PluginMissing): server.youtube_search("anything")
        self.assertEqual(a.get("/api/admin/v2/system").get_json()["yt_dlp"], "")


def tearDownModule():
    shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
